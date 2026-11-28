use crate::scan::collect_project_file_paths;
use lody_ports::{
    BranchListPage, BranchListQuery, FileSearchResult, LocalProjectGitSummary, PortResult,
};
use std::path::Path;
use std::process::{Command, Stdio};

const MAX_HOST_SEARCH_CANDIDATE_FILES: usize = 100_000;

const BASENAME_EXACT: i64 = 10_000_000;
const BASENAME_PREFIX: i64 = 8_000_000;
const BASENAME_CONTAINS: i64 = 6_000_000;
const PATH_PREFIX: i64 = 5_000_000;
const PATH_CONTAINS: i64 = 4_000_000;
const SUBSEQUENCE_BASE: i64 = 1_000_000;

fn run_git_text(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub fn parse_github_repo_full_name(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("git@github.com:")
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))
        .or_else(|| trimmed.strip_prefix("https://github.com/"))
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;
    let without_git = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = without_git.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn ref_exists(root: &Path, full_ref: &str) -> bool {
    Command::new("git")
        .args(["show-ref", "--verify", "--quiet", full_ref])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub fn inspect_git_summary(root: &Path) -> LocalProjectGitSummary {
    if !root.exists() {
        return LocalProjectGitSummary::non_git();
    }
    let is_git = run_git_text(root, &["rev-parse", "--is-inside-work-tree"])
        .is_some_and(|v| v.eq_ignore_ascii_case("true"));
    if !is_git {
        return LocalProjectGitSummary::non_git();
    }

    let current_branch = run_git_text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let origin_head = run_git_text(
        root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .and_then(|s| s.strip_prefix("origin/").map(ToOwned::to_owned));

    let default_branch = origin_head
        .or_else(|| ref_exists(root, "refs/heads/main").then(|| "main".to_string()))
        .or_else(|| ref_exists(root, "refs/heads/master").then(|| "master".to_string()))
        .or_else(|| current_branch.clone());

    let github_repo_full_name = run_git_text(root, &["config", "--get", "remote.origin.url"])
        .and_then(|u| parse_github_repo_full_name(&u));

    LocalProjectGitSummary {
        git: true,
        current_branch,
        default_branch,
        github_repo_full_name,
    }
}

pub fn list_branches(root: &Path, query: &BranchListQuery) -> PortResult<BranchListPage> {
    let summary = inspect_git_summary(root);
    if !summary.git {
        return Ok(BranchListPage {
            git: false,
            current_branch: None,
            default_branch: None,
            pinned_branches: Vec::new(),
            branches: Vec::new(),
            truncated: false,
            next_cursor: None,
            total_count: 0,
        });
    }

    let raw_branches = run_git_text(
        root,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .unwrap_or_default();
    let mut all_branches: Vec<String> = raw_branches
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    all_branches.sort();
    all_branches.dedup();

    let mut pinned_branches = Vec::new();
    for candidate in [&summary.current_branch, &summary.default_branch]
        .into_iter()
        .flatten()
    {
        if all_branches.iter().any(|b| b == candidate) && !pinned_branches.contains(candidate) {
            pinned_branches.push(candidate.clone());
        }
    }

    let filter = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| q.to_ascii_lowercase());

    let filtered: Vec<String> = match filter {
        Some(q) => all_branches
            .into_iter()
            .filter(|b| b.to_ascii_lowercase().contains(&q))
            .collect(),
        None => all_branches,
    };

    let total_count = filtered.len();
    let limit = query.limit.clamp(1, 200);
    let offset = query
        .cursor
        .as_deref()
        .and_then(|c| c.parse::<usize>().ok())
        .unwrap_or(0)
        .min(total_count);

    let branches: Vec<String> = filtered.into_iter().skip(offset).take(limit).collect();
    let next_offset = offset + branches.len();
    let truncated = next_offset < total_count;
    let next_cursor = truncated.then(|| next_offset.to_string());

    Ok(BranchListPage {
        git: true,
        current_branch: summary.current_branch,
        default_branch: summary.default_branch,
        pinned_branches,
        branches,
        truncated,
        next_cursor,
        total_count,
    })
}

fn score_subsequence(lower_path: &str, query: &str) -> Option<i64> {
    let path_bytes = lower_path.as_bytes();
    let query_bytes = query.as_bytes();
    if query_bytes.is_empty() {
        return Some(0);
    }
    let mut score: i64 = 0;
    let mut q_idx = 0usize;
    let mut prev_match: isize = -2;

    for (idx, &ch) in path_bytes.iter().enumerate() {
        if q_idx >= query_bytes.len() {
            break;
        }
        if ch != query_bytes[q_idx] {
            continue;
        }
        let prev_char = if idx == 0 { b'/' } else { path_bytes[idx - 1] };
        let idx_isize = isize::try_from(idx).unwrap_or(0);
        if idx_isize == prev_match + 1 {
            score += 5_000;
        }
        if matches!(prev_char, b'/' | b'-' | b'_' | b'.') {
            score += 3_000;
        }
        score += 1_000;
        prev_match = idx_isize;
        q_idx += 1;
    }

    (q_idx == query_bytes.len()).then_some(score)
}

pub fn score_local_project_file_path(path_value: &str, normalized_query: &str) -> Option<i64> {
    let lower_path = path_value.to_ascii_lowercase();
    let basename = match lower_path.rfind('/') {
        Some(slash) => &lower_path[slash + 1..],
        None => lower_path.as_str(),
    };
    let path_len = i64::try_from(lower_path.len()).unwrap_or(0);
    let base_len = i64::try_from(basename.len()).unwrap_or(0);

    if basename == normalized_query {
        return Some(BASENAME_EXACT);
    }
    if basename.starts_with(normalized_query) {
        return Some(BASENAME_PREFIX - base_len * 1_000);
    }
    if let Some(base_idx) = basename.find(normalized_query) {
        let idx_i64 = i64::try_from(base_idx).unwrap_or(0);
        return Some(BASENAME_CONTAINS - (idx_i64 + base_len) * 1_000);
    }
    if lower_path.starts_with(normalized_query) {
        return Some(PATH_PREFIX - path_len * 10);
    }
    if let Some(path_idx) = lower_path.find(normalized_query) {
        let idx_i64 = i64::try_from(path_idx).unwrap_or(0);
        return Some(PATH_CONTAINS - idx_i64 * 100 - path_len * 10);
    }
    score_subsequence(&lower_path, normalized_query)
        .map(|sub| SUBSEQUENCE_BASE + sub - path_len * 10)
}

pub fn rank_project_file_paths(paths: &[String], query: &str, limit: usize) -> FileSearchResult {
    let clamped_limit = limit.clamp(1, 500);
    let normalized = query.trim().trim_start_matches('@').to_ascii_lowercase();

    if normalized.is_empty() {
        let mut shallow: Vec<&String> = paths.iter().collect();
        shallow.sort_by(|left, right| {
            let depth_left = left.bytes().filter(|&b| b == b'/').count();
            let depth_right = right.bytes().filter(|&b| b == b'/').count();
            depth_left.cmp(&depth_right).then_with(|| left.cmp(right))
        });
        let total = shallow.len();
        let out: Vec<String> = shallow.into_iter().take(clamped_limit).cloned().collect();
        return FileSearchResult {
            truncated: total > out.len(),
            paths: out,
        };
    }

    let mut scored: Vec<(i64, &String)> = paths
        .iter()
        .filter_map(|p| score_local_project_file_path(p, &normalized).map(|s| (s, p)))
        .collect();
    scored.sort_by(|(score_a, path_a), (score_b, path_b)| {
        score_b.cmp(score_a).then_with(|| path_a.cmp(path_b))
    });
    let total = scored.len();
    let out: Vec<String> = scored
        .into_iter()
        .take(clamped_limit)
        .map(|(_, p)| p.clone())
        .collect();

    FileSearchResult {
        truncated: total > out.len(),
        paths: out,
    }
}

pub fn search_project_files(
    root: &Path,
    query: &str,
    limit: usize,
) -> PortResult<FileSearchResult> {
    let (paths, scan_truncated) =
        collect_project_file_paths(root, MAX_HOST_SEARCH_CANDIDATE_FILES)?;
    let mut res = rank_project_file_paths(&paths, query, limit);
    res.truncated |= scan_truncated;
    Ok(res)
}
