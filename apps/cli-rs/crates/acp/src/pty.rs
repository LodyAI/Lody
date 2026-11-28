use lody_ports::{
    PortError, PortErrorKind, PortResult, PtyPort, SessionId, TERMINAL_MAX_PER_SESSION,
    TerminalAttachReplay, TerminalEventSink, TerminalOpenOutcome, TerminalOpenSpec,
    TerminalOutboundEvent, TerminalSnapshot,
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

const SCROLLBACK_MAX_BYTES: usize = 512 * 1024;
const TITLE_PARSE_TAIL_BYTES: usize = 4096;

const BLOCKED_TERMINAL_ENV_KEYS: [&str; 12] = [
    "ELECTRON_RUN_AS_NODE",
    "LODY_CLI_TOKEN",
    "LODY_AGENT_SESSION_ID",
    "LODY_ELECTRON_BOOTSTRAP",
    "LODY_ELECTRON_SESSION_TOKEN",
    "LODY_GIT_CRED_BROKER_STATE_FILE",
    "LODY_GIT_CRED_BROKER_TOKEN",
    "LODY_GIT_CRED_BROKER_URL",
    "LODY_GIT_CRED_CONTEXT_TOKEN",
    "LODY_MANAGED_GH_TOKEN_SHA256",
    "GH_TOKEN",
    "GITHUB_TOKEN",
];

struct TerminalEntry {
    session_id: SessionId,
    cwd: String,
    title: String,
    scrollback: String,
    title_parse_tail: String,
    master: Box<dyn MasterPty + Send>,
    writer: Option<Box<dyn Write + Send>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

struct PtySharedState {
    records: HashMap<String, TerminalEntry>,
    session_index: HashMap<String, BTreeSet<String>>,
    sinks: BTreeMap<u64, Arc<dyn TerminalEventSink>>,
}

pub struct PortablePtyManager {
    shared: Arc<Mutex<PtySharedState>>,
    next_seq: AtomicU64,
}

impl Default for PortablePtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PortablePtyManager {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Mutex::new(PtySharedState {
                records: HashMap::new(),
                session_index: HashMap::new(),
                sinks: BTreeMap::new(),
            })),
            next_seq: AtomicU64::new(1),
        }
    }
}

fn basename_for_title(cwd: &Path) -> String {
    cwd.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd.to_string_lossy().into_owned())
}

fn append_bounded_utf8(current: &mut String, addition: &str, max_bytes: usize) {
    current.push_str(addition);
    if current.len() <= max_bytes {
        return;
    }
    let mut cut = current.len() - max_bytes;
    while cut < current.len() && !current.is_char_boundary(cut) {
        cut += 1;
    }
    current.drain(..cut);
}

fn extract_latest_osc_title(tail: &str) -> Option<String> {
    let bytes = tail.as_bytes();
    let mut idx = 0usize;
    let mut latest: Option<String> = None;

    while idx + 4 <= bytes.len() {
        if bytes[idx] == 0x1b
            && bytes[idx + 1] == b']'
            && (bytes[idx + 2] == b'0' || bytes[idx + 2] == b'2')
            && bytes[idx + 3] == b';'
        {
            let start = idx + 4;
            let mut cursor = start;
            while cursor < bytes.len() {
                if bytes[cursor] == 0x07 {
                    let candidate = tail[start..cursor].trim();
                    if !candidate.is_empty() {
                        latest = Some(candidate.to_string());
                    }
                    idx = cursor + 1;
                    break;
                }
                if cursor + 1 < bytes.len() && bytes[cursor] == 0x1b && bytes[cursor + 1] == b'\\' {
                    let candidate = tail[start..cursor].trim();
                    if !candidate.is_empty() {
                        latest = Some(candidate.to_string());
                    }
                    idx = cursor + 2;
                    break;
                }
                if bytes[cursor] == 0x1b {
                    break;
                }
                cursor += 1;
            }
            if cursor >= bytes.len() || bytes.get(cursor) == Some(&0x1b) {
                idx += 1;
            }
        } else {
            idx += 1;
        }
    }

    latest
}

fn broadcast_event(sinks: &[Arc<dyn TerminalEventSink>], event: TerminalOutboundEvent) {
    for sink in sinks {
        sink.on_terminal_event(event.clone());
    }
}

fn terminate_entry(mut entry: TerminalEntry) {
    let _ = entry.writer.take();
    let _ = entry.killer.kill();
    #[cfg(unix)]
    if let Some(pid) = entry.pid
        && pid > 0
    {
        let neg_pgid = format!("-{pid}");
        let _ = std::process::Command::new("kill")
            .args(["-HUP", &neg_pgid])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn decode_streaming_utf8(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                out.push_str(valid);
                pending.clear();
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    if let Ok(valid_prefix) = std::str::from_utf8(&pending[..valid_up_to]) {
                        out.push_str(valid_prefix);
                    }
                    pending.drain(..valid_up_to);
                }
                match err.error_len() {
                    Some(invalid_len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..invalid_len);
                    }
                    None => break,
                }
            }
        }
    }
    out
}

impl PtyPort for PortablePtyManager {
    fn list_session_terminals(&self, session_id: &SessionId) -> Vec<TerminalSnapshot> {
        let guard = self.shared.lock().expect("pty lock");
        let Some(ids) = guard.session_index.get(&session_id.0) else {
            return Vec::new();
        };
        ids.iter()
            .filter_map(|tid| {
                let rec = guard.records.get(tid)?;
                Some(TerminalSnapshot {
                    terminal_id: tid.clone(),
                    title: rec.title.clone(),
                    cwd: Some(rec.cwd.clone()),
                })
            })
            .collect()
    }

    fn open_terminal(&self, spec: TerminalOpenSpec) -> PortResult<TerminalOpenOutcome> {
        if !spec.cwd.is_dir() {
            return Err(PortError::new(
                PortErrorKind::NotFound,
                format!("workdir_unavailable:{:?}", spec.cwd),
            ));
        }

        {
            let guard = self.shared.lock().expect("pty lock");
            let current_count = guard
                .session_index
                .get(&spec.session_id.0)
                .map_or(0, BTreeSet::len);
            if current_count >= TERMINAL_MAX_PER_SESSION {
                return Err(PortError::new(
                    PortErrorKind::Conflict,
                    format!("terminal_limit_exceeded:{}", spec.session_id.0),
                ));
            }
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows.max(1),
                cols: spec.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                PortError::new(PortErrorKind::Unavailable, format!("terminal_error:{e}"))
            })?;

        let mut cmd = CommandBuilder::new(&spec.shell_program);
        cmd.args(&spec.shell_args);
        cmd.cwd(&spec.cwd);
        for blocked in BLOCKED_TERMINAL_ENV_KEYS {
            cmd.env_remove(blocked);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            PortError::new(PortErrorKind::Unavailable, format!("terminal_error:{e}"))
        })?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PortError::new(PortErrorKind::Internal, format!("terminal_error:{e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PortError::new(PortErrorKind::Internal, format!("terminal_error:{e}")))?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let terminal_id = format!("term-{}-{seq}", std::process::id());
        let cwd_str = spec.cwd.to_string_lossy().into_owned();
        let initial_title = basename_for_title(&spec.cwd);

        {
            let mut guard = self.shared.lock().expect("pty lock");
            let current_count = guard
                .session_index
                .get(&spec.session_id.0)
                .map_or(0, BTreeSet::len);
            if current_count >= TERMINAL_MAX_PER_SESSION {
                drop(writer);
                let _ = child.kill();
                let _ = child.wait();
                return Err(PortError::new(
                    PortErrorKind::Conflict,
                    format!("terminal_limit_exceeded:{}", spec.session_id.0),
                ));
            }
            guard
                .session_index
                .entry(spec.session_id.0.clone())
                .or_default()
                .insert(terminal_id.clone());
            guard.records.insert(
                terminal_id.clone(),
                TerminalEntry {
                    session_id: spec.session_id,
                    cwd: cwd_str.clone(),
                    title: initial_title,
                    scrollback: String::new(),
                    title_parse_tail: String::new(),
                    master: pair.master,
                    writer: Some(writer),
                    killer,
                    pid,
                },
            );
        }

        let reader_shared = Arc::clone(&self.shared);
        let reader_tid = terminal_id.clone();
        thread::spawn(move || {
            let mut rdr = reader;
            let mut buf = [0u8; 4096];
            let mut utf8_pending = Vec::with_capacity(4);

            loop {
                match rdr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let decoded = decode_streaming_utf8(&mut utf8_pending, &buf[..n]);
                        if decoded.is_empty() {
                            continue;
                        }
                        let (sinks, title_update) = {
                            let mut guard = reader_shared.lock().expect("pty lock");
                            let sinks: Vec<Arc<dyn TerminalEventSink>> =
                                guard.sinks.values().cloned().collect();
                            let mut title_changed = None;
                            if let Some(entry) = guard.records.get_mut(&reader_tid) {
                                append_bounded_utf8(
                                    &mut entry.scrollback,
                                    &decoded,
                                    SCROLLBACK_MAX_BYTES,
                                );
                                append_bounded_utf8(
                                    &mut entry.title_parse_tail,
                                    &decoded,
                                    TITLE_PARSE_TAIL_BYTES,
                                );
                                if let Some(new_title) =
                                    extract_latest_osc_title(&entry.title_parse_tail)
                                    && new_title != entry.title
                                {
                                    entry.title.clone_from(&new_title);
                                    title_changed = Some(new_title);
                                }
                            }
                            (sinks, title_changed)
                        };
                        if let Some(title) = title_update {
                            broadcast_event(
                                &sinks,
                                TerminalOutboundEvent::Title {
                                    terminal_id: reader_tid.clone(),
                                    title,
                                },
                            );
                        }
                        broadcast_event(
                            &sinks,
                            TerminalOutboundEvent::Data {
                                terminal_id: reader_tid.clone(),
                                data: decoded,
                                replay: None,
                            },
                        );
                    }
                }
            }

            let status = child.wait().ok();
            let exit_code = status
                .as_ref()
                .and_then(|s| i32::try_from(s.exit_code()).ok())
                .unwrap_or(-1);
            let signal = status
                .as_ref()
                .and_then(|s| s.signal().map(ToOwned::to_owned));

            let sinks = {
                let mut guard = reader_shared.lock().expect("pty lock");
                if let Some(removed) = guard.records.remove(&reader_tid)
                    && let Some(set) = guard.session_index.get_mut(&removed.session_id.0)
                {
                    set.remove(&reader_tid);
                    if set.is_empty() {
                        guard.session_index.remove(&removed.session_id.0);
                    }
                }
                guard.sinks.values().cloned().collect::<Vec<_>>()
            };

            broadcast_event(
                &sinks,
                TerminalOutboundEvent::Exit {
                    terminal_id: reader_tid,
                    exit_code,
                    signal,
                },
            );
        });

        Ok(TerminalOpenOutcome {
            terminal_id,
            cwd: cwd_str,
        })
    }

    fn attach_terminal(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> PortResult<TerminalAttachReplay> {
        let guard = self.shared.lock().expect("pty lock");
        let entry = guard.records.get(terminal_id).ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotFound,
                format!("terminal_not_found:{terminal_id}"),
            )
        })?;
        let _ = entry.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        });
        Ok(TerminalAttachReplay {
            title: entry.title.clone(),
            scrollback: entry.scrollback.clone(),
        })
    }

    fn write_terminal_input(&self, terminal_id: &str, data: &str) -> PortResult<()> {
        let mut guard = self.shared.lock().expect("pty lock");
        let entry = guard.records.get_mut(terminal_id).ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotFound,
                format!("terminal_not_found:{terminal_id}"),
            )
        })?;
        let Some(writer) = entry.writer.as_mut() else {
            return Err(PortError::new(
                PortErrorKind::Unavailable,
                format!("terminal_not_found:{terminal_id}"),
            ));
        };
        writer
            .write_all(data.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, format!("terminal_error:{e}")))
    }

    fn resize_terminal(&self, terminal_id: &str, cols: u16, rows: u16) -> PortResult<()> {
        let guard = self.shared.lock().expect("pty lock");
        let entry = guard.records.get(terminal_id).ok_or_else(|| {
            PortError::new(
                PortErrorKind::NotFound,
                format!("terminal_not_found:{terminal_id}"),
            )
        })?;
        entry
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PortError::new(PortErrorKind::Internal, format!("terminal_error:{e}")))
    }

    fn close_terminal(&self, terminal_id: &str) -> PortResult<()> {
        let removed = {
            let mut guard = self.shared.lock().expect("pty lock");
            let entry = guard.records.remove(terminal_id);
            if let Some(ref e) = entry
                && let Some(set) = guard.session_index.get_mut(&e.session_id.0)
            {
                set.remove(terminal_id);
                if set.is_empty() {
                    guard.session_index.remove(&e.session_id.0);
                }
            }
            entry
        };
        if let Some(entry) = removed {
            terminate_entry(entry);
        }
        Ok(())
    }

    fn close_session_terminals(&self, session_id: &SessionId) {
        let entries = {
            let mut guard = self.shared.lock().expect("pty lock");
            let Some(ids) = guard.session_index.remove(&session_id.0) else {
                return;
            };
            ids.into_iter()
                .filter_map(|tid| guard.records.remove(&tid))
                .collect::<Vec<_>>()
        };
        for entry in entries {
            terminate_entry(entry);
        }
    }

    fn close_all_terminals(&self) {
        let entries = {
            let mut guard = self.shared.lock().expect("pty lock");
            guard.session_index.clear();
            guard.records.drain().map(|(_, v)| v).collect::<Vec<_>>()
        };
        for entry in entries {
            terminate_entry(entry);
        }
    }

    fn register_sink(&self, sink_id: u64, sink: Arc<dyn TerminalEventSink>) {
        self.shared
            .lock()
            .expect("pty lock")
            .sinks
            .insert(sink_id, sink);
    }

    fn unregister_sink(&self, sink_id: u64) {
        self.shared.lock().expect("pty lock").sinks.remove(&sink_id);
    }
}
