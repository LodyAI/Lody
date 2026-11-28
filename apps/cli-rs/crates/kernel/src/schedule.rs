#![forbid(unsafe_code)]

use chrono::{DateTime, Datelike, LocalResult, NaiveDate, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const SCHEDULE_MISFIRE_GRACE_MS: i64 = 120_000;
pub const SCHEDULE_MIN_INTERVAL_MS: i64 = 60_000;
pub const SCHEDULE_MAX_DATE_MS: i64 = 8_640_000_000_000_000;
pub const SCHEDULE_RETRY_DELAYS_MS: [i64; 4] = [30_000, 120_000, 600_000, 1_800_000];
const CRON_SEARCH_YEARS: i32 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KernelScheduleTrigger {
    Manual,
    Once {
        at: String,
    },
    Interval {
        #[serde(rename = "everyMs")]
        every_ms: i64,
        #[serde(rename = "anchorAt")]
        anchor_at: String,
    },
    Cron {
        expression: String,
        #[serde(rename = "timeZone")]
        time_zone: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelMisfirePolicy {
    Skip,
    RunOnce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelOverlapPolicy {
    Skip,
    QueueOne,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KernelScheduleDestination {
    NewSession,
    OwnSession {
        epoch: u64,
    },
    ExistingSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MisfireDisposition {
    Run,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleSlotEvaluation {
    pub latest_slot_ms: Option<i64>,
    pub next_slot_ms: Option<i64>,
    pub misfire_disposition: Option<MisfireDisposition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlannedSlotOutcome {
    EnqueuePending { supersede_pending_auto_runs: bool },
    RecordSkipped { error_code: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotPlanningContext {
    pub misfire_disposition: MisfireDisposition,
    pub overlap_policy: KernelOverlapPolicy,
    pub has_unfinished_auto_run: bool,
    pub has_capacity_deferred_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScheduleRetryVerdict {
    ExpireDispatch,
    DeferForCapacity { next_attempt_at_ms: i64 },
    SkipDuplicateCapacityDeferral,
    RetryAfter { next_attempt_at_ms: i64 },
    FailPermanent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleRetryInput {
    pub attempts: u32,
    pub max_attempts: u32,
    pub planned_at_ms: i64,
    pub dispatch_max_age_ms: i64,
    pub now_ms: i64,
    pub is_capacity_exhausted: bool,
    pub capacity_reset_at_ms: Option<i64>,
    pub other_run_already_deferred_for_capacity: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivedScheduleRunIds {
    pub session_id: String,
    pub user_turn_id: String,
    pub source_entry_id: String,
}

#[derive(Debug, Clone)]
struct ParsedCron {
    minutes: [bool; 60],
    hours: [bool; 24],
    days_of_month: [bool; 32],
    months: [bool; 13],
    days_of_week: [bool; 7],
    dom_wildcard: bool,
    dow_wildcard: bool,
}

pub fn parse_rfc3339_millis(raw: &str) -> Result<i64, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("timestamp cannot be empty".to_string());
    }
    let parsed = DateTime::parse_from_rfc3339(trimmed)
        .map_err(|_| format!("invalid ISO-8601 timestamp with offset: {trimmed}"))?;
    let ms = parsed.timestamp_millis();
    if ms.abs() > SCHEDULE_MAX_DATE_MS {
        return Err("timestamp out of supported range".to_string());
    }
    Ok(ms)
}

pub fn validate_iana_time_zone(raw: &str) -> Result<Tz, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("timeZone is required".to_string());
    }
    trimmed
        .parse::<Tz>()
        .map_err(|_| format!("unsupported IANA timeZone: {trimmed}"))
}

pub fn validate_trigger(trigger: &KernelScheduleTrigger) -> Result<(), String> {
    match trigger {
        KernelScheduleTrigger::Manual => Ok(()),
        KernelScheduleTrigger::Once { at } => {
            parse_rfc3339_millis(at)?;
            Ok(())
        }
        KernelScheduleTrigger::Interval {
            every_ms,
            anchor_at,
        } => {
            if *every_ms < SCHEDULE_MIN_INTERVAL_MS {
                return Err("interval schedules must wait at least 60000ms".to_string());
            }
            parse_rfc3339_millis(anchor_at)?;
            Ok(())
        }
        KernelScheduleTrigger::Cron {
            expression,
            time_zone,
        } => {
            validate_iana_time_zone(time_zone)?;
            parse_cron_expression(expression)?;
            Ok(())
        }
    }
}

pub fn evaluate_schedule_slot(
    trigger: &KernelScheduleTrigger,
    misfire_policy: KernelMisfirePolicy,
    active_from_ms: i64,
    now_ms: i64,
) -> Result<ScheduleSlotEvaluation, String> {
    let latest_slot_ms = latest_schedule_slot(trigger, active_from_ms, now_ms)?;
    let next_slot_ms = next_schedule_slot(trigger, active_from_ms, now_ms)?;
    let misfire_disposition = latest_slot_ms.map(|slot| {
        if misfire_policy == KernelMisfirePolicy::RunOnce
            || now_ms.saturating_sub(slot) <= SCHEDULE_MISFIRE_GRACE_MS
        {
            MisfireDisposition::Run
        } else {
            MisfireDisposition::Skip
        }
    });
    Ok(ScheduleSlotEvaluation {
        latest_slot_ms,
        next_slot_ms,
        misfire_disposition,
    })
}

pub fn decide_planned_slot_outcome(ctx: SlotPlanningContext) -> PlannedSlotOutcome {
    if ctx.misfire_disposition == MisfireDisposition::Skip {
        return PlannedSlotOutcome::RecordSkipped {
            error_code: "MISFIRE",
        };
    }
    if ctx.has_capacity_deferred_run {
        return PlannedSlotOutcome::RecordSkipped {
            error_code: "CAPACITY_DEFERRED",
        };
    }
    match ctx.overlap_policy {
        KernelOverlapPolicy::Skip if ctx.has_unfinished_auto_run => {
            PlannedSlotOutcome::RecordSkipped {
                error_code: "OVERLAP",
            }
        }
        KernelOverlapPolicy::Skip => PlannedSlotOutcome::EnqueuePending {
            supersede_pending_auto_runs: false,
        },
        KernelOverlapPolicy::QueueOne => PlannedSlotOutcome::EnqueuePending {
            supersede_pending_auto_runs: true,
        },
    }
}

pub fn decide_schedule_retry(input: ScheduleRetryInput) -> ScheduleRetryVerdict {
    if input.now_ms.saturating_sub(input.planned_at_ms) >= input.dispatch_max_age_ms {
        return ScheduleRetryVerdict::ExpireDispatch;
    }
    if input.is_capacity_exhausted {
        if input.other_run_already_deferred_for_capacity {
            return ScheduleRetryVerdict::SkipDuplicateCapacityDeferral;
        }
        let fallback = input.now_ms.saturating_add(SCHEDULE_RETRY_DELAYS_MS[2]);
        let next_attempt_at_ms = input
            .capacity_reset_at_ms
            .filter(|reset| *reset > input.now_ms)
            .unwrap_or(fallback);
        return ScheduleRetryVerdict::DeferForCapacity { next_attempt_at_ms };
    }
    if input.attempts < input.max_attempts {
        let idx =
            (input.attempts.saturating_sub(1) as usize).min(SCHEDULE_RETRY_DELAYS_MS.len() - 1);
        let delay = SCHEDULE_RETRY_DELAYS_MS[idx];
        return ScheduleRetryVerdict::RetryAfter {
            next_attempt_at_ms: input.now_ms.saturating_add(delay),
        };
    }
    ScheduleRetryVerdict::FailPermanent
}

pub fn latest_schedule_slot(
    trigger: &KernelScheduleTrigger,
    active_from_ms: i64,
    now_ms: i64,
) -> Result<Option<i64>, String> {
    if now_ms < active_from_ms {
        return Ok(None);
    }
    match trigger {
        KernelScheduleTrigger::Manual => Ok(None),
        KernelScheduleTrigger::Once { at } => {
            let at_ms = parse_rfc3339_millis(at)?;
            Ok((at_ms >= active_from_ms && at_ms <= now_ms).then_some(at_ms))
        }
        KernelScheduleTrigger::Interval {
            every_ms,
            anchor_at,
        } => {
            if *every_ms < SCHEDULE_MIN_INTERVAL_MS {
                return Err("interval schedules must wait at least 60000ms".to_string());
            }
            let anchor_ms = parse_rfc3339_millis(anchor_at)?;
            if now_ms < anchor_ms {
                return Ok(None);
            }
            let steps = (now_ms - anchor_ms) / *every_ms;
            let slot = anchor_ms.saturating_add(steps.saturating_mul(*every_ms));
            Ok((slot >= active_from_ms && slot <= now_ms).then_some(slot))
        }
        KernelScheduleTrigger::Cron {
            expression,
            time_zone,
        } => {
            let tz = validate_iana_time_zone(time_zone)?;
            let cron = parse_cron_expression(expression)?;
            Ok(find_latest_cron_slot(&cron, tz, active_from_ms, now_ms))
        }
    }
}

pub fn next_schedule_slot(
    trigger: &KernelScheduleTrigger,
    active_from_ms: i64,
    now_ms: i64,
) -> Result<Option<i64>, String> {
    let lower_ms = active_from_ms.max(now_ms.saturating_add(1));
    match trigger {
        KernelScheduleTrigger::Manual => Ok(None),
        KernelScheduleTrigger::Once { at } => {
            let at_ms = parse_rfc3339_millis(at)?;
            Ok((at_ms >= lower_ms).then_some(at_ms))
        }
        KernelScheduleTrigger::Interval {
            every_ms,
            anchor_at,
        } => {
            if *every_ms < SCHEDULE_MIN_INTERVAL_MS {
                return Err("interval schedules must wait at least 60000ms".to_string());
            }
            let anchor_ms = parse_rfc3339_millis(anchor_at)?;
            let steps = if lower_ms <= anchor_ms {
                0
            } else {
                let diff = lower_ms - anchor_ms;
                (diff + *every_ms - 1) / *every_ms
            };
            let slot = anchor_ms.saturating_add(steps.saturating_mul(*every_ms));
            Ok((slot <= SCHEDULE_MAX_DATE_MS).then_some(slot))
        }
        KernelScheduleTrigger::Cron {
            expression,
            time_zone,
        } => {
            let tz = validate_iana_time_zone(time_zone)?;
            let cron = parse_cron_expression(expression)?;
            Ok(find_next_cron_slot(&cron, tz, lower_ms))
        }
    }
}

pub fn canonical_schedule_json(value: &Value) -> String {
    fn normalize(entry: &Value) -> Value {
        match entry {
            Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut sorted = Map::new();
                for key in keys {
                    if let Some(val) = map.get(key)
                        && !val.is_null()
                    {
                        sorted.insert(key.clone(), normalize(val));
                    }
                }
                Value::Object(sorted)
            }
            other => other.clone(),
        }
    }
    serde_json::to_string(&normalize(value)).unwrap_or_else(|_| "null".to_string())
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in out {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

pub fn schedule_digest(value: &Value) -> String {
    sha256_hex_bytes(canonical_schedule_json(value).as_bytes())
}

pub fn schedule_run_key(schedule_id: &str, activation_id: &str, scheduled_for_ms: i64) -> String {
    schedule_digest(&serde_json::json!([
        schedule_id,
        activation_id,
        scheduled_for_ms
    ]))
}

pub fn manual_schedule_run_key(schedule_id: &str, manual_run_id: &str) -> String {
    schedule_digest(&serde_json::json!([schedule_id, "manual", manual_run_id]))
}

pub fn schedule_uuid_v8(payload: &Value) -> String {
    let digest = schedule_digest(payload);
    let mut chars: Vec<char> = digest.chars().take(32).collect();
    chars[12] = '8';
    let variant_nibble = chars[16].to_digit(16).unwrap_or(0);
    chars[16] = char::from_digit((variant_nibble & 0x3) | 0x8, 16).unwrap_or('8');
    let hex: String = chars.into_iter().collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub fn schedule_own_session_id(schedule_id: &str, epoch: u64) -> String {
    schedule_uuid_v8(&serde_json::json!([
        "lody.schedule.v1",
        "own-session",
        schedule_id,
        epoch
    ]))
}

pub fn schedule_run_ids(
    run_key: &str,
    schedule_id: &str,
    destination: &KernelScheduleDestination,
) -> DerivedScheduleRunIds {
    let derive = |purpose: &str| {
        schedule_uuid_v8(&serde_json::json!(["lody.schedule.v1", purpose, run_key]))
    };
    let session_id = match destination {
        KernelScheduleDestination::OwnSession { epoch } => {
            schedule_own_session_id(schedule_id, *epoch)
        }
        KernelScheduleDestination::ExistingSession { session_id } => session_id.clone(),
        KernelScheduleDestination::NewSession => derive("session"),
    };
    DerivedScheduleRunIds {
        session_id,
        user_turn_id: derive("turn"),
        source_entry_id: derive("source"),
    }
}

fn parse_cron_expression(raw: &str) -> Result<ParsedCron, String> {
    let trimmed = raw.trim();
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(
            "cron expressions must have 5 fields: minute hour day month weekday".to_string(),
        );
    }
    let mut minutes = [false; 60];
    let mut hours = [false; 24];
    let mut days_of_month = [false; 32];
    let mut months = [false; 13];
    let mut days_of_week = [false; 7];

    parse_cron_field(fields[0], 0, 59, &mut minutes, None)?;
    parse_cron_field(fields[1], 0, 23, &mut hours, None)?;
    parse_cron_field(fields[2], 1, 31, &mut days_of_month, None)?;
    parse_cron_field(
        fields[3],
        1,
        12,
        &mut months,
        Some(&[
            ("JAN", 1),
            ("FEB", 2),
            ("MAR", 3),
            ("APR", 4),
            ("MAY", 5),
            ("JUN", 6),
            ("JUL", 7),
            ("AUG", 8),
            ("SEP", 9),
            ("OCT", 10),
            ("NOV", 11),
            ("DEC", 12),
        ]),
    )?;
    let mut raw_dow = [false; 8];
    parse_cron_field(
        fields[4],
        0,
        7,
        &mut raw_dow,
        Some(&[
            ("SUN", 0),
            ("MON", 1),
            ("TUE", 2),
            ("WED", 3),
            ("THU", 4),
            ("FRI", 5),
            ("SAT", 6),
        ]),
    )?;
    days_of_week.copy_from_slice(&raw_dow[..7]);
    if raw_dow[7] {
        days_of_week[0] = true;
    }

    Ok(ParsedCron {
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        dom_wildcard: fields[2] == "*",
        dow_wildcard: fields[4] == "*",
    })
}

fn parse_cron_field(
    field: &str,
    min: usize,
    max: usize,
    out: &mut [bool],
    names: Option<&[(&str, usize)]>,
) -> Result<(), String> {
    if field.is_empty() {
        return Err("empty cron field".to_string());
    }
    for part in field.split(',') {
        if part.is_empty() {
            return Err(format!("invalid cron field segment in '{field}'"));
        }
        let (range_part, step) = if let Some((lhs, rhs)) = part.split_once('/') {
            let parsed_step: usize = rhs
                .parse()
                .map_err(|_| format!("invalid cron step '{rhs}' in '{field}'"))?;
            if parsed_step == 0 {
                return Err("cron step must be positive".to_string());
            }
            (lhs, parsed_step)
        } else {
            (part, 1usize)
        };

        let (start, end) = if range_part == "*" {
            (min, max)
        } else if let Some((start_raw, end_raw)) = range_part.split_once('-') {
            let s = parse_cron_atom(start_raw, min, max, names)?;
            let e = parse_cron_atom(end_raw, min, max, names)?;
            if s > e {
                return Err(format!("invalid cron range '{range_part}'"));
            }
            (s, e)
        } else {
            let v = parse_cron_atom(range_part, min, max, names)?;
            if part.contains('/') { (v, max) } else { (v, v) }
        };

        let mut cur = start;
        while cur <= end {
            out[cur] = true;
            cur = cur.saturating_add(step);
        }
    }
    Ok(())
}

fn parse_cron_atom(
    raw: &str,
    min: usize,
    max: usize,
    names: Option<&[(&str, usize)]>,
) -> Result<usize, String> {
    if let Some(table) = names {
        let upper = raw.to_ascii_uppercase();
        for (name, val) in table {
            if upper == *name {
                return Ok(*val);
            }
        }
    }
    let val: usize = raw
        .parse()
        .map_err(|_| format!("invalid cron value '{raw}'"))?;
    if val < min || val > max {
        return Err(format!("cron value {val} out of bounds {min}..={max}"));
    }
    Ok(val)
}

impl ParsedCron {
    fn matches_date(&self, date: NaiveDate) -> bool {
        let month = date.month() as usize;
        if !self.months[month] {
            return false;
        }
        let dom_match = self.days_of_month[date.day() as usize];
        let dow_idx = date.weekday().num_days_from_sunday() as usize;
        let dow_match = self.days_of_week[dow_idx];
        match (self.dom_wildcard, self.dow_wildcard) {
            (true, true) => true,
            (false, true) => dom_match,
            (true, false) => dow_match,
            (false, false) => dom_match || dow_match,
        }
    }
}

fn wall_time_millis(tz: Tz, date: NaiveDate, hour: u32, minute: u32) -> Option<i64> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp_millis()),
        LocalResult::None => None,
    }
}

fn find_next_cron_slot(cron: &ParsedCron, tz: Tz, lower_ms: i64) -> Option<i64> {
    let start_dt = tz.timestamp_millis_opt(lower_ms).single()?;
    let max_year = start_dt.year() + CRON_SEARCH_YEARS;
    let mut date = start_dt
        .date_naive()
        .pred_opt()
        .unwrap_or(start_dt.date_naive());

    while date.year() <= max_year {
        if cron.matches_date(date) {
            let mut candidates = Vec::new();
            for hour in 0u32..24 {
                if !cron.hours[hour as usize] {
                    continue;
                }
                for minute in 0u32..60 {
                    if !cron.minutes[minute as usize] {
                        continue;
                    }
                    if let Some(ts) = wall_time_millis(tz, date, hour, minute)
                        && ts >= lower_ms
                        && ts <= SCHEDULE_MAX_DATE_MS
                    {
                        candidates.push(ts);
                    }
                }
            }
            if let Some(best) = candidates.into_iter().min() {
                return Some(best);
            }
        }
        date = date.succ_opt()?;
    }
    None
}

fn find_latest_cron_slot(
    cron: &ParsedCron,
    tz: Tz,
    active_from_ms: i64,
    now_ms: i64,
) -> Option<i64> {
    if now_ms < active_from_ms {
        return None;
    }
    let now_dt = tz.timestamp_millis_opt(now_ms).single()?;
    let floor_dt = tz.timestamp_millis_opt(active_from_ms).single()?;
    let min_date = floor_dt
        .date_naive()
        .pred_opt()
        .unwrap_or(floor_dt.date_naive());
    let min_year = (now_dt.year() - CRON_SEARCH_YEARS).max(min_date.year() - 1);
    let mut date = now_dt
        .date_naive()
        .succ_opt()
        .unwrap_or(now_dt.date_naive());

    while date >= min_date && date.year() >= min_year {
        if cron.matches_date(date) {
            let mut candidates = Vec::new();
            for hour in 0u32..24 {
                if !cron.hours[hour as usize] {
                    continue;
                }
                for minute in 0u32..60 {
                    if !cron.minutes[minute as usize] {
                        continue;
                    }
                    if let Some(ts) = wall_time_millis(tz, date, hour, minute)
                        && ts >= active_from_ms
                        && ts <= now_ms
                    {
                        candidates.push(ts);
                    }
                }
            }
            if let Some(best) = candidates.into_iter().max() {
                return Some(best);
            }
        }
        date = date.pred_opt()?;
    }
    None
}
