use crate::map_sql_err;
use lody_ports::{
    MAX_SCHEDULE_PROMPT_BYTES, PortError, PortErrorKind, PortResult, ScheduleEditPatch,
    ScheduleProposalOutcome, ScheduleRecord, ScheduleStorePort, SessionId, UserId, WorkspaceId,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize)]
struct StoredProposalPatch {
    title: Option<String>,
    prompt_text: Option<String>,
    cron_expr: Option<String>,
}

fn validate_schedule_identifier(label: &str, raw: &str) -> PortResult<String> {
    let trimmed = raw.trim();
    let valid = !trimmed.is_empty()
        && trimmed.len() <= 50
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !valid {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("{label} must be 1..=50 ASCII [a-zA-Z0-9_-] characters"),
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_schedule_prompt(raw: &str) -> PortResult<()> {
    if raw.trim().is_empty() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "schedule prompt cannot be blank",
        ));
    }
    if raw.len() > MAX_SCHEDULE_PROMPT_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("schedule prompt exceeds {MAX_SCHEDULE_PROMPT_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn validate_schedule_title(raw: &str) -> PortResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 200 {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "schedule title must be 1..=200 non-blank characters",
        ));
    }
    Ok(trimmed.to_string())
}

pub struct SqliteScheduleStore {
    conn: Mutex<Connection>,
}

impl SqliteScheduleStore {
    pub fn open(db_path: &Path) -> PortResult<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        }
        let conn = Connection::open(db_path).map_err(map_sql_err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS schedules (
                 schedule_id TEXT NOT NULL,
                 workspace_id TEXT NOT NULL,
                 session_id TEXT,
                 author_user_id TEXT NOT NULL,
                 title TEXT NOT NULL,
                 cron_expr TEXT NOT NULL,
                 prompt_text TEXT NOT NULL,
                 enabled INTEGER NOT NULL DEFAULT 1,
                 content_revision INTEGER NOT NULL DEFAULT 1,
                 PRIMARY KEY(workspace_id, schedule_id)
             );
             CREATE TABLE IF NOT EXISTS schedule_proposals (
                 proposal_id TEXT PRIMARY KEY,
                 workspace_id TEXT NOT NULL,
                 schedule_id TEXT,
                 author_user_id TEXT NOT NULL,
                 request_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 patch_json TEXT NOT NULL,
                 base_revision INTEGER,
                 status TEXT NOT NULL DEFAULT 'pending',
                 UNIQUE(workspace_id, author_user_id, request_id)
             );",
        )
        .map_err(map_sql_err)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

impl ScheduleStorePort for SqliteScheduleStore {
    fn list_schedules(
        &self,
        workspace_id: &WorkspaceId,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> PortResult<Vec<ScheduleRecord>> {
        let clamped_limit = i64::try_from(limit.clamp(1, 100)).unwrap_or(30);
        let clamped_offset = i64::try_from(offset.min(100_000)).unwrap_or(0);
        let filter = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(|q| q.to_ascii_lowercase());

        let conn = self.conn.lock().expect("schedule sqlite lock");
        let mut stmt = conn
            .prepare(
                "SELECT schedule_id, session_id, author_user_id, title, cron_expr, prompt_text,
                        enabled, content_revision
                 FROM schedules
                 WHERE workspace_id = ?1
                 ORDER BY schedule_id ASC",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![&workspace_id.0], |r| {
                let sid: Option<String> = r.get(1)?;
                let rev: i64 = r.get(7)?;
                Ok(ScheduleRecord {
                    schedule_id: r.get(0)?,
                    workspace_id: workspace_id.clone(),
                    session_id: sid.map(SessionId),
                    author_user_id: UserId(r.get(2)?),
                    title: r.get(3)?,
                    cron_expr: r.get(4)?,
                    prompt_text: r.get(5)?,
                    enabled: r.get::<_, i64>(6)? != 0,
                    content_revision: u64::try_from(rev).unwrap_or(1),
                })
            })
            .map_err(map_sql_err)?;

        let mut matched = Vec::new();
        for item in rows {
            let rec = item.map_err(map_sql_err)?;
            if let Some(ref q) = filter
                && !rec.title.to_ascii_lowercase().contains(q)
                && !rec.schedule_id.to_ascii_lowercase().contains(q)
            {
                continue;
            }
            matched.push(rec);
        }

        let skip = usize::try_from(clamped_offset).unwrap_or(0);
        let take = usize::try_from(clamped_limit).unwrap_or(30);
        Ok(matched.into_iter().skip(skip).take(take).collect())
    }

    fn get_schedule(
        &self,
        workspace_id: &WorkspaceId,
        schedule_id: &str,
    ) -> PortResult<Option<ScheduleRecord>> {
        let valid_id = validate_schedule_identifier("scheduleId", schedule_id)?;
        let conn = self.conn.lock().expect("schedule sqlite lock");
        conn.query_row(
            "SELECT schedule_id, session_id, author_user_id, title, cron_expr, prompt_text,
                    enabled, content_revision
             FROM schedules
             WHERE workspace_id = ?1 AND schedule_id = ?2",
            params![&workspace_id.0, &valid_id],
            |r| {
                let sid: Option<String> = r.get(1)?;
                let rev: i64 = r.get(7)?;
                Ok(ScheduleRecord {
                    schedule_id: r.get(0)?,
                    workspace_id: workspace_id.clone(),
                    session_id: sid.map(SessionId),
                    author_user_id: UserId(r.get(2)?),
                    title: r.get(3)?,
                    cron_expr: r.get(4)?,
                    prompt_text: r.get(5)?,
                    enabled: r.get::<_, i64>(6)? != 0,
                    content_revision: u64::try_from(rev).unwrap_or(1),
                })
            },
        )
        .optional()
        .map_err(map_sql_err)
    }

    fn upsert_schedule(&self, record: &ScheduleRecord) -> PortResult<()> {
        let valid_id = validate_schedule_identifier("scheduleId", &record.schedule_id)?;
        let valid_title = validate_schedule_title(&record.title)?;
        validate_schedule_prompt(&record.prompt_text)?;

        let conn = self.conn.lock().expect("schedule sqlite lock");
        conn.execute(
            "INSERT INTO schedules
             (schedule_id, workspace_id, session_id, author_user_id, title, cron_expr,
              prompt_text, enabled, content_revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(workspace_id, schedule_id) DO UPDATE SET
               session_id = excluded.session_id,
               title = excluded.title,
               cron_expr = excluded.cron_expr,
               prompt_text = excluded.prompt_text,
               enabled = excluded.enabled,
               content_revision = schedules.content_revision + 1",
            params![
                &valid_id,
                &record.workspace_id.0,
                record.session_id.as_ref().map(|s| s.0.as_str()),
                &record.author_user_id.0,
                &valid_title,
                &record.cron_expr,
                &record.prompt_text,
                i64::from(record.enabled),
                i64::try_from(record.content_revision.max(1)).unwrap_or(1),
            ],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn propose_schedule(
        &self,
        workspace_id: &WorkspaceId,
        author: &UserId,
        request_id: &str,
        title: &str,
        prompt_text: &str,
        cron_expr: &str,
    ) -> PortResult<ScheduleProposalOutcome> {
        let req_id = validate_schedule_identifier("requestId", request_id)?;
        let valid_title = validate_schedule_title(title)?;
        validate_schedule_prompt(prompt_text)?;
        if cron_expr.trim().is_empty() {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "schedule rule cannot be empty",
            ));
        }

        let patch = StoredProposalPatch {
            title: Some(valid_title),
            prompt_text: Some(prompt_text.to_string()),
            cron_expr: Some(cron_expr.trim().to_string()),
        };
        let patch_json = serde_json::to_string(&patch)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        let mut conn = self.conn.lock().expect("schedule sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        if let Some((proposal_id, existing_kind, existing_patch, status)) = tx
            .query_row(
                "SELECT proposal_id, kind, patch_json, status FROM schedule_proposals
                 WHERE workspace_id = ?1 AND author_user_id = ?2 AND request_id = ?3",
                params![&workspace_id.0, &author.0, &req_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sql_err)?
        {
            if existing_kind != "create" || existing_patch != patch_json {
                return Err(PortError::new(
                    PortErrorKind::Conflict,
                    "requestId already belongs to a different schedule proposal",
                ));
            }
            return Ok(ScheduleProposalOutcome {
                proposal_id,
                schedule_id: None,
                request_id: req_id,
                base_revision: None,
                status,
            });
        }

        let proposal_id = format!("prop-create:{}:{}", workspace_id.0, req_id);
        tx.execute(
            "INSERT INTO schedule_proposals
             (proposal_id, workspace_id, schedule_id, author_user_id, request_id, kind, patch_json, base_revision, status)
             VALUES (?1, ?2, NULL, ?3, ?4, 'create', ?5, NULL, 'pending')",
            params![&proposal_id, &workspace_id.0, &author.0, &req_id, &patch_json],
        )
        .map_err(map_sql_err)?;
        tx.commit().map_err(map_sql_err)?;

        Ok(ScheduleProposalOutcome {
            proposal_id,
            schedule_id: None,
            request_id: req_id,
            base_revision: None,
            status: "pending".to_string(),
        })
    }

    fn propose_schedule_edit(
        &self,
        workspace_id: &WorkspaceId,
        author: &UserId,
        schedule_id: &str,
        request_id: &str,
        patch: &ScheduleEditPatch,
    ) -> PortResult<ScheduleProposalOutcome> {
        let sched_id = validate_schedule_identifier("scheduleId", schedule_id)?;
        let req_id = validate_schedule_identifier("requestId", request_id)?;

        let normalized_title = match &patch.title {
            Some(t) => Some(validate_schedule_title(t)?),
            None => None,
        };
        if let Some(p) = &patch.prompt_text {
            validate_schedule_prompt(p)?;
        }
        let normalized_cron = match &patch.cron_expr {
            Some(c) => {
                let trimmed = c.trim();
                if trimmed.is_empty() {
                    return Err(PortError::new(
                        PortErrorKind::InvalidInput,
                        "schedule rule cannot be empty",
                    ));
                }
                Some(trimmed.to_string())
            }
            None => None,
        };

        if normalized_title.is_none() && patch.prompt_text.is_none() && normalized_cron.is_none() {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "propose_edit requires at least one of title, prompt, or rule",
            ));
        }

        let stored_patch = StoredProposalPatch {
            title: normalized_title,
            prompt_text: patch.prompt_text.clone(),
            cron_expr: normalized_cron,
        };
        let patch_json = serde_json::to_string(&stored_patch)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        let mut conn = self.conn.lock().expect("schedule sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        if let Some((
            proposal_id,
            existing_kind,
            existing_sched,
            existing_patch,
            base_rev,
            status,
        )) = tx
            .query_row(
                "SELECT proposal_id, kind, schedule_id, patch_json, base_revision, status
                 FROM schedule_proposals
                 WHERE workspace_id = ?1 AND author_user_id = ?2 AND request_id = ?3",
                params![&workspace_id.0, &author.0, &req_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<i64>>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sql_err)?
        {
            if existing_kind != "edit"
                || existing_sched.as_deref() != Some(sched_id.as_str())
                || existing_patch != patch_json
            {
                return Err(PortError::new(
                    PortErrorKind::Conflict,
                    "requestId already belongs to a different schedule proposal",
                ));
            }
            return Ok(ScheduleProposalOutcome {
                proposal_id,
                schedule_id: Some(sched_id),
                request_id: req_id,
                base_revision: base_rev.and_then(|r| u64::try_from(r).ok()),
                status,
            });
        }

        let Some((owner_id, cur_title, cur_cron, cur_prompt, cur_rev)) = tx
            .query_row(
                "SELECT author_user_id, title, cron_expr, prompt_text, content_revision
                 FROM schedules
                 WHERE workspace_id = ?1 AND schedule_id = ?2",
                params![&workspace_id.0, &sched_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sql_err)?
        else {
            return Err(PortError::new(
                PortErrorKind::NotFound,
                format!("schedule '{sched_id}' is unavailable"),
            ));
        };

        if owner_id != author.0 {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                "propose_edit requires ownership of the target schedule",
            ));
        }

        let title_changed = stored_patch.title.as_ref().is_some_and(|t| t != &cur_title);
        let prompt_changed = stored_patch
            .prompt_text
            .as_ref()
            .is_some_and(|p| p != &cur_prompt);
        let cron_changed = stored_patch
            .cron_expr
            .as_ref()
            .is_some_and(|c| c != &cur_cron);

        if !title_changed && !prompt_changed && !cron_changed {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "proposed schedule edit makes no changes to current title, prompt, or rule",
            ));
        }

        let proposal_id = format!("prop-edit:{}:{}:{}", workspace_id.0, sched_id, req_id);
        tx.execute(
            "INSERT INTO schedule_proposals
             (proposal_id, workspace_id, schedule_id, author_user_id, request_id, kind, patch_json, base_revision, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'edit', ?6, ?7, 'pending')",
            params![
                &proposal_id,
                &workspace_id.0,
                &sched_id,
                &author.0,
                &req_id,
                &patch_json,
                cur_rev,
            ],
        )
        .map_err(map_sql_err)?;
        tx.commit().map_err(map_sql_err)?;

        Ok(ScheduleProposalOutcome {
            proposal_id,
            schedule_id: Some(sched_id),
            request_id: req_id,
            base_revision: u64::try_from(cur_rev).ok(),
            status: "pending".to_string(),
        })
    }

    fn pause_schedule(
        &self,
        workspace_id: &WorkspaceId,
        author: &UserId,
        schedule_id: &str,
        request_id: &str,
    ) -> PortResult<bool> {
        let sched_id = validate_schedule_identifier("scheduleId", schedule_id)?;
        let _ = validate_schedule_identifier("requestId", request_id)?;

        let conn = self.conn.lock().expect("schedule sqlite lock");
        let Some(owner_id): Option<String> = conn
            .query_row(
                "SELECT author_user_id FROM schedules WHERE workspace_id = ?1 AND schedule_id = ?2",
                params![&workspace_id.0, &sched_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?
        else {
            return Err(PortError::new(
                PortErrorKind::NotFound,
                format!("schedule '{sched_id}' not found"),
            ));
        };
        if owner_id != author.0 {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                "pause requires ownership of the target schedule",
            ));
        }
        let changed = conn
            .execute(
                "UPDATE schedules SET enabled = 0 WHERE workspace_id = ?1 AND schedule_id = ?2 AND enabled != 0",
                params![&workspace_id.0, &sched_id],
            )
            .map_err(map_sql_err)?;
        Ok(changed > 0)
    }
}
