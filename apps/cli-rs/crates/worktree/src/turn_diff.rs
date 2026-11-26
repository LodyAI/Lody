use crate::scan::{
    CODE_COLLAB_MAX_INDEX_BYTES, CODE_COLLAB_MAX_INDEX_ENTRIES, scan_directory_parallel,
};
use fastcdc::v2020::FastCDC;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use lody_ports::{
    DiffCaptureScope, DiffFileEntry, DiffStorePort, PortError, PortErrorKind, PortResult,
    SessionId, TurnDiffCompression, TurnDiffEventInput, TurnDiffSummary, TurnId, WorkspaceId,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

pub const TURN_DIFF_APPLICATION_ID: i32 = 0x4c54_4431;
pub const TURN_DIFF_SCHEMA_VERSION: i32 = 2;

pub const CODEC_RAW: i64 = 0;
pub const CODEC_ZSTD: i64 = 1;
pub const CODEC_GZIP: i64 = 2;

const FASTCDC_MIN_BYTES: usize = 8 * 1024;
const FASTCDC_AVG_BYTES: usize = 32 * 1024;
const FASTCDC_MAX_BYTES: usize = 128 * 1024;

const COMPRESSION_MIN_BYTES: usize = 8 * 1024;
const COMPRESSION_MIN_SAVINGS_BYTES: usize = 64;
const COMPRESSION_LEVEL: u32 = 1;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS: i64 = 100;
const DEFAULT_MAX_STORAGE_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_GC_TARGET_BYTES: u64 = 900 * 1024 * 1024;
const GC_TURN_BATCH_SIZE: i64 = 128;
const GC_VACUUM_PAGE_BATCH_SIZE: i64 = 1024;
const MAX_TRACKED_CAPTURE_FILE_BYTES: u64 = 4 * 1024 * 1024;

const CURRENT_SCHEMA_SQL: &str = "
  CREATE TABLE store_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL CHECK(value >= 0)
  ) WITHOUT ROWID;

  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    order_key TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    evicted INTEGER NOT NULL DEFAULT 0 CHECK(evicted IN (0, 1)),
    UNIQUE(owner_id, turn_key),
    UNIQUE(owner_id, order_key)
  );

  CREATE TABLE chunks (
    hash BLOB PRIMARY KEY CHECK(length(hash) = 32),
    codec INTEGER NOT NULL CHECK(codec IN (0, 1, 2)),
    raw_size INTEGER NOT NULL CHECK(raw_size >= 0),
    payload BLOB NOT NULL,
    ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count >= 0)
  ) WITHOUT ROWID;

  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    content_hash BLOB NOT NULL UNIQUE CHECK(length(content_hash) = 32),
    raw_size INTEGER NOT NULL CHECK(raw_size >= 0),
    ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count >= 0)
  );

  CREATE TABLE snapshot_chunks (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    chunk_hash BLOB NOT NULL REFERENCES chunks(hash),
    raw_size INTEGER NOT NULL CHECK(raw_size >= 0),
    PRIMARY KEY(snapshot_id, ordinal)
  ) WITHOUT ROWID;

  CREATE TABLE turn_files (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    old_snapshot_id INTEGER REFERENCES snapshots(id),
    new_snapshot_id INTEGER REFERENCES snapshots(id),
    add_count INTEGER NOT NULL CHECK(add_count >= 0),
    del_count INTEGER NOT NULL CHECK(del_count >= 0),
    UNIQUE(turn_id, path)
  );

  CREATE TABLE path_heads (
    owner_id TEXT NOT NULL,
    path TEXT NOT NULL,
    snapshot_id INTEGER REFERENCES snapshots(id),
    source_turn_id INTEGER NOT NULL,
    updated_order_key TEXT NOT NULL,
    head_proof INTEGER NOT NULL CHECK(head_proof > 0),
    PRIMARY KEY(owner_id, path)
  ) WITHOUT ROWID;

  CREATE INDEX turns_owner_expiry_idx
    ON turns(owner_id, evicted, expires_at_ms, order_key, id);
  CREATE INDEX turns_evicted_order_idx
    ON turns(evicted, order_key, id);
  CREATE INDEX turn_files_path_idx
    ON turn_files(path, turn_id);
  CREATE INDEX turn_files_old_snapshot_idx
    ON turn_files(old_snapshot_id) WHERE old_snapshot_id IS NOT NULL;
  CREATE INDEX turn_files_new_snapshot_idx
    ON turn_files(new_snapshot_id) WHERE new_snapshot_id IS NOT NULL;
  CREATE INDEX snapshot_chunks_hash_idx
    ON snapshot_chunks(chunk_hash);
  CREATE INDEX path_heads_snapshot_idx
    ON path_heads(snapshot_id) WHERE snapshot_id IS NOT NULL;
  CREATE INDEX path_heads_source_turn_idx
    ON path_heads(source_turn_id);
";

const KNOWN_SCHEMA_OBJECTS: [&str; 18] = [
    "diff_docs",
    "diff_doc_updates",
    "diff_events",
    "diff_events_owner_path_expires_idx",
    "diff_events_owner_expires_idx",
    "diff_doc_updates_doc_created_idx",
    "store_counters",
    "turns",
    "chunks",
    "snapshots",
    "snapshot_chunks",
    "turn_files",
    "path_heads",
    "turns_owner_expiry_idx",
    "turns_evicted_order_idx",
    "turn_files_path_idx",
    "turn_files_old_snapshot_idx",
    "turn_files_new_snapshot_idx",
];

const EXTRA_KNOWN_INDEXES: [&str; 3] = [
    "snapshot_chunks_hash_idx",
    "path_heads_snapshot_idx",
    "path_heads_source_turn_idx",
];

pub fn safe_workspace_segment(workspace_id: &str) -> String {
    let mut safe = String::with_capacity(workspace_id.len().min(80));
    for ch in workspace_id.chars() {
        if safe.len() >= 80 {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            safe.push(ch);
        } else {
            safe.push('_');
        }
    }
    if safe.is_empty() {
        safe.push_str("workspace");
    }
    let digest = Sha256::digest(workspace_id.as_bytes());
    let mut hash_prefix = String::with_capacity(12);
    for b in &digest[..6] {
        let _ = write!(hash_prefix, "{b:02x}");
    }
    format!("{safe}-{hash_prefix}")
}

pub fn workspace_diff_db_path(data_dir: &Path, workspace_id: &str) -> PathBuf {
    data_dir
        .join("code-collab-v2")
        .join(safe_workspace_segment(workspace_id))
        .join("diff-store.sqlite3")
}

pub fn compress_chunk(bytes: &[u8], preference: TurnDiffCompression) -> PortResult<(i64, Vec<u8>)> {
    if bytes.len() < COMPRESSION_MIN_BYTES {
        return Ok((CODEC_RAW, bytes.to_vec()));
    }
    let (codec, compressed) = match preference {
        TurnDiffCompression::Zstd => {
            let encoded =
                zstd::bulk::compress(bytes, i32::try_from(COMPRESSION_LEVEL).unwrap_or(1))
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            (CODEC_ZSTD, encoded)
        }
        TurnDiffCompression::Gzip => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::new(COMPRESSION_LEVEL));
            encoder
                .write_all(bytes)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            let encoded = encoder
                .finish()
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            (CODEC_GZIP, encoded)
        }
    };

    if compressed.len() + COMPRESSION_MIN_SAVINGS_BYTES < bytes.len() {
        Ok((codec, compressed))
    } else {
        Ok((CODEC_RAW, bytes.to_vec()))
    }
}

pub fn decompress_chunk(
    codec: i64,
    payload: &[u8],
    expected_raw_size: usize,
) -> PortResult<Vec<u8>> {
    match codec {
        CODEC_RAW => Ok(payload.to_vec()),
        CODEC_ZSTD => zstd::bulk::decompress(payload, expected_raw_size.max(1))
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string())),
        CODEC_GZIP => {
            let mut decoder = GzDecoder::new(payload);
            let mut out = Vec::with_capacity(expected_raw_size);
            decoder
                .read_to_end(&mut out)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            Ok(out)
        }
        other => Err(PortError::new(
            PortErrorKind::Internal,
            format!("unknown turn-diff chunk codec {other}"),
        )),
    }
}

#[derive(Debug, Clone)]
pub struct TurnDiffStoreConfig {
    pub db_path: PathBuf,
    pub read_only: bool,
    pub retention_days: i64,
    pub max_storage_bytes: u64,
    pub gc_target_bytes: u64,
    pub compression: TurnDiffCompression,
}

impl TurnDiffStoreConfig {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
            read_only: false,
            retention_days: DEFAULT_RETENTION_DAYS,
            max_storage_bytes: DEFAULT_MAX_STORAGE_BYTES,
            gc_target_bytes: DEFAULT_GC_TARGET_BYTES,
            compression: TurnDiffCompression::Gzip,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconstructedSnapshotPair {
    Ready {
        old_text: Option<String>,
        new_text: Option<String>,
    },
    TooLarge {
        raw_bytes: usize,
    },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackedLatestText {
    Tracked { text: Option<String> },
    TooLarge { raw_bytes: usize },
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnDiffGcStats {
    pub deleted_turns: usize,
    pub deleted_snapshots: usize,
    pub deleted_chunks: usize,
    pub blocked_by_live_data: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnDiffIntegrityStats {
    pub turns: i64,
    pub files: i64,
    pub snapshots: i64,
    pub chunks: i64,
    pub invalid_snapshot_ref_counts: i64,
    pub invalid_chunk_ref_counts: i64,
}

#[derive(Clone)]
struct PreparedChunk {
    hash: [u8; 32],
    raw_size: usize,
    encoded: Option<(i64, Vec<u8>)>,
}

#[derive(Clone)]
struct PreparedSnapshot {
    content_hash: [u8; 32],
    raw_size: usize,
    existing_id: Option<i64>,
    chunks: Vec<PreparedChunk>,
}

pub struct SqliteTurnDiffStore {
    cfg: TurnDiffStoreConfig,
    conn: Mutex<Connection>,
}

fn map_sql(err: rusqlite::Error) -> PortError {
    PortError::new(PortErrorKind::Internal, err.to_string())
}

fn is_known_schema_object(name: &str) -> bool {
    KNOWN_SCHEMA_OBJECTS.contains(&name) || EXTRA_KNOWN_INDEXES.contains(&name)
}

fn read_schema_object_names(conn: &Connection) -> PortResult<BTreeSet<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE substr(name, 1, 7) != 'sqlite_' AND sql IS NOT NULL",
        )
        .map_err(map_sql)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(map_sql)?;
    let mut out = BTreeSet::new();
    for item in rows {
        out.insert(item.map_err(map_sql)?);
    }
    Ok(out)
}

fn has_complete_current_objects(names: &BTreeSet<String>) -> bool {
    let required = [
        "store_counters",
        "turns",
        "chunks",
        "snapshots",
        "snapshot_chunks",
        "turn_files",
        "path_heads",
        "turns_owner_expiry_idx",
        "turns_evicted_order_idx",
        "turn_files_path_idx",
        "turn_files_old_snapshot_idx",
        "turn_files_new_snapshot_idx",
        "snapshot_chunks_hash_idx",
        "path_heads_snapshot_idx",
        "path_heads_source_turn_idx",
    ];
    names.len() == required.len() && required.iter().all(|k| names.contains(*k))
}

fn file_size_or_zero(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

impl SqliteTurnDiffStore {
    pub fn open(cfg: TurnDiffStoreConfig) -> PortResult<Self> {
        if cfg.gc_target_bytes >= cfg.max_storage_bytes {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "gcTargetBytes must be smaller than maxStorageBytes",
            ));
        }

        let conn = if cfg.read_only {
            let c = Connection::open_with_flags(
                &cfg.db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(map_sql)?;
            let app_id: i32 = c
                .query_row("PRAGMA application_id", [], |r| r.get(0))
                .map_err(map_sql)?;
            let user_ver: i32 = c
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(map_sql)?;
            let names = read_schema_object_names(&c)?;
            if app_id != TURN_DIFF_APPLICATION_ID
                || user_ver != TURN_DIFF_SCHEMA_VERSION
                || !has_complete_current_objects(&names)
            {
                return Err(PortError::new(
                    PortErrorKind::Conflict,
                    format!(
                        "Turn-diff store {:?} has an unknown SQLite schema and was not modified.",
                        cfg.db_path
                    ),
                ));
            }
            c
        } else {
            if let Some(parent) = cfg.db_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            }
            let mut c = Connection::open(&cfg.db_path).map_err(map_sql)?;
            c.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;")
                .map_err(map_sql)?;
            {
                let tx = c
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(map_sql)?;
                let app_id: i32 = tx
                    .query_row("PRAGMA application_id", [], |r| r.get(0))
                    .map_err(map_sql)?;
                let user_ver: i32 = tx
                    .query_row("PRAGMA user_version", [], |r| r.get(0))
                    .map_err(map_sql)?;
                let names = read_schema_object_names(&tx)?;

                let is_fresh = app_id == 0 && user_ver == 0 && names.is_empty();
                let is_legacy = app_id == 0
                    && user_ver == 0
                    && !names.is_empty()
                    && names.iter().all(|n| is_known_schema_object(n));
                let is_owned = app_id == TURN_DIFF_APPLICATION_ID;

                if !is_fresh && !is_legacy && !is_owned {
                    return Err(PortError::new(
                        PortErrorKind::Conflict,
                        format!(
                            "Turn-diff store {:?} has an unknown SQLite schema and was not modified.",
                            cfg.db_path
                        ),
                    ));
                }
                if is_owned {
                    if names.iter().any(|n| !is_known_schema_object(n)) {
                        return Err(PortError::new(
                            PortErrorKind::Conflict,
                            format!(
                                "Turn-diff store {:?} has an unknown SQLite schema and was not modified.",
                                cfg.db_path
                            ),
                        ));
                    }
                    if !(0..=TURN_DIFF_SCHEMA_VERSION).contains(&user_ver) {
                        return Err(PortError::new(
                            PortErrorKind::Conflict,
                            format!("Unsupported turn-diff store schema version {user_ver}."),
                        ));
                    }
                }

                let has_current = is_owned
                    && user_ver == TURN_DIFF_SCHEMA_VERSION
                    && has_complete_current_objects(&names);
                if !has_current {
                    tx.execute_batch(
                        "DROP TABLE IF EXISTS path_heads;
                         DROP TABLE IF EXISTS turn_files;
                         DROP TABLE IF EXISTS snapshot_chunks;
                         DROP TABLE IF EXISTS snapshots;
                         DROP TABLE IF EXISTS chunks;
                         DROP TABLE IF EXISTS turns;
                         DROP TABLE IF EXISTS store_counters;
                         DROP TABLE IF EXISTS diff_events;
                         DROP TABLE IF EXISTS diff_doc_updates;
                         DROP TABLE IF EXISTS diff_docs;",
                    )
                    .map_err(map_sql)?;
                    tx.execute_batch(CURRENT_SCHEMA_SQL).map_err(map_sql)?;
                }
                tx.execute(
                    "INSERT OR IGNORE INTO store_counters(name, value) VALUES ('head_proof', 0)",
                    [],
                )
                .map_err(map_sql)?;
                tx.execute_batch(&format!(
                    "PRAGMA application_id = {TURN_DIFF_APPLICATION_ID};
                     PRAGMA user_version = {TURN_DIFF_SCHEMA_VERSION};"
                ))
                .map_err(map_sql)?;
                tx.commit().map_err(map_sql)?;
            }

            let auto_vac: i64 = c
                .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
                .map_err(map_sql)?;
            if auto_vac != 2 {
                c.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")
                    .map_err(map_sql)?;
            }
            c.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = FULL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA wal_autocheckpoint = 1000;",
            )
            .map_err(map_sql)?;
            c
        };

        Ok(Self {
            cfg,
            conn: Mutex::new(conn),
        })
    }

    pub fn allocate_head_proof(&self) -> PortResult<i64> {
        if self.cfg.read_only {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                "Turn-diff store is read-only.",
            ));
        }
        let mut conn = self.conn.lock().expect("turn-diff lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql)?;
        let next: i64 = tx
            .query_row(
                "UPDATE store_counters SET value = value + 1
                 WHERE name = 'head_proof' RETURNING value",
                [],
                |r| r.get(0),
            )
            .map_err(map_sql)?;
        tx.commit().map_err(map_sql)?;
        Ok(next)
    }

    pub fn record_turn(
        &self,
        owner_id: &str,
        turn_id: &str,
        order_key: Option<&str>,
        captured_at_ms: i64,
        recorded_at_ms: i64,
        events: &[TurnDiffEventInput],
    ) -> PortResult<Vec<DiffFileEntry>> {
        if self.cfg.read_only {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                "Turn-diff store is read-only.",
            ));
        }
        if owner_id.is_empty() || turn_id.is_empty() {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "owner_id and turn_id must be non-empty",
            ));
        }

        let mut seen_paths = HashSet::with_capacity(events.len());
        for ev in events {
            if ev.path.is_empty() || ev.path.contains('\0') {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "Turn-diff paths must be non-empty and contain no NUL.",
                ));
            }
            if !seen_paths.insert(ev.path.as_str()) {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    format!("duplicate turn-diff path {}", ev.path),
                ));
            }
            if (ev.new_is_current && ev.head_proof.is_none_or(|p| p <= 0))
                || (!ev.new_is_current && ev.head_proof.is_some())
            {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    format!("headProof mismatch for {}", ev.path),
                ));
            }
        }

        let resolved_order_key = match order_key {
            Some(explicit) => explicit.to_string(),
            None => format!("{captured_at_ms:016}:{turn_id}"),
        };
        let expires_at_ms = captured_at_ms.saturating_add(self.cfg.retention_days * DAY_MS);

        let mut conn = self.conn.lock().expect("turn-diff lock");

        let existing_turn: Option<(i64, i64, i64)> = conn
            .query_row(
                "SELECT id, expires_at_ms, evicted FROM turns WHERE owner_id = ?1 AND turn_key = ?2",
                params![owner_id, turn_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(map_sql)?;

        if let Some((_, exp, evicted)) = existing_turn {
            if evicted != 0 || exp <= recorded_at_ms {
                return Ok(Vec::new());
            }
        } else if expires_at_ms <= recorded_at_ms {
            return Ok(Vec::new());
        }

        let mut existing_paths = HashSet::new();
        if let Some((tid, _, _)) = existing_turn {
            let mut stmt = conn
                .prepare("SELECT path FROM turn_files WHERE turn_id = ?1")
                .map_err(map_sql)?;
            let rows = stmt
                .query_map(params![tid], |r| r.get::<_, String>(0))
                .map_err(map_sql)?;
            for item in rows {
                existing_paths.insert(item.map_err(map_sql)?);
            }
        }

        let pending: Vec<&TurnDiffEventInput> = events
            .iter()
            .filter(|ev| !existing_paths.contains(&ev.path))
            .collect();

        if !pending.is_empty() {
            let mut snapshot_cache: HashMap<[u8; 32], PreparedSnapshot> = HashMap::new();
            let mut chunk_cache: HashMap<[u8; 32], PreparedChunk> = HashMap::new();
            let mut prepared_rows = Vec::with_capacity(pending.len());

            for ev in pending {
                let old_prep = prepare_snapshot(
                    &conn,
                    ev.old_text.as_deref(),
                    self.cfg.compression,
                    &mut snapshot_cache,
                    &mut chunk_cache,
                )?;
                let new_prep = prepare_snapshot(
                    &conn,
                    ev.new_text.as_deref(),
                    self.cfg.compression,
                    &mut snapshot_cache,
                    &mut chunk_cache,
                )?;
                prepared_rows.push((ev, old_prep, new_prep));
            }

            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql)?;

            tx.execute(
                "INSERT INTO turns(owner_id, turn_key, order_key, captured_at_ms, expires_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(owner_id, turn_key) DO NOTHING",
                params![
                    owner_id,
                    turn_id,
                    &resolved_order_key,
                    captured_at_ms,
                    expires_at_ms
                ],
            )
            .map_err(map_sql)?;

            let (turn_row_id, stored_order_key, stored_exp, stored_evicted): (
                i64,
                String,
                i64,
                i64,
            ) = tx
                .query_row(
                    "SELECT id, order_key, expires_at_ms, evicted
                     FROM turns WHERE owner_id = ?1 AND turn_key = ?2",
                    params![owner_id, turn_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .map_err(map_sql)?;

            if stored_evicted == 0 && stored_exp > recorded_at_ms {
                let mut materialized: HashMap<[u8; 32], i64> = HashMap::new();
                let mut released_snapshots: BTreeSet<i64> = BTreeSet::new();

                for (ev, old_prep, new_prep) in prepared_rows {
                    let already: Option<i64> = tx
                        .query_row(
                            "SELECT id FROM turn_files WHERE turn_id = ?1 AND path = ?2",
                            params![turn_row_id, &ev.path],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(map_sql)?;
                    if already.is_some() {
                        continue;
                    }

                    let old_sid = materialize_snapshot(&tx, old_prep.as_ref(), &mut materialized)?;
                    let new_sid = materialize_snapshot(&tx, new_prep.as_ref(), &mut materialized)?;

                    tx.execute(
                        "INSERT INTO turn_files(
                           turn_id, path, old_snapshot_id, new_snapshot_id, add_count, del_count
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            turn_row_id,
                            &ev.path,
                            old_sid,
                            new_sid,
                            i64::from(ev.additions),
                            i64::from(ev.deletions),
                        ],
                    )
                    .map_err(map_sql)?;

                    change_snapshot_ref(&tx, old_sid, 1)?;
                    change_snapshot_ref(&tx, new_sid, 1)?;

                    if ev.new_is_current
                        && let Some(proof) = ev.head_proof
                        && let Some(released) = update_path_head(
                            &tx,
                            owner_id,
                            &ev.path,
                            new_sid,
                            turn_row_id,
                            &stored_order_key,
                            proof,
                        )?
                    {
                        released_snapshots.insert(released);
                    }
                }

                delete_unreferenced_snapshots_and_chunks(&tx, released_snapshots)?;
            }

            tx.commit().map_err(map_sql)?;
        }

        query_turn_files(&conn, owner_id, turn_id, recorded_at_ms)
    }

    pub fn list_turn_files(
        &self,
        owner_id: &str,
        turn_id: &str,
        now_ms: i64,
    ) -> PortResult<Vec<DiffFileEntry>> {
        let conn = self.conn.lock().expect("turn-diff lock");
        query_turn_files(&conn, owner_id, turn_id, now_ms)
    }

    pub fn get_turn_snapshot(
        &self,
        owner_id: &str,
        turn_id: &str,
        path: &str,
        now_ms: i64,
        max_raw_bytes: Option<usize>,
    ) -> PortResult<ReconstructedSnapshotPair> {
        let conn = self.conn.lock().expect("turn-diff lock");
        let row: Option<(Option<i64>, Option<i64>, i64, i64)> = conn
            .query_row(
                "SELECT tf.old_snapshot_id, tf.new_snapshot_id,
                        COALESCE(os.raw_size, 0), COALESCE(ns.raw_size, 0)
                 FROM turn_files AS tf
                 JOIN turns AS t ON t.id = tf.turn_id
                 LEFT JOIN snapshots AS os ON os.id = tf.old_snapshot_id
                 LEFT JOIN snapshots AS ns ON ns.id = tf.new_snapshot_id
                 WHERE t.owner_id = ?1 AND t.turn_key = ?2 AND t.evicted = 0
                   AND tf.path = ?3 AND t.expires_at_ms > ?4
                 LIMIT 1",
                params![owner_id, turn_id, path, now_ms],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(map_sql)?;

        let Some((old_sid, new_sid, old_sz, new_sz)) = row else {
            return Ok(ReconstructedSnapshotPair::Unavailable);
        };
        let total = usize::try_from(old_sz.saturating_add(new_sz)).unwrap_or(usize::MAX);
        if let Some(limit) = max_raw_bytes
            && total > limit
        {
            return Ok(ReconstructedSnapshotPair::TooLarge { raw_bytes: total });
        }

        let old_text = match old_sid {
            Some(id) => Some(read_snapshot_utf8(&conn, id)?),
            None => None,
        };
        let new_text = match new_sid {
            Some(id) => Some(read_snapshot_utf8(&conn, id)?),
            None => None,
        };
        Ok(ReconstructedSnapshotPair::Ready { old_text, new_text })
    }

    pub fn get_latest_text(
        &self,
        owner_id: &str,
        path: &str,
        max_raw_bytes: Option<usize>,
    ) -> PortResult<TrackedLatestText> {
        let conn = self.conn.lock().expect("turn-diff lock");
        let row: Option<(Option<i64>, i64)> = conn
            .query_row(
                "SELECT ph.snapshot_id, COALESCE(s.raw_size, 0)
                 FROM path_heads AS ph
                 LEFT JOIN snapshots AS s ON s.id = ph.snapshot_id
                 WHERE ph.owner_id = ?1 AND ph.path = ?2",
                params![owner_id, path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(map_sql)?;

        let Some((sid, raw_sz)) = row else {
            return Ok(TrackedLatestText::Untracked);
        };
        let raw_bytes = usize::try_from(raw_sz).unwrap_or(usize::MAX);
        if let Some(limit) = max_raw_bytes
            && raw_bytes > limit
        {
            return Ok(TrackedLatestText::TooLarge { raw_bytes });
        }
        let text = match sid {
            Some(id) => Some(read_snapshot_utf8(&conn, id)?),
            None => None,
        };
        Ok(TrackedLatestText::Tracked { text })
    }

    pub fn gc(&self, now_ms: i64) -> PortResult<TurnDiffGcStats> {
        if self.cfg.read_only {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                "Turn-diff store is read-only.",
            ));
        }
        let mut conn = self.conn.lock().expect("turn-diff lock");
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let size_gc_triggered = self.total_storage_bytes() > self.cfg.max_storage_bytes;

        let mut deleted_turns = 0usize;
        let mut deleted_snapshots = 0usize;
        let mut deleted_chunks = 0usize;

        loop {
            let expired_ids = select_turn_batch(
                &conn,
                "SELECT id FROM turns WHERE expires_at_ms <= ?1 ORDER BY id ASC LIMIT ?2",
                params![now_ms, GC_TURN_BATCH_SIZE],
            )?;
            if expired_ids.is_empty() {
                break;
            }
            let (snaps, chks) = remove_or_evict_turns(&mut conn, &expired_ids, false)?;
            deleted_turns += expired_ids.len();
            deleted_snapshots += snaps;
            deleted_chunks += chks;
        }

        if size_gc_triggered {
            while self.estimated_compacted_bytes(&conn)? > self.cfg.gc_target_bytes {
                let oldest_ids = select_turn_batch(
                    &conn,
                    "SELECT id FROM turns
                     WHERE evicted = 0
                       AND id != (
                         SELECT id FROM turns WHERE evicted = 0
                         ORDER BY order_key DESC, id DESC LIMIT 1
                       )
                     ORDER BY order_key ASC, id ASC
                     LIMIT ?1",
                    params![GC_TURN_BATCH_SIZE],
                )?;
                if oldest_ids.is_empty() {
                    break;
                }
                let (snaps, chks) = remove_or_evict_turns(&mut conn, &oldest_ids, true)?;
                deleted_turns += oldest_ids.len();
                deleted_snapshots += snaps;
                deleted_chunks += chks;
            }

            while self.estimated_compacted_bytes(&conn)? > self.cfg.gc_target_bytes {
                let heads = select_deletable_heads(&conn, GC_TURN_BATCH_SIZE)?;
                if heads.is_empty() {
                    break;
                }
                let (snaps, chks) = delete_path_heads_batch(&mut conn, &heads)?;
                deleted_snapshots += snaps;
                deleted_chunks += chks;
            }
        }

        loop {
            let free_pages: i64 = conn
                .query_row("PRAGMA freelist_count", [], |r| r.get(0))
                .map_err(map_sql)?;
            if free_pages <= 0 {
                break;
            }
            let step = free_pages.min(GC_VACUUM_PAGE_BATCH_SIZE);
            conn.execute_batch(&format!("PRAGMA incremental_vacuum({step});"))
                .map_err(map_sql)?;
        }

        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let after_bytes = self.total_storage_bytes();
        Ok(TurnDiffGcStats {
            deleted_turns,
            deleted_snapshots,
            deleted_chunks,
            blocked_by_live_data: size_gc_triggered && after_bytes > self.cfg.gc_target_bytes,
        })
    }

    pub fn stats(&self) -> PortResult<TurnDiffIntegrityStats> {
        let conn = self.conn.lock().expect("turn-diff lock");
        conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM turns WHERE evicted = 0),
               (SELECT COUNT(*) FROM turn_files),
               (SELECT COUNT(*) FROM snapshots),
               (SELECT COUNT(*) FROM chunks),
               (SELECT COUNT(*) FROM snapshots AS s WHERE s.ref_count != (
                  (SELECT COUNT(*) FROM turn_files WHERE old_snapshot_id = s.id) +
                  (SELECT COUNT(*) FROM turn_files WHERE new_snapshot_id = s.id) +
                  (SELECT COUNT(*) FROM path_heads WHERE snapshot_id = s.id)
               )),
               (SELECT COUNT(*) FROM chunks AS c WHERE c.ref_count != (
                  SELECT COUNT(*) FROM snapshot_chunks WHERE chunk_hash = c.hash
               ))",
            [],
            |r| {
                Ok(TurnDiffIntegrityStats {
                    turns: r.get(0)?,
                    files: r.get(1)?,
                    snapshots: r.get(2)?,
                    chunks: r.get(3)?,
                    invalid_snapshot_ref_counts: r.get(4)?,
                    invalid_chunk_ref_counts: r.get(5)?,
                })
            },
        )
        .map_err(map_sql)
    }

    fn total_storage_bytes(&self) -> u64 {
        let wal = PathBuf::from(format!("{}-wal", self.cfg.db_path.to_string_lossy()));
        let shm = PathBuf::from(format!("{}-shm", self.cfg.db_path.to_string_lossy()));
        file_size_or_zero(&self.cfg.db_path) + file_size_or_zero(&wal) + file_size_or_zero(&shm)
    }

    fn estimated_compacted_bytes(&self, conn: &Connection) -> PortResult<u64> {
        let page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .map_err(map_sql)?;
        let free_pages: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .map_err(map_sql)?;
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .map_err(map_sql)?;
        let shm = PathBuf::from(format!("{}-shm", self.cfg.db_path.to_string_lossy()));
        let active_bytes = u64::try_from(page_count.saturating_sub(free_pages).max(0))
            .unwrap_or(0)
            .saturating_mul(u64::try_from(page_size.max(0)).unwrap_or(4096));
        Ok(active_bytes + file_size_or_zero(&shm))
    }
}

fn prepare_snapshot(
    conn: &Connection,
    text: Option<&str>,
    compression: TurnDiffCompression,
    snapshot_cache: &mut HashMap<[u8; 32], PreparedSnapshot>,
    chunk_cache: &mut HashMap<[u8; 32], PreparedChunk>,
) -> PortResult<Option<PreparedSnapshot>> {
    let Some(raw_str) = text else {
        return Ok(None);
    };
    let bytes = raw_str.as_bytes();
    let content_hash: [u8; 32] = Sha256::digest(bytes).into();
    if let Some(cached) = snapshot_cache.get(&content_hash) {
        return Ok(Some(cached.clone()));
    }

    let existing: Option<(i64, i64)> = conn
        .query_row(
            "SELECT id, raw_size FROM snapshots WHERE content_hash = ?1",
            params![content_hash.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(map_sql)?;

    if let Some((sid, stored_sz)) = existing {
        if usize::try_from(stored_sz).ok() != Some(bytes.len()) {
            return Err(PortError::new(
                PortErrorKind::Internal,
                "SHA-256 snapshot collision detected",
            ));
        }
        let prepared = PreparedSnapshot {
            content_hash,
            raw_size: bytes.len(),
            existing_id: Some(sid),
            chunks: Vec::new(),
        };
        snapshot_cache.insert(content_hash, prepared.clone());
        return Ok(Some(prepared));
    }

    let mut chunks = Vec::new();
    if !bytes.is_empty() {
        let chunker = FastCDC::new(
            bytes,
            FASTCDC_MIN_BYTES,
            FASTCDC_AVG_BYTES,
            FASTCDC_MAX_BYTES,
        );
        for boundary in chunker {
            let slice = &bytes[boundary.offset..boundary.offset + boundary.length];
            let ch_hash: [u8; 32] = Sha256::digest(slice).into();
            if let Some(cached_ch) = chunk_cache.get(&ch_hash) {
                chunks.push(cached_ch.clone());
                continue;
            }
            let stored_chunk: Option<i64> = conn
                .query_row(
                    "SELECT raw_size FROM chunks WHERE hash = ?1",
                    params![ch_hash.as_slice()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(map_sql)?;
            let prep_ch = if let Some(sz) = stored_chunk {
                if usize::try_from(sz).ok() != Some(slice.len()) {
                    return Err(PortError::new(
                        PortErrorKind::Internal,
                        "SHA-256 chunk collision detected",
                    ));
                }
                PreparedChunk {
                    hash: ch_hash,
                    raw_size: slice.len(),
                    encoded: None,
                }
            } else {
                let encoded = compress_chunk(slice, compression)?;
                PreparedChunk {
                    hash: ch_hash,
                    raw_size: slice.len(),
                    encoded: Some(encoded),
                }
            };
            chunk_cache.insert(ch_hash, prep_ch.clone());
            chunks.push(prep_ch);
        }
    }

    let prepared = PreparedSnapshot {
        content_hash,
        raw_size: bytes.len(),
        existing_id: None,
        chunks,
    };
    snapshot_cache.insert(content_hash, prepared.clone());
    Ok(Some(prepared))
}

fn materialize_snapshot(
    tx: &rusqlite::Transaction<'_>,
    prepared: Option<&PreparedSnapshot>,
    materialized: &mut HashMap<[u8; 32], i64>,
) -> PortResult<Option<i64>> {
    let Some(snap) = prepared else {
        return Ok(None);
    };
    if let Some(&id) = materialized.get(&snap.content_hash) {
        return Ok(Some(id));
    }
    if let Some(existing_id) = snap.existing_id {
        materialized.insert(snap.content_hash, existing_id);
        return Ok(Some(existing_id));
    }

    if let Some((existing_id, _)) = tx
        .query_row(
            "SELECT id, raw_size FROM snapshots WHERE content_hash = ?1",
            params![snap.content_hash.as_slice()],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(map_sql)?
    {
        materialized.insert(snap.content_hash, existing_id);
        return Ok(Some(existing_id));
    }

    let raw_sz_i64 = i64::try_from(snap.raw_size)
        .map_err(|_| PortError::new(PortErrorKind::InvalidInput, "snapshot too large"))?;
    tx.execute(
        "INSERT INTO snapshots(content_hash, raw_size, ref_count) VALUES (?1, ?2, 0)",
        params![snap.content_hash.as_slice(), raw_sz_i64],
    )
    .map_err(map_sql)?;
    let snapshot_id = tx.last_insert_rowid();

    for (ordinal, ch) in snap.chunks.iter().enumerate() {
        let ch_sz_i64 = i64::try_from(ch.raw_size).unwrap_or(0);
        if let Some((codec, payload)) = &ch.encoded {
            tx.execute(
                "INSERT INTO chunks(hash, codec, raw_size, payload, ref_count)
                 VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT(hash) DO NOTHING",
                params![ch.hash.as_slice(), codec, ch_sz_i64, payload.as_slice()],
            )
            .map_err(map_sql)?;
        }
        tx.execute(
            "INSERT INTO snapshot_chunks(snapshot_id, ordinal, chunk_hash, raw_size)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                snapshot_id,
                i64::try_from(ordinal).unwrap_or(0),
                ch.hash.as_slice(),
                ch_sz_i64
            ],
        )
        .map_err(map_sql)?;
        tx.execute(
            "UPDATE chunks SET ref_count = ref_count + 1 WHERE hash = ?1",
            params![ch.hash.as_slice()],
        )
        .map_err(map_sql)?;
    }

    materialized.insert(snap.content_hash, snapshot_id);
    Ok(Some(snapshot_id))
}

fn change_snapshot_ref(
    tx: &rusqlite::Transaction<'_>,
    snapshot_id: Option<i64>,
    delta: i64,
) -> PortResult<()> {
    let Some(sid) = snapshot_id else {
        return Ok(());
    };
    if delta == 0 {
        return Ok(());
    }
    tx.execute(
        "UPDATE snapshots SET ref_count = ref_count + ?1 WHERE id = ?2",
        params![delta, sid],
    )
    .map_err(map_sql)?;
    Ok(())
}

fn update_path_head(
    tx: &rusqlite::Transaction<'_>,
    owner_id: &str,
    path: &str,
    new_snapshot_id: Option<i64>,
    source_turn_id: i64,
    order_key: &str,
    head_proof: i64,
) -> PortResult<Option<i64>> {
    let previous: Option<(Option<i64>, i64, String, i64)> = tx
        .query_row(
            "SELECT snapshot_id, source_turn_id, updated_order_key, head_proof
             FROM path_heads WHERE owner_id = ?1 AND path = ?2",
            params![owner_id, path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(map_sql)?;

    if let Some((_, _, _, prev_proof)) = &previous
        && head_proof <= *prev_proof
    {
        return Ok(None);
    }

    let (next_source_turn, next_order_key, prev_sid) = match previous {
        Some((prev_sid, prev_turn, prev_order, _)) => {
            if prev_sid == new_snapshot_id && prev_order.as_str() > order_key {
                (prev_turn, prev_order, prev_sid)
            } else {
                (source_turn_id, order_key.to_string(), prev_sid)
            }
        }
        None => (source_turn_id, order_key.to_string(), None),
    };

    let released = if prev_sid != new_snapshot_id {
        change_snapshot_ref(tx, prev_sid, -1)?;
        change_snapshot_ref(tx, new_snapshot_id, 1)?;
        prev_sid
    } else {
        None
    };

    tx.execute(
        "INSERT INTO path_heads(
           owner_id, path, snapshot_id, source_turn_id, updated_order_key, head_proof
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(owner_id, path) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           source_turn_id = excluded.source_turn_id,
           updated_order_key = excluded.updated_order_key,
           head_proof = excluded.head_proof",
        params![
            owner_id,
            path,
            new_snapshot_id,
            next_source_turn,
            &next_order_key,
            head_proof
        ],
    )
    .map_err(map_sql)?;

    Ok(released)
}

fn delete_unreferenced_snapshots_and_chunks<I>(
    tx: &rusqlite::Transaction<'_>,
    candidates: I,
) -> PortResult<(usize, usize)>
where
    I: IntoIterator<Item = i64>,
{
    let unique_ids: BTreeSet<i64> = candidates.into_iter().collect();
    let mut deleted_snapshots = 0usize;
    let mut deleted_chunks = 0usize;

    for sid in unique_ids {
        let unref: Option<i64> = tx
            .query_row(
                "SELECT id FROM snapshots WHERE id = ?1 AND ref_count = 0",
                params![sid],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql)?;
        if unref.is_none() {
            continue;
        }

        let chunk_refs: Vec<(Vec<u8>, i64)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT chunk_hash, COUNT(*) FROM snapshot_chunks
                     WHERE snapshot_id = ?1 GROUP BY chunk_hash",
                )
                .map_err(map_sql)?;
            let rows = stmt
                .query_map(params![sid], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(map_sql)?;
            let mut list = Vec::new();
            for item in rows {
                list.push(item.map_err(map_sql)?);
            }
            list
        };

        for (hash, count) in &chunk_refs {
            tx.execute(
                "UPDATE chunks SET ref_count = ref_count - ?1 WHERE hash = ?2",
                params![count, hash.as_slice()],
            )
            .map_err(map_sql)?;
        }

        let removed_snap = tx
            .execute(
                "DELETE FROM snapshots WHERE id = ?1 AND ref_count = 0",
                params![sid],
            )
            .map_err(map_sql)?;
        deleted_snapshots += removed_snap;

        for (hash, _) in &chunk_refs {
            let removed_ch = tx
                .execute(
                    "DELETE FROM chunks WHERE hash = ?1 AND ref_count = 0",
                    params![hash.as_slice()],
                )
                .map_err(map_sql)?;
            deleted_chunks += removed_ch;
        }
    }

    Ok((deleted_snapshots, deleted_chunks))
}

fn read_snapshot_utf8(conn: &Connection, snapshot_id: i64) -> PortResult<String> {
    let (expected_hash, raw_sz): (Vec<u8>, i64) = conn
        .query_row(
            "SELECT content_hash, raw_size FROM snapshots WHERE id = ?1",
            params![snapshot_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(map_sql)?;

    let expected_len = usize::try_from(raw_sz).unwrap_or(0);
    let mut output = Vec::with_capacity(expected_len);

    let mut stmt = conn
        .prepare(
            "SELECT c.codec, sc.raw_size, c.payload
             FROM snapshot_chunks AS sc
             JOIN chunks AS c ON c.hash = sc.chunk_hash
             WHERE sc.snapshot_id = ?1
             ORDER BY sc.ordinal ASC",
        )
        .map_err(map_sql)?;
    let rows = stmt
        .query_map(params![snapshot_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(map_sql)?;

    for item in rows {
        let (codec, ch_raw_sz, payload) = item.map_err(map_sql)?;
        let expected_chunk_len = usize::try_from(ch_raw_sz).unwrap_or(0);
        let decoded = decompress_chunk(codec, &payload, expected_chunk_len)?;
        if decoded.len() != expected_chunk_len {
            return Err(PortError::new(
                PortErrorKind::Internal,
                format!("turn-diff chunk size mismatch in snapshot {snapshot_id}"),
            ));
        }
        output.extend_from_slice(&decoded);
    }

    if output.len() != expected_len {
        return Err(PortError::new(
            PortErrorKind::Internal,
            format!("turn-diff snapshot {snapshot_id} reconstructed wrong byte length"),
        ));
    }

    let actual_hash = Sha256::digest(&output);
    if actual_hash.as_slice() != expected_hash.as_slice() {
        return Err(PortError::new(
            PortErrorKind::Internal,
            format!("turn-diff snapshot {snapshot_id} SHA-256 verification failed"),
        ));
    }

    String::from_utf8(output).map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
}

fn query_turn_files(
    conn: &Connection,
    owner_id: &str,
    turn_id: &str,
    now_ms: i64,
) -> PortResult<Vec<DiffFileEntry>> {
    let mut stmt = conn
        .prepare(
            "SELECT tf.path, tf.old_snapshot_id, tf.new_snapshot_id, tf.add_count, tf.del_count
             FROM turn_files AS tf
             JOIN turns AS t ON t.id = tf.turn_id
             WHERE t.owner_id = ?1 AND t.turn_key = ?2 AND t.evicted = 0 AND t.expires_at_ms > ?3
             ORDER BY tf.path ASC",
        )
        .map_err(map_sql)?;
    let rows = stmt
        .query_map(params![owner_id, turn_id, now_ms], |r| {
            let path: String = r.get(0)?;
            let old_sid: Option<i64> = r.get(1)?;
            let new_sid: Option<i64> = r.get(2)?;
            let add_count: i64 = r.get(3)?;
            let del_count: i64 = r.get(4)?;
            let status = match (old_sid, new_sid) {
                (None, Some(_)) => "added",
                (Some(_), None) => "deleted",
                _ => "modified",
            };
            Ok(DiffFileEntry {
                relative_path: path,
                status: status.to_string(),
                additions: u32::try_from(add_count.max(0)).unwrap_or(0),
                deletions: u32::try_from(del_count.max(0)).unwrap_or(0),
            })
        })
        .map_err(map_sql)?;

    let mut out = Vec::new();
    for item in rows {
        out.push(item.map_err(map_sql)?);
    }
    Ok(out)
}

fn select_turn_batch<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params_in: P,
) -> PortResult<Vec<i64>> {
    let mut stmt = conn.prepare(sql).map_err(map_sql)?;
    let rows = stmt
        .query_map(params_in, |r| r.get::<_, i64>(0))
        .map_err(map_sql)?;
    let mut ids = Vec::new();
    for item in rows {
        ids.push(item.map_err(map_sql)?);
    }
    Ok(ids)
}

fn remove_or_evict_turns(
    conn: &mut Connection,
    turn_ids: &[i64],
    evict_only: bool,
) -> PortResult<(usize, usize)> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sql)?;
    let mut snap_decrements: BTreeMap<i64, i64> = BTreeMap::new();

    for &tid in turn_ids {
        let mut stmt = tx
            .prepare("SELECT old_snapshot_id, new_snapshot_id FROM turn_files WHERE turn_id = ?1")
            .map_err(map_sql)?;
        let rows = stmt
            .query_map(params![tid], |r| {
                Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?))
            })
            .map_err(map_sql)?;
        for item in rows {
            let (old_sid, new_sid) = item.map_err(map_sql)?;
            if let Some(id) = old_sid {
                *snap_decrements.entry(id).or_insert(0) += 1;
            }
            if let Some(id) = new_sid {
                *snap_decrements.entry(id).or_insert(0) += 1;
            }
        }
    }

    for (&sid, &count) in &snap_decrements {
        change_snapshot_ref(&tx, Some(sid), -count)?;
    }

    for &tid in turn_ids {
        if evict_only {
            tx.execute("DELETE FROM turn_files WHERE turn_id = ?1", params![tid])
                .map_err(map_sql)?;
            tx.execute("UPDATE turns SET evicted = 1 WHERE id = ?1", params![tid])
                .map_err(map_sql)?;
        } else {
            tx.execute("DELETE FROM turns WHERE id = ?1", params![tid])
                .map_err(map_sql)?;
        }
    }

    let res = delete_unreferenced_snapshots_and_chunks(&tx, snap_decrements.into_keys())?;
    tx.commit().map_err(map_sql)?;
    Ok(res)
}

struct DeletableHead {
    owner_id: String,
    path: String,
    snapshot_id: Option<i64>,
    source_turn_id: i64,
    head_proof: i64,
}

fn select_deletable_heads(conn: &Connection, limit: i64) -> PortResult<Vec<DeletableHead>> {
    let mut stmt = conn
        .prepare(
            "SELECT owner_id, path, snapshot_id, source_turn_id, head_proof
             FROM path_heads
             WHERE source_turn_id IS NOT (
               SELECT id FROM turns WHERE evicted = 0
               ORDER BY order_key DESC, id DESC LIMIT 1
             )
             ORDER BY head_proof ASC, source_turn_id ASC, owner_id ASC, path ASC
             LIMIT ?1",
        )
        .map_err(map_sql)?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(DeletableHead {
                owner_id: r.get(0)?,
                path: r.get(1)?,
                snapshot_id: r.get(2)?,
                source_turn_id: r.get(3)?,
                head_proof: r.get(4)?,
            })
        })
        .map_err(map_sql)?;
    let mut out = Vec::new();
    for item in rows {
        out.push(item.map_err(map_sql)?);
    }
    Ok(out)
}

fn delete_path_heads_batch(
    conn: &mut Connection,
    heads: &[DeletableHead],
) -> PortResult<(usize, usize)> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sql)?;
    let mut snap_decrements: BTreeMap<i64, i64> = BTreeMap::new();

    for h in heads {
        let removed = tx
            .execute(
                "DELETE FROM path_heads
                 WHERE owner_id = ?1 AND path = ?2 AND source_turn_id = ?3
                   AND head_proof = ?4 AND snapshot_id IS ?5",
                params![
                    &h.owner_id,
                    &h.path,
                    h.source_turn_id,
                    h.head_proof,
                    h.snapshot_id
                ],
            )
            .map_err(map_sql)?;
        if removed == 1
            && let Some(sid) = h.snapshot_id
        {
            *snap_decrements.entry(sid).or_insert(0) += 1;
        }
    }

    for (&sid, &count) in &snap_decrements {
        change_snapshot_ref(&tx, Some(sid), -count)?;
    }

    let res = delete_unreferenced_snapshots_and_chunks(&tx, snap_decrements.into_keys())?;
    tx.commit().map_err(map_sql)?;
    Ok(res)
}

pub fn compute_line_diff_counts(old_text: Option<&str>, new_text: Option<&str>) -> (u32, u32) {
    match (old_text, new_text) {
        (None, None) => (0, 0),
        (None, Some(added)) => (count_lines(added), 0),
        (Some(removed), None) => (0, count_lines(removed)),
        (Some(old_s), Some(new_s)) => {
            if old_s == new_s {
                return (0, 0);
            }
            let old_lines: Vec<&str> = old_s.lines().collect();
            let new_lines: Vec<&str> = new_s.lines().collect();
            let mut prefix = 0usize;
            while prefix < old_lines.len()
                && prefix < new_lines.len()
                && old_lines[prefix] == new_lines[prefix]
            {
                prefix += 1;
            }
            let mut old_end = old_lines.len();
            let mut new_end = new_lines.len();
            while old_end > prefix
                && new_end > prefix
                && old_lines[old_end - 1] == new_lines[new_end - 1]
            {
                old_end -= 1;
                new_end -= 1;
            }
            (
                u32::try_from(new_end - prefix).unwrap_or(u32::MAX),
                u32::try_from(old_end - prefix).unwrap_or(u32::MAX),
            )
        }
    }
}

fn count_lines(text: &str) -> u32 {
    if text.is_empty() {
        0
    } else {
        u32::try_from(text.lines().count()).unwrap_or(u32::MAX)
    }
}

fn read_utf8_if_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_TRACKED_CAPTURE_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn read_git_revision_file(workdir: &Path, rev: &str, rel_path: &str) -> Option<String> {
    let spec = format!("{rev}:{rel_path}");
    let out = Command::new("git")
        .args(["show", &spec])
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.contains(&0) {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

fn resolve_worktree_merge_base(workdir: &Path, explicit_base: Option<&str>) -> Option<String> {
    let candidates: Vec<&str> = match explicit_base {
        Some(b) if !b.trim().is_empty() => vec![b.trim()],
        _ => vec!["origin/HEAD", "main", "master"],
    };
    for base in candidates {
        let Ok(out) = Command::new("git")
            .args(["merge-base", base, "HEAD"])
            .current_dir(workdir)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        else {
            continue;
        };
        if out.status.success()
            && let Ok(text) = String::from_utf8(out.stdout)
        {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn collect_candidate_changed_paths(
    workdir: &Path,
    scope: &DiffCaptureScope,
) -> (Vec<String>, String) {
    if let Ok(out) = Command::new("git")
        .args(["status", "--porcelain", "-z", "--untracked-files=all"])
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        && out.status.success()
    {
        let mut paths = BTreeSet::new();
        let mut iter = out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty());
        while let Some(entry) = iter.next() {
            if entry.len() < 4 {
                continue;
            }
            let status = &entry[..2];
            let raw_path = String::from_utf8_lossy(&entry[3..]).into_owned();
            if !raw_path.contains('\u{FFFD}') && !raw_path.is_empty() {
                paths.insert(raw_path);
            }
            if status.contains(&b'R') || status.contains(&b'C') {
                let _ = iter.next();
            }
        }

        let baseline_rev = match scope {
            DiffCaptureScope::UncommittedOnly => "HEAD".to_string(),
            DiffCaptureScope::WorktreeBranch { base_branch } => {
                if let Some(merge_base) =
                    resolve_worktree_merge_base(workdir, base_branch.as_deref())
                {
                    let range = format!("{merge_base}..HEAD");
                    if let Ok(diff_out) = Command::new("git")
                        .args(["diff", "--name-only", "-z", &range])
                        .current_dir(workdir)
                        .stdin(Stdio::null())
                        .stderr(Stdio::null())
                        .output()
                        && diff_out.status.success()
                    {
                        for raw in diff_out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
                            let p = String::from_utf8_lossy(raw).into_owned();
                            if !p.contains('\u{FFFD}') && !p.is_empty() {
                                paths.insert(p);
                            }
                        }
                    }
                    merge_base
                } else {
                    "HEAD".to_string()
                }
            }
        };

        return (paths.into_iter().collect(), baseline_rev);
    }

    let fallback = scan_directory_parallel(
        workdir,
        CODE_COLLAB_MAX_INDEX_ENTRIES,
        CODE_COLLAB_MAX_INDEX_BYTES,
    )
    .map(|idx| {
        idx.entries
            .into_iter()
            .filter(|e| !e.is_directory)
            .map(|e| e.relative_path)
            .collect()
    })
    .unwrap_or_default();
    (fallback, "HEAD".to_string())
}

pub struct LocalTurnDiffStore {
    data_dir: PathBuf,
    stores: Mutex<HashMap<String, Arc<SqliteTurnDiffStore>>>,
}

impl LocalTurnDiffStore {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            stores: Mutex::new(HashMap::new()),
        }
    }

    fn get_or_open_workspace_store(
        &self,
        workspace_id: &str,
    ) -> PortResult<Arc<SqliteTurnDiffStore>> {
        if let Some(existing) = self
            .stores
            .lock()
            .expect("diff stores lock")
            .get(workspace_id)
            .cloned()
        {
            return Ok(existing);
        }
        let db_path = workspace_diff_db_path(&self.data_dir, workspace_id);
        let store = Arc::new(SqliteTurnDiffStore::open(TurnDiffStoreConfig::new(
            db_path,
        ))?);
        let mut guard = self.stores.lock().expect("diff stores lock");
        Ok(Arc::clone(
            guard
                .entry(workspace_id.to_string())
                .or_insert_with(|| Arc::clone(&store)),
        ))
    }
}

impl Default for LocalTurnDiffStore {
    fn default() -> Self {
        Self::new(".lody-oss")
    }
}

impl DiffStorePort for LocalTurnDiffStore {
    fn capture_turn_snapshot(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
        workdir: &Path,
        scope: &DiffCaptureScope,
        now_ms: i64,
    ) -> PortResult<TurnDiffSummary> {
        if !workdir.exists() {
            return Ok(TurnDiffSummary {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                files: Vec::new(),
            });
        }

        let (candidates, baseline_rev) = collect_candidate_changed_paths(workdir, scope);
        if candidates.is_empty() {
            return Ok(TurnDiffSummary {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                files: Vec::new(),
            });
        }

        let store = self.get_or_open_workspace_store(&workspace_id.0)?;
        let head_proof = store.allocate_head_proof()?;
        let mut events = Vec::new();

        for rel_path in candidates {
            let disk_path = workdir.join(&rel_path);
            let new_text = if disk_path.exists() {
                let Some(txt) = read_utf8_if_text(&disk_path) else {
                    continue;
                };
                Some(txt)
            } else {
                None
            };

            let old_text = match store.get_latest_text(&session_id.0, &rel_path, None)? {
                TrackedLatestText::Tracked { text } => text,
                TrackedLatestText::TooLarge { .. } => continue,
                TrackedLatestText::Untracked => {
                    read_git_revision_file(workdir, &baseline_rev, &rel_path)
                }
            };

            if old_text == new_text {
                continue;
            }

            let (additions, deletions) =
                compute_line_diff_counts(old_text.as_deref(), new_text.as_deref());
            events.push(TurnDiffEventInput {
                path: rel_path,
                old_text,
                new_text,
                new_is_current: true,
                head_proof: Some(head_proof),
                additions,
                deletions,
            });
        }

        if events.is_empty() {
            return Ok(TurnDiffSummary {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                files: Vec::new(),
            });
        }

        let files = store.record_turn(&session_id.0, &turn_id.0, None, now_ms, now_ms, &events)?;
        Ok(TurnDiffSummary {
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            files,
        })
    }

    fn read_turn_diff(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
        now_ms: i64,
    ) -> PortResult<Option<TurnDiffSummary>> {
        let db_path = workspace_diff_db_path(&self.data_dir, &workspace_id.0);
        if !db_path.exists() {
            return Ok(None);
        }
        let store = self.get_or_open_workspace_store(&workspace_id.0)?;
        let files = store.list_turn_files(&session_id.0, &turn_id.0, now_ms)?;
        if files.is_empty() {
            Ok(None)
        } else {
            Ok(Some(TurnDiffSummary {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                files,
            }))
        }
    }

    fn erase_workspace_diffs(&self, workspace_id: &WorkspaceId) -> PortResult<()> {
        let _ = self
            .stores
            .lock()
            .expect("diff stores lock")
            .remove(&workspace_id.0);
        let dir = self
            .data_dir
            .join("code-collab-v2")
            .join(safe_workspace_segment(&workspace_id.0));
        if dir.exists() {
            let _ = fs::remove_dir_all(dir);
        }
        Ok(())
    }
}
