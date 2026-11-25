use ignore::{WalkBuilder, WalkState};
use lody_ports::{PortError, PortErrorKind, PortResult, ScannedFileEntry, ScannedFileIndex};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;

pub const CODE_COLLAB_MAX_INDEX_ENTRIES: usize = 1_000;
pub const CODE_COLLAB_MAX_INDEX_BYTES: usize = 100 * 1024;

pub const CODE_COLLAB_IGNORED_DIRECTORY_NAMES: [&str; 7] = [
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    ".pnpm-store",
];

pub fn is_ignored_directory_name(name: &str) -> bool {
    CODE_COLLAB_IGNORED_DIRECTORY_NAMES.contains(&name)
}

fn normalize_relative_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.contains('\0') || raw.contains('\u{FFFD}') {
        return None;
    }
    let unified = raw.replace('\\', "/");
    let trimmed = unified.trim_matches('/');
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed.starts_with("../") {
        return None;
    }
    Some(trimmed.to_string())
}

fn estimate_entry_json_bytes(entry: &ScannedFileEntry) -> usize {
    entry.relative_path.len() + if entry.is_directory { 38 } else { 34 }
}

fn collect_git_tracked_files(root: &Path) -> Vec<String> {
    let Ok(out) = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    out.stdout
        .split(|b| *b == 0)
        .filter(|slice| !slice.is_empty())
        .filter_map(|slice| {
            let text = String::from_utf8_lossy(slice);
            if text.contains('\u{FFFD}') {
                None
            } else {
                normalize_relative_path(&text)
            }
        })
        .collect()
}

pub fn scan_directory_parallel(
    root: &Path,
    max_entries: usize,
    max_bytes: usize,
) -> PortResult<ScannedFileIndex> {
    if !root.exists() {
        return Err(PortError::new(
            PortErrorKind::NotFound,
            format!("scan root does not exist: {:?}", root),
        ));
    }
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

    let collected: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());
    let root_for_filter = canonical_root.clone();

    let mut builder = WalkBuilder::new(&canonical_root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(move |entry| {
            if entry.path() == root_for_filter {
                return true;
            }
            let file_name = entry.file_name().to_string_lossy();
            if file_name.contains('\u{FFFD}') {
                return false;
            }
            if entry.file_type().is_some_and(|ft| ft.is_dir())
                && is_ignored_directory_name(&file_name)
            {
                return false;
            }
            true
        });

    let root_ref = &canonical_root;
    let collected_ref = &collected;
    builder.build_parallel().run(|| {
        Box::new(move |entry_res| {
            let Ok(entry) = entry_res else {
                return WalkState::Continue;
            };
            let path = entry.path();
            if path == root_ref {
                return WalkState::Continue;
            }
            let Ok(rel) = path.strip_prefix(root_ref) else {
                return WalkState::Continue;
            };
            let rel_lossy = rel.to_string_lossy();
            if rel_lossy.contains('\u{FFFD}') {
                return WalkState::Skip;
            }
            let Some(normalized) = normalize_relative_path(&rel_lossy) else {
                return WalkState::Continue;
            };
            let is_dir = entry.file_type().is_some_and(|ft| ft.is_dir());
            if let Ok(mut guard) = collected_ref.lock() {
                guard.insert(normalized, is_dir);
            }
            WalkState::Continue
        })
    });

    let mut map = collected
        .into_inner()
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

    for tracked in collect_git_tracked_files(&canonical_root) {
        let mut prefix = String::new();
        let parts: Vec<&str> = tracked.split('/').collect();
        for dir_part in parts.iter().take(parts.len().saturating_sub(1)) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(dir_part);
            map.entry(prefix.clone()).or_insert(true);
        }
        map.insert(tracked, false);
    }

    let mut entries = Vec::with_capacity(map.len().min(max_entries));
    let mut estimated_bytes: usize = 2;
    let mut truncated = false;

    for (relative_path, is_directory) in map {
        let candidate = ScannedFileEntry {
            relative_path,
            is_directory,
        };
        let cost = estimate_entry_json_bytes(&candidate);
        if entries.len() >= max_entries || estimated_bytes + cost > max_bytes {
            truncated = true;
            break;
        }
        estimated_bytes += cost;
        entries.push(candidate);
    }

    Ok(ScannedFileIndex {
        entries,
        truncated,
        estimated_bytes,
    })
}
