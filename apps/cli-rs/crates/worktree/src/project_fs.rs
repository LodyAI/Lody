use crate::git_meta::parse_github_repo_full_name;
use crate::scan::collect_project_file_paths;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use lody_ports::{
    BrowseDirectoryEntry, BrowseDirectoryPage, BrowseDirectoryQuery, BrowseEntryHints,
    BrowseRootsInfo, CheckoutBranchOutcome, DirectoryChildEntry, DirectoryListPage,
    FileSearchResult, LocalProjectId, PortError, PortErrorKind, PortResult, ProjectFileReadResult,
    ProjectSkillEntry, ProjectSkillGroupEntry, ProjectSkillsListing, SessionId,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

pub const DEFAULT_PROJECT_MAX_FILES: usize = 80_000;
pub const HARD_PROJECT_MAX_FILES: usize = 200_000;
pub const DEFAULT_LIST_DIR_LIMIT: usize = 1_000;
pub const HARD_LIST_DIR_LIMIT: usize = 10_000;
pub const DEFAULT_BROWSE_DIR_LIMIT: usize = 500;
pub const HARD_BROWSE_DIR_LIMIT: usize = 5_000;
pub const DEFAULT_READ_FILE_MAX_BYTES: usize = 64 * 1024;
pub const HARD_READ_FILE_MAX_BYTES: usize = 5 * 1024 * 1024;
const SKILL_MD_MAX_BYTES: u64 = 256 * 1024;
const SKILL_DIR_MAX_CHILDREN: usize = 2_000;
const PROJECT_SKILLS_CONTENT_BUDGET_BYTES: usize = 2 * 1024 * 1024;
const PROJECT_SKILLS_MAX_COUNT: usize = 5_000;

const BINARY_IMAGE_EXTENSIONS: &[&str] = &[
    "png", "apng", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "ico", "cur", "avif",
];

const KNOWN_GLOBAL_SKILL_DIRS: &[&str] = &[
    "~/.adal/skills",
    "~/.agents/skills",
    "~/.aider-desk/skills",
    "~/.astrbot/data/skills",
    "~/.augment/skills",
    "~/.autohand/skills",
    "~/.bob/skills",
    "~/.claude/skills",
    "~/.cline/skills",
    "~/.codeartsdoer/skills",
    "~/.codebuddy/skills",
    "~/.codeium/windsurf/skills",
    "~/.codemaker/skills",
    "~/.codestudio/skills",
    "~/.commandcode/skills",
    "~/.config/agents/skills",
    "~/.config/crush/skills",
    "~/.config/devin/skills",
    "~/.config/goose/skills",
    "~/.config/opencode/skills",
    "~/.continue/skills",
    "~/.copilot/skills",
    "~/.cursor/skills",
    "~/.dsh/skills",
    "~/.factory/skills",
    "~/.firebender/skills",
    "~/.forge/skills",
    "~/.gemini/antigravity-cli/skills",
    "~/.gemini/config/skills",
    "~/.gemini/skills",
    "~/.grok/skills",
    "~/.hermes/skills",
    "~/.iflow/skills",
    "~/.inferencesh/skills",
    "~/.jazz/skills",
    "~/.junie/skills",
    "~/.kilo/skills",
    "~/.kilocode/skills",
    "~/.kimi-code/skills",
    "~/.kiro/skills",
    "~/.kode/skills",
    "~/.lingma/skills",
    "~/.mcpjam/skills",
    "~/.moxby/skills",
    "~/.mux/skills",
    "~/.neovate/skills",
    "~/.ona/skills",
    "~/.openclaw/skills",
    "~/.openhands/skills",
    "~/.pi/agent/skills",
    "~/.pochi/skills",
    "~/.qoder-cn/skills",
    "~/.qoder/skills",
    "~/.qwen/skills",
    "~/.reasonix/skills",
    "~/.roo/skills",
    "~/.rovodev/skills",
    "~/.snowflake/cortex/skills",
    "~/.tabnine/agent/skills",
    "~/.terramind/skills",
    "~/.tinycloud/skills",
    "~/.trae-cn/skills",
    "~/.trae/skills",
    "~/.vibe/skills",
    "~/.zencoder/skills",
];

const KNOWN_SYSTEM_SKILL_DIRS: &[&str] = &[
    "~/.codex/skills/.system",
    "~/.gemini/antigravity-cli/builtin/skills",
];

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn normalize_canonical_path_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if raw == "/" {
        return "/".to_string();
    }
    if cfg!(windows) && raw.len() == 3 && raw.ends_with(":\\") {
        return raw.into_owned();
    }
    raw.trim_end_matches(['/', '\\']).to_string()
}

pub fn prepare_project_root(root: &Path) -> PortResult<(LocalProjectId, String, PathBuf)> {
    let raw_str = root.to_string_lossy();
    if raw_str.trim().is_empty() || raw_str.contains('\0') {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Project path is required",
        ));
    }
    let canonical = fs::canonicalize(root).map_err(|_| {
        PortError::new(
            PortErrorKind::NotFound,
            "path_invalid: Local project path not found.",
        )
    })?;
    let meta = fs::metadata(&canonical).map_err(|_| {
        PortError::new(
            PortErrorKind::NotFound,
            "path_invalid: Selected path is not a directory",
        )
    })?;
    if !meta.is_dir() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Selected path is not a directory",
        ));
    }
    let normalized_str = normalize_canonical_path_string(&canonical);
    let hash = sha256_hex(normalized_str.as_bytes());
    let project_id = LocalProjectId(format!("local-project-{}", &hash[..24]));
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| normalized_str.clone());
    Ok((project_id, name, PathBuf::from(normalized_str)))
}

pub fn list_browse_roots(home_dir: &Path) -> PortResult<BrowseRootsInfo> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        return Err(PortError::new(
            PortErrorKind::Unavailable,
            "Unsupported local project browse platform",
        ));
    };

    let path_separator = if cfg!(windows) { "\\" } else { "/" };
    let canonical_home = fs::canonicalize(home_dir).unwrap_or_else(|_| home_dir.to_path_buf());
    let drives = if cfg!(windows) {
        let mut found = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", char::from(letter));
            if fs::metadata(&drive).is_ok() {
                found.push(drive);
            }
        }
        Some(found)
    } else {
        None
    };

    Ok(BrowseRootsInfo {
        platform: platform.to_string(),
        path_separator: path_separator.to_string(),
        home_dir: normalize_canonical_path_string(&canonical_home),
        drives,
    })
}

pub fn validate_directory_name(name: &str) -> PortResult<String> {
    let normalized = name.trim();
    if normalized.is_empty()
        || normalized != name
        || normalized == "."
        || normalized == ".."
        || normalized.chars().any(|c| (c as u32) < 32)
        || normalized.contains('/')
        || normalized.contains('\\')
        || Path::new(normalized).is_absolute()
    {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Folder name must be a single directory name.",
        ));
    }
    if cfg!(windows) {
        let stem = normalized
            .split('.')
            .next()
            .unwrap_or(normalized)
            .to_ascii_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "CONIN$"
                | "CONOUT$"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        );
        if reserved
            || normalized.contains(['<', '>', ':', '"', '|', '?', '*'])
            || normalized.ends_with(['.', ' '])
        {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "Folder name is not valid on this machine.",
            ));
        }
    }
    Ok(normalized.to_string())
}

pub fn create_directory(parent_path: &Path, name: &str) -> PortResult<PathBuf> {
    let directory_name = validate_directory_name(name)?;
    let parent_raw = parent_path.to_string_lossy();
    if !parent_path.is_absolute() || parent_raw.contains('\0') {
        return Err(PortError::new(
            PortErrorKind::NotFound,
            "path_invalid: Parent path must be absolute.",
        ));
    }

    let canonical_parent = match fs::canonicalize(parent_path) {
        Ok(p) => p,
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                format!(
                    "Permission denied creating folder in \"{}\".",
                    parent_path.display()
                ),
            ));
        }
        Err(_) => {
            return Err(PortError::new(
                PortErrorKind::NotFound,
                "path_invalid: The parent folder does not exist or is not a directory.",
            ));
        }
    };

    match fs::metadata(&canonical_parent) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Err(PortError::new(
                PortErrorKind::NotFound,
                "path_invalid: Parent path is not a directory.",
            ));
        }
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                format!(
                    "Permission denied creating folder in \"{}\".",
                    canonical_parent.display()
                ),
            ));
        }
        Err(_) => {
            return Err(PortError::new(
                PortErrorKind::NotFound,
                "path_invalid: The parent folder does not exist or is not a directory.",
            ));
        }
    }

    let target_path = canonical_parent.join(&directory_name);
    match fs::create_dir(&target_path) {
        Ok(()) => Ok(target_path),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Err(PortError::new(
            PortErrorKind::Conflict,
            format!("A file or folder named \"{directory_name}\" already exists."),
        )),
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Err(PortError::new(
            PortErrorKind::Forbidden,
            format!(
                "Permission denied creating folder in \"{}\".",
                canonical_parent.display()
            ),
        )),
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::InvalidInput
            ) =>
        {
            Err(PortError::new(
                PortErrorKind::NotFound,
                "path_invalid: The folder path is no longer available.",
            ))
        }
        Err(err) => Err(PortError::new(PortErrorKind::Internal, err.to_string())),
    }
}

pub fn browse_directory(
    home_dir: &Path,
    query: &BrowseDirectoryQuery,
) -> PortResult<BrowseDirectoryPage> {
    let requested = match &query.absolute_path {
        Some(p) if !p.as_os_str().is_empty() => p.clone(),
        _ => home_dir.to_path_buf(),
    };
    let req_str = requested.to_string_lossy();
    if req_str.contains('\0') || !requested.is_absolute() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Browse path must be absolute.",
        ));
    }

    let offset = match query.cursor.as_deref().map(str::trim) {
        None | Some("") => 0usize,
        Some(raw) if raw.bytes().all(|b| b.is_ascii_digit()) => {
            raw.parse::<usize>().map_err(|_| {
                PortError::new(PortErrorKind::InvalidInput, "Browse cursor is invalid.")
            })?
        }
        Some(_) => {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "Browse cursor is invalid.",
            ));
        }
    };

    let limit = if query.limit == 0 {
        DEFAULT_BROWSE_DIR_LIMIT
    } else {
        query.limit.clamp(1, HARD_BROWSE_DIR_LIMIT)
    };

    let dir_real = fs::canonicalize(&requested).map_err(|e| match e.kind() {
        io::ErrorKind::PermissionDenied => PortError::new(PortErrorKind::Forbidden, e.to_string()),
        _ => PortError::new(
            PortErrorKind::NotFound,
            "path_invalid: Browse path not found.",
        ),
    })?;
    let dir_meta = fs::metadata(&dir_real)
        .map_err(|e| PortError::new(PortErrorKind::NotFound, format!("path_invalid: {e}")))?;
    if !dir_meta.is_dir() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Browse path is not a directory.",
        ));
    }

    let mut registered_by_real: HashMap<PathBuf, String> = HashMap::new();
    for (project_id, proj_root) in &query.registered_projects {
        if let Ok(real_proj) = fs::canonicalize(proj_root) {
            registered_by_real.insert(real_proj, project_id.clone());
        }
    }

    let read_dir = fs::read_dir(&dir_real).map_err(|e| match e.kind() {
        io::ErrorKind::PermissionDenied => PortError::new(PortErrorKind::Forbidden, e.to_string()),
        _ => PortError::new(PortErrorKind::Internal, e.to_string()),
    })?;

    struct Candidate {
        name: String,
        abs_path: PathBuf,
        is_symlink: bool,
        hidden: bool,
    }

    let mut candidates = Vec::new();
    for entry_res in read_dir {
        let Ok(entry) = entry_res else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let hidden = name.starts_with('.');
        if hidden && !query.show_hidden {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let joined = dir_real.join(&name);
        if ft.is_dir() {
            candidates.push(Candidate {
                name,
                abs_path: joined,
                is_symlink: false,
                hidden,
            });
            continue;
        }
        if !ft.is_symlink() {
            continue;
        }
        let Ok(target_real) = fs::canonicalize(&joined) else {
            continue;
        };
        let Ok(target_meta) = fs::metadata(&target_real) else {
            continue;
        };
        if !target_meta.is_dir() {
            continue;
        }
        candidates.push(Candidate {
            name,
            abs_path: target_real,
            is_symlink: true,
            hidden,
        });
    }

    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    let total = candidates.len();
    let clamped_offset = offset.min(total);
    let end = (clamped_offset + limit).min(total);
    let mut entries = Vec::with_capacity(end.saturating_sub(clamped_offset));

    for cand in &candidates[clamped_offset..end] {
        let registered_project_id = registered_by_real.get(&cand.abs_path).cloned();
        let abs_str = normalize_canonical_path_string(&cand.abs_path);
        if fs::read_dir(&cand.abs_path).is_err() {
            entries.push(BrowseDirectoryEntry {
                name: cand.name.clone(),
                absolute_path: abs_str,
                is_symlink: cand.is_symlink,
                hidden: cand.hidden,
                hints: None,
                registered_project_id,
                error: Some("unreadable".to_string()),
            });
            continue;
        }
        let hints = cand
            .abs_path
            .join(".git")
            .exists()
            .then_some(BrowseEntryHints { git: Some(true) });
        entries.push(BrowseDirectoryEntry {
            name: cand.name.clone(),
            absolute_path: abs_str,
            is_symlink: cand.is_symlink,
            hidden: cand.hidden,
            hints,
            registered_project_id,
            error: None,
        });
    }

    let truncated = end < total;
    let next_cursor = truncated.then(|| end.to_string());
    let parent_path = dir_real
        .parent()
        .filter(|p| *p != dir_real)
        .map(normalize_canonical_path_string);

    Ok(BrowseDirectoryPage {
        path: normalize_canonical_path_string(&dir_real),
        parent_path,
        entries,
        truncated,
        next_cursor,
    })
}

fn normalize_project_relative_path(raw: &str) -> String {
    let unified = raw.replace('\\', "/");
    let mut parts = Vec::new();
    for seg in unified.split('/') {
        if seg.is_empty() {
            continue;
        }
        parts.push(seg);
    }
    parts.join("/")
}

fn has_blocked_git_segment(rel: &str) -> bool {
    rel.split('/').any(|s| s == ".git")
}

fn resolve_safe_lexical_subpath(
    root: &Path,
    relative_path: &str,
    allow_empty: bool,
) -> Option<PathBuf> {
    let trimmed = relative_path.trim();
    if trimmed.contains('\0') {
        return None;
    }
    let normalized = normalize_project_relative_path(trimmed);
    if normalized.is_empty() {
        return allow_empty.then(|| root.to_path_buf());
    }
    let rel_path = Path::new(&normalized);
    if rel_path.is_absolute() {
        return None;
    }
    let mut resolved = root.to_path_buf();
    let mut depth = 0usize;
    for comp in rel_path.components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(seg) => {
                resolved.push(seg);
                depth += 1;
            }
            Component::ParentDir => {
                if depth == 0 {
                    return None;
                }
                resolved.pop();
                depth -= 1;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if !allow_empty && depth == 0 {
        return None;
    }
    Some(resolved)
}

fn to_project_relative_string(canonical_root: &Path, canonical_target: &Path) -> Option<String> {
    let stripped = canonical_target.strip_prefix(canonical_root).ok()?;
    Some(normalize_project_relative_path(&stripped.to_string_lossy()))
}

struct SimpleGitignoreRule {
    negated: bool,
    anchored_or_slash: bool,
    directory_only: bool,
    pattern: String,
}

fn wildcard_matches(pattern: &str, text: &str) -> bool {
    let p_bytes = pattern.as_bytes();
    let t_bytes = text.as_bytes();
    let mut memo = vec![vec![None; t_bytes.len() + 1]; p_bytes.len() + 1];

    fn rec(p: &[u8], t: &[u8], pi: usize, ti: usize, memo: &mut [Vec<Option<bool>>]) -> bool {
        if let Some(ans) = memo[pi][ti] {
            return ans;
        }
        let ans = if pi == p.len() {
            ti == t.len()
        } else if p[pi] == b'*' {
            if pi + 1 < p.len() && p[pi + 1] == b'*' {
                rec(p, t, pi + 2, ti, memo) || (ti < t.len() && rec(p, t, pi, ti + 1, memo))
            } else {
                rec(p, t, pi + 1, ti, memo)
                    || (ti < t.len() && t[ti] != b'/' && rec(p, t, pi, ti + 1, memo))
            }
        } else if p[pi] == b'?' {
            ti < t.len() && t[ti] != b'/' && rec(p, t, pi + 1, ti + 1, memo)
        } else {
            ti < t.len() && p[pi] == t[ti] && rec(p, t, pi + 1, ti + 1, memo)
        };
        memo[pi][ti] = Some(ans);
        ans
    }

    rec(p_bytes, t_bytes, 0, 0, &mut memo)
}

fn load_root_gitignore_rules(canonical_root: &Path) -> Vec<SimpleGitignoreRule> {
    let Ok(content) = fs::read_to_string(canonical_root.join(".gitignore")) else {
        return Vec::new();
    };
    let mut rules = Vec::new();
    for raw_line in content.lines() {
        let mut line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let negated = if let Some(rest) = line.strip_prefix('!') {
            line = rest.trim();
            true
        } else {
            false
        };
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let anchored = line.starts_with('/');
        if anchored {
            line = line.trim_start_matches('/');
        }
        let directory_only = line.ends_with('/');
        if directory_only {
            line = line.trim_end_matches('/');
        }
        let normalized = normalize_project_relative_path(line);
        if normalized.is_empty() {
            continue;
        }
        let anchored_or_slash = anchored || normalized.contains('/');
        rules.push(SimpleGitignoreRule {
            negated,
            anchored_or_slash,
            directory_only,
            pattern: normalized,
        });
    }
    rules
}

fn is_excluded_by_rules(rel_path: &str, rules: &[SimpleGitignoreRule]) -> bool {
    let normalized = normalize_project_relative_path(rel_path);
    if normalized.is_empty() {
        return false;
    }
    if has_blocked_git_segment(&normalized) {
        return true;
    }
    let mut ignored = false;
    for rule in rules {
        let matched = if rule.anchored_or_slash {
            if rule.directory_only {
                wildcard_matches(&rule.pattern, &normalized)
                    || normalized
                        .char_indices()
                        .filter(|&(_, c)| c == '/')
                        .any(|(idx, _)| wildcard_matches(&rule.pattern, &normalized[..idx]))
            } else {
                wildcard_matches(&rule.pattern, &normalized)
            }
        } else if rule.directory_only {
            normalized
                .split('/')
                .any(|seg| wildcard_matches(&rule.pattern, seg))
        } else if let Some((_, tail)) = normalized.rsplit_once('/') {
            wildcard_matches(&rule.pattern, tail) || wildcard_matches(&rule.pattern, &normalized)
        } else {
            wildcard_matches(&rule.pattern, &normalized)
        };
        if matched {
            ignored = !rule.negated;
        }
    }
    ignored
}

fn list_files_from_git(canonical_root: &Path, max_files: usize) -> Option<FileSearchResult> {
    let tracked = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(canonical_root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !tracked.status.success() {
        return None;
    }
    let untracked = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(canonical_root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !untracked.status.success() {
        return None;
    }

    let mut deduped = BTreeSet::new();
    let mut truncated = false;
    for chunk in tracked
        .stdout
        .split(|b| *b == 0)
        .chain(untracked.stdout.split(|b| *b == 0))
    {
        if chunk.is_empty() {
            continue;
        }
        let Ok(raw) = std::str::from_utf8(chunk) else {
            continue;
        };
        let normalized = normalize_project_relative_path(raw);
        if normalized.is_empty() || has_blocked_git_segment(&normalized) {
            continue;
        }
        if deduped.contains(&normalized) {
            continue;
        }
        if deduped.len() >= max_files {
            truncated = true;
            break;
        }
        deduped.insert(normalized);
    }

    Some(FileSearchResult {
        paths: deduped.into_iter().collect(),
        truncated,
    })
}

pub fn list_project_files(root: &Path, max_files: usize) -> PortResult<FileSearchResult> {
    let (_, _, canonical_root) = prepare_project_root(root)?;
    let clamped_max = if max_files == 0 {
        DEFAULT_PROJECT_MAX_FILES
    } else {
        max_files.clamp(1, HARD_PROJECT_MAX_FILES)
    };
    if let Some(git_res) = list_files_from_git(&canonical_root, clamped_max) {
        return Ok(git_res);
    }
    let (paths, truncated) = collect_project_file_paths(&canonical_root, clamped_max)?;
    Ok(FileSearchResult { paths, truncated })
}

pub fn list_project_directory(
    root: &Path,
    relative_path: &str,
    limit: usize,
) -> PortResult<DirectoryListPage> {
    let (_, _, canonical_root) = prepare_project_root(root)?;
    let clamped_limit = if limit == 0 {
        DEFAULT_LIST_DIR_LIMIT
    } else {
        limit.clamp(1, HARD_LIST_DIR_LIMIT)
    };

    let Some(lexical_dir) = resolve_safe_lexical_subpath(&canonical_root, relative_path, true)
    else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Project directory path escapes project root.",
        ));
    };
    let requested_rel = normalize_project_relative_path(relative_path.trim());
    let dir_real = fs::canonicalize(&lexical_dir).map_err(|_| {
        PortError::new(PortErrorKind::NotFound, "Project directory path not found.")
    })?;
    let Some(resolved_dir_rel) = to_project_relative_string(&canonical_root, &dir_real) else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Project directory path escapes project root.",
        ));
    };

    let rules = load_root_gitignore_rules(&canonical_root);
    if is_excluded_by_rules(&requested_rel, &rules)
        || is_excluded_by_rules(&resolved_dir_rel, &rules)
    {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Project directory is not browsable.",
        ));
    }

    let dir_meta = fs::metadata(&dir_real)
        .map_err(|e| PortError::new(PortErrorKind::NotFound, e.to_string()))?;
    if !dir_meta.is_dir() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Project path is not a directory.",
        ));
    }

    let read_dir = fs::read_dir(&dir_real)
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
    let mut entries = Vec::new();
    let mut truncated = false;

    for entry_res in read_dir {
        let Ok(entry) = entry_res else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let requested_child = if requested_rel.is_empty() {
            name.clone()
        } else {
            format!("{requested_rel}/{name}")
        };
        if is_excluded_by_rules(&requested_child, &rules) {
            continue;
        }
        let Ok(child_real) = fs::canonicalize(dir_real.join(&name)) else {
            continue;
        };
        let Some(child_rel) = to_project_relative_string(&canonical_root, &child_real) else {
            continue;
        };
        if is_excluded_by_rules(&child_rel, &rules) {
            continue;
        }
        let Ok(child_meta) = fs::metadata(&child_real) else {
            continue;
        };
        let entry_type = if child_meta.is_dir() {
            "directory"
        } else if child_meta.is_file() {
            "file"
        } else {
            continue;
        };
        if entries.len() >= clamped_limit {
            truncated = true;
            break;
        }
        entries.push(DirectoryChildEntry {
            name,
            entry_type: entry_type.to_string(),
        });
    }

    entries.sort_by(|left, right| {
        if left.entry_type != right.entry_type {
            return if left.entry_type == "directory" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        left.name.cmp(&right.name)
    });

    Ok(DirectoryListPage { entries, truncated })
}

fn is_binary_image_path(path_or_name: &str) -> bool {
    let Some((_, ext)) = path_or_name.rsplit_once('.') else {
        return false;
    };
    let lower = ext.trim().to_ascii_lowercase();
    BINARY_IMAGE_EXTENSIONS.contains(&lower.as_str())
}

pub fn read_project_file(
    root: &Path,
    relative_path: &str,
    max_bytes: usize,
    allow_binary_images: bool,
) -> PortResult<Option<ProjectFileReadResult>> {
    let clamped_max = if max_bytes == 0 {
        DEFAULT_READ_FILE_MAX_BYTES
    } else {
        max_bytes.clamp(1, HARD_READ_FILE_MAX_BYTES)
    };

    let Ok(canonical_root) = fs::canonicalize(root) else {
        return Ok(None);
    };
    let Some(lexical_file) = resolve_safe_lexical_subpath(&canonical_root, relative_path, false)
    else {
        return Ok(None);
    };
    let requested_rel = normalize_project_relative_path(relative_path.trim());
    let Ok(target_real) = fs::canonicalize(&lexical_file) else {
        return Ok(None);
    };
    let Some(resolved_rel) = to_project_relative_string(&canonical_root, &target_real) else {
        return Ok(None);
    };
    if resolved_rel.is_empty() {
        return Ok(None);
    }

    let rules = load_root_gitignore_rules(&canonical_root);
    if is_excluded_by_rules(&requested_rel, &rules) || is_excluded_by_rules(&resolved_rel, &rules) {
        return Ok(None);
    }

    let Ok(sym_meta) = fs::symlink_metadata(&target_real) else {
        return Ok(None);
    };
    if sym_meta.file_type().is_symlink() || !sym_meta.file_type().is_file() {
        return Ok(None);
    }

    let Ok(mut file) = File::open(&target_real) else {
        return Ok(None);
    };
    let read_limit = clamped_max.saturating_add(1);
    let hint = usize::try_from(sym_meta.len())
        .unwrap_or(clamped_max)
        .saturating_add(1)
        .clamp(1, read_limit);
    let mut buf = Vec::with_capacity(hint);
    let mut chunk = [0u8; 8192];
    while buf.len() < read_limit {
        let remaining = read_limit - buf.len();
        let slice_len = remaining.min(chunk.len());
        match file.read(&mut chunk[..slice_len]) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(None),
        }
    }

    let truncated = buf.len() > clamped_max;
    let safe_bytes = &buf[..buf.len().min(clamped_max)];
    if allow_binary_images && is_binary_image_path(&resolved_rel) {
        return Ok(Some(ProjectFileReadResult {
            path: resolved_rel,
            content: BASE64_STANDARD.encode(safe_bytes),
            truncated,
            encoding: Some("base64".to_string()),
        }));
    }

    Ok(Some(ProjectFileReadResult {
        path: resolved_rel,
        content: String::from_utf8_lossy(safe_bytes).into_owned(),
        truncated,
        encoding: None,
    }))
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let val = u8::from_str_radix(hex, 16).ok()?;
            out.push(val);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn run_git_capture(root: &Path, args: &[&str]) -> Result<(i32, String, String), String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let code = out.status.code().unwrap_or(1);
    Ok((
        code,
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

pub fn checkout_branch(root: &Path, branch_name: &str) -> CheckoutBranchOutcome {
    let fail = |msg: String| CheckoutBranchOutcome {
        success: false,
        current_branch: None,
        error: Some(msg),
    };

    let (_, _, canonical_root) = match prepare_project_root(root) {
        Ok(t) => t,
        Err(e) => return fail(e.message),
    };
    let trimmed_branch = branch_name.trim();
    if trimmed_branch.is_empty() {
        return fail("Branch name is required".to_string());
    }

    let Ok((top_code, top_out, _)) =
        run_git_capture(&canonical_root, &["rev-parse", "--show-toplevel"])
    else {
        return fail("Failed to inspect git repository".to_string());
    };
    if top_code != 0 {
        return fail("Local project is not a git repository".to_string());
    }
    let Ok(top_real) = fs::canonicalize(top_out.trim()) else {
        return fail("Local project is not a git repository".to_string());
    };
    if normalize_canonical_path_string(&top_real)
        != normalize_canonical_path_string(&canonical_root)
    {
        return fail("Local project is not a git repository".to_string());
    }

    let parsed_target: Result<(bool, String, String), String> =
        if let Some(enc) = trimmed_branch.strip_prefix("lody:branch:local:") {
            match percent_decode(enc).filter(|s| !s.is_empty() && !s.starts_with('-')) {
                Some(b) => Ok((true, b.clone(), format!("refs/heads/{b}"))),
                None => Err(format!("Local project branch not found: {trimmed_branch}")),
            }
        } else if let Some(enc) = trimmed_branch.strip_prefix("lody:branch:remote:") {
            if let Some((rem_enc, br_enc)) = enc.split_once(':')
                && let (Some(rem), Some(br)) = (percent_decode(rem_enc), percent_decode(br_enc))
                && !rem.is_empty()
                && !br.is_empty()
                && !br.starts_with('-')
            {
                Ok((false, br.clone(), format!("refs/remotes/{rem}/{br}")))
            } else {
                Err(format!("Local project branch not found: {trimmed_branch}"))
            }
        } else if trimmed_branch.starts_with('-') {
            Err(format!("Invalid branch name: {trimmed_branch}"))
        } else {
            let local_ref = format!("refs/heads/{trimmed_branch}");
            let local_exists = run_git_capture(
                &canonical_root,
                &["show-ref", "--verify", "--quiet", &local_ref],
            )
            .is_ok_and(|(c, _, _)| c == 0);
            if local_exists {
                Ok((true, trimmed_branch.to_string(), local_ref))
            } else {
                let remote_ref = format!("refs/remotes/origin/{trimmed_branch}");
                let remote_exists = run_git_capture(
                    &canonical_root,
                    &["show-ref", "--verify", "--quiet", &remote_ref],
                )
                .is_ok_and(|(c, _, _)| c == 0);
                if remote_exists {
                    Ok((false, trimmed_branch.to_string(), remote_ref))
                } else {
                    Err(format!("Local project branch not found: {trimmed_branch}"))
                }
            }
        };

    let (is_local, target_local_branch, full_ref) = match parsed_target {
        Ok(v) => v,
        Err(msg) => return fail(msg),
    };

    if run_git_capture(
        &canonical_root,
        &["show-ref", "--verify", "--quiet", &full_ref],
    )
    .map(|(c, _, _)| c)
        != Ok(0)
    {
        return fail(format!("Local project branch not found: {trimmed_branch}"));
    }

    let Ok((st_code, st_out, st_err)) = run_git_capture(
        &canonical_root,
        &["status", "--porcelain", "--untracked-files=normal"],
    ) else {
        return fail("Failed to inspect working tree".to_string());
    };
    if st_code != 0 {
        return fail(format!("Failed to inspect working tree: {}", st_err.trim()));
    }
    if !st_out.trim().is_empty() {
        return fail("Cannot switch branches with local changes".to_string());
    }

    let checkout_res = if is_local {
        run_git_capture(
            &canonical_root,
            &["switch", "--no-guess", "--", &target_local_branch],
        )
    } else {
        run_git_capture(
            &canonical_root,
            &["checkout", "--track", "-b", &target_local_branch, &full_ref],
        )
    };

    match checkout_res {
        Ok((0, _, _)) => {}
        Ok((_, out, err)) => {
            let reason = if !err.trim().is_empty() {
                err.trim()
            } else {
                out.trim()
            };
            return fail(format!("Failed to checkout git branch: {reason}"));
        }
        Err(err) => return fail(format!("Failed to checkout git branch: {err}")),
    }

    match run_git_capture(&canonical_root, &["symbolic-ref", "--quiet", "HEAD"]) {
        Ok((0, out, _)) => {
            let trimmed = out.trim();
            if let Some(short) = trimmed.strip_prefix("refs/heads/")
                && !short.is_empty()
            {
                CheckoutBranchOutcome {
                    success: true,
                    current_branch: Some(short.to_string()),
                    error: None,
                }
            } else {
                fail("Current git branch is detached after checkout".to_string())
            }
        }
        _ => fail("Failed to resolve current git branch after checkout".to_string()),
    }
}

#[derive(Clone)]
struct SkillCandidate {
    display_skill_dir: String,
    relative_path: String,
    real_path: PathBuf,
    is_symlink: bool,
}

struct SkillFingerprintPart {
    scope: String,
    group_dir: String,
    relative_path: String,
    real_path: String,
    size: u64,
    mtime_ms: u128,
}

struct ScannedSkillGroup {
    scope: String,
    dir: String,
    candidates: Vec<SkillCandidate>,
    truncated: bool,
    skipped_external_symlinks: usize,
}

enum ScannedGroupOutcome {
    Scanned {
        root_real: PathBuf,
        group: ScannedSkillGroup,
    },
    Error(ProjectSkillGroupEntry),
}

enum ResolvedEntry {
    Inside {
        real_path: PathBuf,
        meta: fs::Metadata,
        is_symlink: bool,
    },
    ExternalSymlink,
}

fn resolve_entry_within_root(
    root_real: &Path,
    candidate: &Path,
) -> PortResult<Option<ResolvedEntry>> {
    let lmeta = match fs::symlink_metadata(candidate) {
        Ok(m) => m,
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound) => return Ok(None),
        Err(e) => return Err(PortError::new(PortErrorKind::Internal, e.to_string())),
    };
    let is_symlink = lmeta.file_type().is_symlink();
    let real_path = match fs::canonicalize(candidate) {
        Ok(p) => p,
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound) => return Ok(None),
        Err(e) => return Err(PortError::new(PortErrorKind::Internal, e.to_string())),
    };
    if !real_path.starts_with(root_real) {
        if is_symlink {
            return Ok(Some(ResolvedEntry::ExternalSymlink));
        }
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Resolved project path escapes project root.",
        ));
    }
    let meta = match fs::metadata(&real_path) {
        Ok(m) => m,
        Err(e) if matches!(e.kind(), io::ErrorKind::NotFound) => return Ok(None),
        Err(e) => return Err(PortError::new(PortErrorKind::Internal, e.to_string())),
    };
    Ok(Some(ResolvedEntry::Inside {
        real_path,
        meta,
        is_symlink,
    }))
}

fn normalize_skill_scan_dir(skill_dir: &str) -> PortResult<String> {
    let trimmed = skill_dir.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("Invalid skill scan directory: {skill_dir}"),
        ));
    }
    if Path::new(trimmed).is_absolute() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("Skill scan directory must be project-relative: {skill_dir}"),
        ));
    }
    let normalized = normalize_project_relative_path(trimmed);
    if normalized.is_empty() || normalized.split('/').any(|s| s == "..") {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("Skill scan directory escapes project root: {skill_dir}"),
        ));
    }
    Ok(normalized)
}

#[allow(clippy::too_many_arguments)]
fn add_skill_from_dir(
    root_real: &Path,
    scope: &str,
    group_dir: &str,
    display_skill_dir: &str,
    real_skill_dir: &Path,
    inherited_symlink: bool,
    candidates: &mut Vec<SkillCandidate>,
    fp_parts: &mut Vec<SkillFingerprintPart>,
) -> PortResult<&'static str> {
    let skill_md_path = real_skill_dir.join("SKILL.md");
    let Some(resolved) = resolve_entry_within_root(root_real, &skill_md_path)? else {
        return Ok("missing");
    };
    let ResolvedEntry::Inside {
        real_path,
        meta,
        is_symlink,
    } = resolved
    else {
        return Ok("external-symlink");
    };
    if !meta.is_file() {
        return Ok("missing");
    }
    if meta.len() > SKILL_MD_MAX_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "SKILL.md is too large to read.",
        ));
    }
    let relative_path = normalize_project_relative_path(&format!("{display_skill_dir}/SKILL.md"));
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    candidates.push(SkillCandidate {
        display_skill_dir: display_skill_dir.to_string(),
        relative_path: relative_path.clone(),
        real_path: real_path.clone(),
        is_symlink: inherited_symlink || is_symlink,
    });
    fp_parts.push(SkillFingerprintPart {
        scope: scope.to_string(),
        group_dir: group_dir.to_string(),
        relative_path,
        real_path: real_path.to_string_lossy().into_owned(),
        size: meta.len(),
        mtime_ms,
    });
    Ok("added")
}

fn scan_skill_group(
    root_real: &Path,
    scope: &str,
    skill_dir: &str,
    rules: Option<&[SimpleGitignoreRule]>,
    fp_parts: &mut Vec<SkillFingerprintPart>,
) -> PortResult<Option<ScannedSkillGroup>> {
    let group_dir = normalize_skill_scan_dir(skill_dir)?;
    if let Some(r) = rules
        && is_excluded_by_rules(&group_dir, r)
    {
        return Ok(None);
    }
    let Some(group_path) = resolve_safe_lexical_subpath(root_real, &group_dir, false) else {
        return Ok(None);
    };
    let Some(resolved_group) = resolve_entry_within_root(root_real, &group_path)? else {
        return Ok(None);
    };
    let ResolvedEntry::Inside {
        real_path: group_real,
        meta: group_meta,
        is_symlink: group_symlink,
    } = resolved_group
    else {
        return Ok(Some(ScannedSkillGroup {
            scope: scope.to_string(),
            dir: group_dir,
            candidates: Vec::new(),
            truncated: false,
            skipped_external_symlinks: 1,
        }));
    };
    if !group_meta.is_dir() {
        return Ok(None);
    }
    if let Some(r) = rules
        && let Some(rel) = to_project_relative_string(root_real, &group_real)
        && is_excluded_by_rules(&rel, r)
    {
        return Ok(None);
    }

    let mut candidates = Vec::new();
    let mut skipped_external = 0usize;

    if add_skill_from_dir(
        root_real,
        scope,
        &group_dir,
        &group_dir,
        &group_real,
        group_symlink,
        &mut candidates,
        fp_parts,
    )? == "external-symlink"
    {
        skipped_external += 1;
    }

    let mut child_entries: Vec<fs::DirEntry> = fs::read_dir(&group_real)
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?
        .filter_map(Result::ok)
        .collect();
    child_entries.sort_by_key(|e| e.file_name());

    let mut truncated = child_entries.len() > SKILL_DIR_MAX_CHILDREN;
    for entry in child_entries.into_iter().take(SKILL_DIR_MAX_CHILDREN) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." || name == "SKILL.md" {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() && !ft.is_symlink() {
            continue;
        }
        let display_dir = normalize_project_relative_path(&format!("{group_dir}/{name}"));
        if let Some(r) = rules
            && is_excluded_by_rules(&display_dir, r)
        {
            continue;
        }
        let Some(resolved_child) = resolve_entry_within_root(root_real, &group_real.join(&name))?
        else {
            continue;
        };
        let ResolvedEntry::Inside {
            real_path: child_real,
            meta: child_meta,
            is_symlink: child_symlink,
        } = resolved_child
        else {
            skipped_external += 1;
            continue;
        };
        if !child_meta.is_dir() {
            continue;
        }
        if let Some(r) = rules
            && let Some(rel) = to_project_relative_string(root_real, &child_real)
            && is_excluded_by_rules(&rel, r)
        {
            continue;
        }

        let add_res = add_skill_from_dir(
            root_real,
            scope,
            &group_dir,
            &display_dir,
            &child_real,
            group_symlink || child_symlink,
            &mut candidates,
            fp_parts,
        )?;
        if add_res == "external-symlink" {
            skipped_external += 1;
        }
        if add_res != "missing" {
            continue;
        }

        let Ok(nested_iter) = fs::read_dir(&child_real) else {
            continue;
        };
        let mut nested_entries: Vec<fs::DirEntry> = nested_iter.filter_map(Result::ok).collect();
        nested_entries.sort_by_key(|e| e.file_name());
        truncated |= nested_entries.len() > SKILL_DIR_MAX_CHILDREN;
        for nested in nested_entries.into_iter().take(SKILL_DIR_MAX_CHILDREN) {
            let nested_name = nested.file_name().to_string_lossy().into_owned();
            if nested_name.is_empty()
                || nested_name == "."
                || nested_name == ".."
                || nested_name == "SKILL.md"
            {
                continue;
            }
            let Ok(nft) = nested.file_type() else {
                continue;
            };
            if !nft.is_dir() && !nft.is_symlink() {
                continue;
            }
            let nested_display =
                normalize_project_relative_path(&format!("{display_dir}/{nested_name}"));
            if let Some(r) = rules
                && is_excluded_by_rules(&nested_display, r)
            {
                continue;
            }
            let Some(resolved_nested) =
                resolve_entry_within_root(root_real, &child_real.join(&nested_name))?
            else {
                continue;
            };
            let ResolvedEntry::Inside {
                real_path: nested_real,
                meta: nested_meta,
                is_symlink: nested_symlink,
            } = resolved_nested
            else {
                skipped_external += 1;
                continue;
            };
            if !nested_meta.is_dir() {
                continue;
            }
            if let Some(r) = rules
                && let Some(rel) = to_project_relative_string(root_real, &nested_real)
                && is_excluded_by_rules(&rel, r)
            {
                continue;
            }
            if add_skill_from_dir(
                root_real,
                scope,
                &group_dir,
                &nested_display,
                &nested_real,
                group_symlink || child_symlink || nested_symlink,
                &mut candidates,
                fp_parts,
            )? == "external-symlink"
            {
                skipped_external += 1;
            }
        }
    }

    if candidates.is_empty() && skipped_external == 0 && !truncated {
        return Ok(None);
    }

    Ok(Some(ScannedSkillGroup {
        scope: scope.to_string(),
        dir: group_dir,
        candidates,
        truncated,
        skipped_external_symlinks: skipped_external,
    }))
}

fn unquote_frontmatter_scalar(raw: &str) -> String {
    let v = raw.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        return v[1..v.len() - 1].trim().to_string();
    }
    v.to_string()
}

type ParsedSkillMetadata = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn parse_skill_markdown(markdown: &str) -> Result<ParsedSkillMetadata, String> {
    let normalized = markdown.strip_prefix('\u{FEFF}').unwrap_or(markdown);
    let newline = if normalized.starts_with("---\r\n") {
        Some("\r\n")
    } else if normalized.starts_with("---\n") {
        Some("\n")
    } else {
        None
    };

    let Some(nl) = newline else {
        let body = normalized.trim();
        return Ok((
            None,
            None,
            None,
            None,
            (!body.is_empty()).then(|| body.to_string()),
        ));
    };

    let start_len = 3 + nl.len();
    let end_marker = format!("{nl}---");
    let Some(rel_end) = normalized[start_len..].find(&end_marker) else {
        return Err("SKILL.md frontmatter is missing a closing marker.".to_string());
    };
    let end_idx = start_len + rel_end;
    let frontmatter = &normalized[start_len..end_idx];

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut version: Option<String> = None;
    let mut author: Option<String> = None;
    let mut meta_version: Option<String> = None;
    let mut meta_author: Option<String> = None;
    let mut current_parent: Option<&str> = None;

    for raw_line in frontmatter.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if raw_line.starts_with([' ', '\t']) {
            if current_parent != Some("metadata") {
                continue;
            }
            if trimmed.starts_with("- ") {
                continue;
            }
            let Some((k, v)) = trimmed.split_once(':') else {
                return Err(format!("Invalid metadata frontmatter line: {trimmed}"));
            };
            let key = k.trim();
            if key.is_empty()
                || !key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(format!("Invalid metadata frontmatter line: {trimmed}"));
            }
            let val = unquote_frontmatter_scalar(v);
            if !val.is_empty() {
                if key == "version" {
                    meta_version = Some(val);
                } else if key == "author" {
                    meta_author = Some(val);
                }
            }
            continue;
        }

        let Some((k, v)) = trimmed.split_once(':') else {
            return Err(format!("Invalid SKILL.md frontmatter line: {trimmed}"));
        };
        let key = k.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        {
            return Err(format!("Invalid SKILL.md frontmatter line: {trimmed}"));
        }
        current_parent = v.trim().is_empty().then_some(key);
        let val = unquote_frontmatter_scalar(v);
        if val.is_empty() {
            continue;
        }
        match key {
            "name" => name = Some(val),
            "description" => description = Some(val),
            "version" => version = Some(val),
            "author" => author = Some(val),
            "metadata.version" => meta_version = Some(val),
            "metadata.author" => meta_author = Some(val),
            _ => {}
        }
    }

    let after_marker = end_idx + end_marker.len();
    let body = match normalized[after_marker..].find('\n') {
        Some(line_end) => normalized[after_marker + line_end + 1..].trim(),
        None => "",
    };

    Ok((
        name,
        description,
        version.or(meta_version),
        author.or(meta_author),
        (!body.is_empty()).then(|| body.to_string()),
    ))
}

fn materialize_skill_group(
    root_real: &Path,
    scanned: ScannedSkillGroup,
    home_prefixed: bool,
) -> ProjectSkillGroupEntry {
    let mut skills = Vec::new();
    for cand in &scanned.candidates {
        let Ok(sym_meta) = fs::symlink_metadata(&cand.real_path) else {
            continue;
        };
        if sym_meta.file_type().is_symlink()
            || !sym_meta.file_type().is_file()
            || sym_meta.len() > SKILL_MD_MAX_BYTES
        {
            return ProjectSkillGroupEntry {
                scope: scanned.scope,
                dir: if home_prefixed {
                    format!("~/{}", scanned.dir)
                } else {
                    scanned.dir
                },
                skills: Vec::new(),
                truncated: false,
                skipped_external_symlinks: None,
                error: Some("SKILL.md is unreadable or too large.".to_string()),
            };
        }
        let Ok(markdown) = fs::read_to_string(&cand.real_path) else {
            continue;
        };
        let (fm_name, description, version, author, content) = match parse_skill_markdown(&markdown)
        {
            Ok(parsed) => parsed,
            Err(err_msg) => {
                return ProjectSkillGroupEntry {
                    scope: scanned.scope,
                    dir: if home_prefixed {
                        format!("~/{}", scanned.dir)
                    } else {
                        scanned.dir
                    },
                    skills: Vec::new(),
                    truncated: false,
                    skipped_external_symlinks: None,
                    error: Some(err_msg),
                };
            }
        };

        let dir_basename = cand
            .display_skill_dir
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .or_else(|| scanned.dir.rsplit('/').next().filter(|s| !s.is_empty()))
            .unwrap_or(&scanned.dir);
        let id_segment = if cand.display_skill_dir == scanned.dir {
            "SKILL.md"
        } else {
            dir_basename
        };
        let raw_id = format!("{}/{id_segment}", scanned.dir);
        let name = fm_name.unwrap_or_else(|| dir_basename.to_string());
        let symlink_target = if cand.is_symlink {
            cand.real_path
                .parent()
                .and_then(|p| to_project_relative_string(root_real, p))
                .filter(|s| !s.is_empty())
        } else {
            None
        };

        let (wire_id, wire_rel, wire_abs, wire_sym) = if home_prefixed {
            (
                format!("~/{raw_id}"),
                format!("~/{}", cand.relative_path),
                Some(cand.real_path.to_string_lossy().into_owned()),
                symlink_target.map(|t| format!("~/{t}")),
            )
        } else {
            (raw_id, cand.relative_path.clone(), None, symlink_target)
        };

        skills.push(ProjectSkillEntry {
            id: wire_id,
            name,
            description,
            version,
            author,
            relative_path: wire_rel,
            absolute_path: wire_abs,
            is_symlink: cand.is_symlink,
            symlink_target: wire_sym,
            content,
        });
    }

    skills.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });

    ProjectSkillGroupEntry {
        scope: scanned.scope,
        dir: if home_prefixed {
            format!("~/{}", scanned.dir)
        } else {
            scanned.dir
        },
        skills,
        truncated: scanned.truncated,
        skipped_external_symlinks: (scanned.skipped_external_symlinks > 0)
            .then_some(scanned.skipped_external_symlinks),
        error: None,
    }
}

fn compute_skills_fingerprint(
    outcomes: &[ScannedGroupOutcome],
    fp_parts: &[SkillFingerprintPart],
) -> String {
    let mut group_items: Vec<(String, serde_json::Value)> = outcomes
        .iter()
        .map(|entry| match entry {
            ScannedGroupOutcome::Error(g) => (
                format!("{}:{}", g.scope, g.dir),
                json!({
                    "dir": g.dir,
                    "scope": g.scope,
                    "error": g.error,
                }),
            ),
            ScannedGroupOutcome::Scanned { group, .. } => {
                let skills_val: Vec<serde_json::Value> = group
                    .candidates
                    .iter()
                    .map(|c| {
                        json!({
                            "relativePath": c.relative_path,
                            "isSymlink": c.is_symlink,
                        })
                    })
                    .collect();
                (
                    format!("{}:{}", group.scope, group.dir),
                    json!({
                        "dir": group.dir,
                        "scope": group.scope,
                        "skills": skills_val,
                        "truncated": group.truncated,
                        "skippedExternalSymlinks": group.skipped_external_symlinks,
                    }),
                )
            }
        })
        .collect();
    group_items.sort_by(|a, b| a.0.cmp(&b.0));

    let mut file_items: Vec<(String, serde_json::Value)> = fp_parts
        .iter()
        .map(|f| {
            (
                format!("{}:{}", f.scope, f.relative_path),
                json!({
                    "groupDir": f.group_dir,
                    "scope": f.scope,
                    "relativePath": f.relative_path,
                    "realPath": f.real_path,
                    "size": f.size,
                    "mtimeMs": u64::try_from(f.mtime_ms).unwrap_or(u64::MAX),
                }),
            )
        })
        .collect();
    file_items.sort_by(|a, b| a.0.cmp(&b.0));

    let groups_json: Vec<serde_json::Value> = group_items.into_iter().map(|(_, v)| v).collect();
    let files_json: Vec<serde_json::Value> = file_items.into_iter().map(|(_, v)| v).collect();
    let payload = json!({
        "groups": groups_json,
        "files": files_json,
    });
    sha256_hex(payload.to_string().as_bytes())
}

fn apply_skills_budget(groups: Vec<ProjectSkillGroupEntry>) -> Vec<ProjectSkillGroupEntry> {
    let mut remaining_bytes = PROJECT_SKILLS_CONTENT_BUDGET_BYTES;
    let mut remaining_skills = PROJECT_SKILLS_MAX_COUNT;
    groups
        .into_iter()
        .map(|mut group| {
            let mut truncated_by_count = false;
            let mut out_skills = Vec::with_capacity(group.skills.len());
            for mut skill in group.skills {
                if remaining_skills == 0 {
                    truncated_by_count = true;
                    continue;
                }
                remaining_skills -= 1;
                if let Some(ref body) = skill.content {
                    if body.len() > remaining_bytes {
                        skill.content = None;
                    } else {
                        remaining_bytes -= body.len();
                    }
                }
                out_skills.push(skill);
            }
            group.skills = out_skills;
            group.truncated |= truncated_by_count;
            group
        })
        .collect()
}

fn finalize_skills_listing(
    outcomes: Vec<ScannedGroupOutcome>,
    fp_parts: &[SkillFingerprintPart],
    known_fingerprint: Option<&str>,
    home_prefixed: bool,
) -> ProjectSkillsListing {
    let content_fingerprint = compute_skills_fingerprint(&outcomes, fp_parts);
    if known_fingerprint.is_some_and(|known| known == content_fingerprint) {
        return ProjectSkillsListing {
            groups: Vec::new(),
            content_fingerprint: Some(content_fingerprint),
            unchanged: Some(true),
        };
    }

    let mut groups: Vec<ProjectSkillGroupEntry> = outcomes
        .into_iter()
        .map(|entry| match entry {
            ScannedGroupOutcome::Error(g) => g,
            ScannedGroupOutcome::Scanned { root_real, group } => {
                materialize_skill_group(&root_real, group, home_prefixed)
            }
        })
        .collect();
    groups.sort_by(|a, b| a.dir.cmp(&b.dir));
    ProjectSkillsListing {
        groups: apply_skills_budget(groups),
        content_fingerprint: Some(content_fingerprint),
        unchanged: None,
    }
}

pub fn list_project_skills(
    root: &Path,
    skill_dirs: &[String],
    known_fingerprint: Option<&str>,
) -> PortResult<ProjectSkillsListing> {
    let (_, _, canonical_root) = prepare_project_root(root)?;
    let rules = load_root_gitignore_rules(&canonical_root);
    let mut unique_dirs = BTreeSet::new();
    for raw_dir in skill_dirs {
        unique_dirs.insert(normalize_skill_scan_dir(raw_dir)?);
    }

    let mut fp_parts = Vec::new();
    let mut outcomes = Vec::new();
    for dir in unique_dirs {
        match scan_skill_group(
            &canonical_root,
            "project",
            &dir,
            Some(&rules),
            &mut fp_parts,
        ) {
            Ok(Some(group)) => outcomes.push(ScannedGroupOutcome::Scanned {
                root_real: canonical_root.clone(),
                group,
            }),
            Ok(None) => {}
            Err(err) => outcomes.push(ScannedGroupOutcome::Error(ProjectSkillGroupEntry {
                scope: "project".to_string(),
                dir,
                skills: Vec::new(),
                truncated: false,
                skipped_external_symlinks: None,
                error: Some(err.message),
            })),
        }
    }

    Ok(finalize_skills_listing(
        outcomes,
        &fp_parts,
        known_fingerprint,
        false,
    ))
}

pub fn list_global_skills(
    home_dir: &Path,
    known_fingerprint: Option<&str>,
) -> PortResult<ProjectSkillsListing> {
    let home_real = fs::canonicalize(home_dir)
        .map_err(|e| PortError::new(PortErrorKind::NotFound, e.to_string()))?;
    let mut fp_parts = Vec::new();
    let mut outcomes = Vec::new();

    for (dirs, scope) in [
        (KNOWN_GLOBAL_SKILL_DIRS, "global"),
        (KNOWN_SYSTEM_SKILL_DIRS, "system"),
    ] {
        let mut unique: BTreeMap<String, String> = BTreeMap::new();
        for raw in dirs {
            if let Some(stripped) = raw.strip_prefix("~/")
                && let Ok(rel) = normalize_skill_scan_dir(stripped)
            {
                unique.insert(format!("~/{rel}"), rel);
            }
        }
        for (display_dir, rel_dir) in unique {
            match scan_skill_group(&home_real, scope, &rel_dir, None, &mut fp_parts) {
                Ok(Some(group)) => outcomes.push(ScannedGroupOutcome::Scanned {
                    root_real: home_real.clone(),
                    group,
                }),
                Ok(None) => {}
                Err(err) => outcomes.push(ScannedGroupOutcome::Error(ProjectSkillGroupEntry {
                    scope: scope.to_string(),
                    dir: display_dir,
                    skills: Vec::new(),
                    truncated: false,
                    skipped_external_symlinks: None,
                    error: Some(err.message),
                })),
            }
        }
    }

    Ok(finalize_skills_listing(
        outcomes,
        &fp_parts,
        known_fingerprint,
        true,
    ))
}

pub fn resolve_session_worktree_path(
    repos_root: &Path,
    repo_key: &str,
    session_id: &SessionId,
) -> PortResult<PathBuf> {
    let trimmed_repo = repo_key.trim();
    let trimmed_sid = session_id.0.trim();
    if trimmed_repo.is_empty()
        || trimmed_sid.is_empty()
        || trimmed_sid == "."
        || trimmed_sid == ".."
        || trimmed_sid.contains(['/', '\\', '\0'])
        || trimmed_sid.contains("..")
    {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Session worktree path not found.",
        ));
    }

    let is_direct_repo_id = (trimmed_repo.starts_with("local---")
        || trimmed_repo.starts_with("local-project-")
        || trimmed_repo.starts_with("github---"))
        && !trimmed_repo.contains(['/', '\\', '\0'])
        && !trimmed_repo.contains("..");

    let repo_id = if is_direct_repo_id {
        trimmed_repo.to_string()
    } else if let Some(full) =
        parse_github_repo_full_name(&format!("https://github.com/{trimmed_repo}"))
            .or_else(|| parse_github_repo_full_name(trimmed_repo))
    {
        let mut split = full.split('/');
        let owner = split.next().unwrap_or("");
        let repo = split.next().unwrap_or("");
        format!(
            "github---{}---{}",
            owner.to_ascii_lowercase(),
            repo.to_ascii_lowercase()
        )
    } else {
        return Err(PortError::new(
            PortErrorKind::NotFound,
            "Session worktree path not found.",
        ));
    };

    Ok(repos_root.join(repo_id).join("worktrees").join(trimmed_sid))
}
