use crate::sha256_hex;
use lody_ports::{
    AnchorSyncStatus, MachineId, MachineIdentityPort, MachineIdentityRestoreOutcome, PortError,
    PortErrorKind, PortResult, parse_machine_id,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MACHINE_ID_FILE_NAME: &str = "machine-id";
const CREDENTIALS_FILE_NAME: &str = "credentials.json";
const ANCHOR_FILE_NAME: &str = "machine-identity.json";
const LINUX_CONTAINER_MARKERS: [&str; 2] = ["/.dockerenv", "/run/.containerenv"];
const LINUX_MACHINE_ID_PATHS: [&str; 2] = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

static RANDOM_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HardwareProbeResult {
    Ok(String),
    Unavailable,
    TransientError,
}

pub type HardwareProbeFn = dyn Fn() -> HardwareProbeResult + Send + Sync;

#[derive(Debug, Clone)]
pub struct MachineIdentityConfig {
    pub data_dir: PathBuf,
    pub is_default_data_dir: bool,
    pub namespace: String,
    pub user_identity: String,
    pub state_anchor_dir: Option<PathBuf>,
    pub platform: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineIdentityAnchor {
    version: u32,
    machine_id: String,
    host_fingerprint_hash: String,
}

pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block_key = [0u8; 64];
    if key.len() > 64 {
        let hashed = Sha256::digest(key);
        block_key[..32].copy_from_slice(&hashed);
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= block_key[i];
        opad[i] ^= block_key[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    let outer_digest = outer.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&outer_digest);
    out
}

pub fn normalize_hardware_id(raw: &str) -> Option<String> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "uninitialized" {
        return None;
    }
    let stripped: String = normalized.chars().filter(|c| *c != '-').collect();
    if stripped.is_empty() || stripped.bytes().all(|b| b == b'0') {
        return None;
    }
    Some(normalized)
}

pub fn parse_macos_platform_uuid(output: &str) -> Option<String> {
    for line in output.lines() {
        let Some(idx) = line.find("\"IOPlatformUUID\"") else {
            continue;
        };
        let rest = &line[idx + "\"IOPlatformUUID\"".len()..];
        let Some(eq_idx) = rest.find('=') else {
            continue;
        };
        let after_eq = rest[eq_idx + 1..].trim();
        if let Some(stripped) = after_eq.strip_prefix('"')
            && let Some(end_quote) = stripped.find('"')
        {
            return normalize_hardware_id(&stripped[..end_quote]);
        }
    }
    None
}

pub fn parse_windows_machine_guid(output: &str) -> Option<String> {
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("machineguid") || !lower.contains("reg_sz") {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() >= 3 {
            return normalize_hardware_id(tokens[tokens.len() - 1]);
        }
    }
    None
}

pub fn resolve_linux_machine_id<R, E>(read_file: R, exists: E) -> Option<String>
where
    R: Fn(&str) -> Option<String>,
    E: Fn(&str) -> bool,
{
    if LINUX_CONTAINER_MARKERS.iter().any(|marker| exists(marker)) {
        return None;
    }
    for path in LINUX_MACHINE_ID_PATHS {
        if let Some(raw) = read_file(path)
            && let Some(parsed) = normalize_hardware_id(&raw)
        {
            return Some(parsed);
        }
    }
    None
}

pub fn compute_host_fingerprint_hash(platform: &str, raw_hardware_id: &str) -> String {
    sha256_hex(&format!(
        "lody:host-fingerprint:v1:{platform}:{raw_hardware_id}"
    ))
}

pub fn derive_deterministic_machine_id(
    namespace: &str,
    user_identity: &str,
    raw_hardware_id: &str,
) -> MachineId {
    let msg = format!("lody:machine-id:v1:{namespace}:{user_identity}");
    let digest = hmac_sha256(raw_hardware_id.as_bytes(), msg.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    MachineId(format_uuid_bytes(&bytes))
}

fn format_uuid_bytes(bytes: &[u8; 16]) -> String {
    let mut hex = String::with_capacity(32);
    for b in bytes {
        let _ = write!(hex, "{b:02x}");
    }
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn random_entropy_bytes(seed_path: &Path) -> [u8; 16] {
    #[cfg(unix)]
    {
        use std::io::Read as _;
        if let Ok(mut f) = fs::File::open("/dev/urandom") {
            let mut buf = [0u8; 16];
            if f.read_exact(&mut buf).is_ok() {
                return buf;
            }
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = RANDOM_COUNTER.fetch_add(1, Ordering::SeqCst);
    let digest = Sha256::digest(
        format!(
            "lody-uuid:{}:{nanos}:{seq}:{}",
            std::process::id(),
            seed_path.to_string_lossy()
        )
        .as_bytes(),
    );
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

pub fn generate_random_uuid_v4(seed_path: &Path) -> MachineId {
    let mut bytes = random_entropy_bytes(seed_path);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    MachineId(format_uuid_bytes(&bytes))
}

fn probe_os_hardware_id(platform: &str) -> HardwareProbeResult {
    match platform {
        "darwin" => {
            let Ok(out) = Command::new("/usr/sbin/ioreg")
                .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            else {
                return HardwareProbeResult::TransientError;
            };
            if !out.status.success() {
                return HardwareProbeResult::TransientError;
            }
            let text = String::from_utf8_lossy(&out.stdout);
            match parse_macos_platform_uuid(&text) {
                Some(id) => HardwareProbeResult::Ok(id),
                None => HardwareProbeResult::Unavailable,
            }
        }
        "win32" => {
            let Ok(out) = Command::new("reg")
                .args([
                    "query",
                    r"HKLM\SOFTWARE\Microsoft\Cryptography",
                    "/v",
                    "MachineGuid",
                ])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            else {
                return HardwareProbeResult::TransientError;
            };
            if !out.status.success() {
                return HardwareProbeResult::TransientError;
            }
            let text = String::from_utf8_lossy(&out.stdout);
            match parse_windows_machine_guid(&text) {
                Some(id) => HardwareProbeResult::Ok(id),
                None => HardwareProbeResult::Unavailable,
            }
        }
        "linux" => {
            let resolved =
                resolve_linux_machine_id(|p| fs::read_to_string(p).ok(), |p| Path::new(p).exists());
            match resolved {
                Some(id) => HardwareProbeResult::Ok(id),
                None => HardwareProbeResult::Unavailable,
            }
        }
        _ => HardwareProbeResult::Unavailable,
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_private_file_atomic(target: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        create_private_dir(parent)?;
    }
    let rand = random_entropy_bytes(target);
    let suffix = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        rand[0], rand[1], rand[2], rand[3]
    );
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let temp = target.with_file_name(format!("{file_name}.{suffix}.tmp"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&temp, content.as_bytes())?;
    }

    let rename_res = fs::rename(&temp, target);
    if rename_res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    rename_res
}

fn read_persisted_machine_id(data_dir: &Path) -> Option<MachineId> {
    let raw = fs::read_to_string(data_dir.join(MACHINE_ID_FILE_NAME)).ok()?;
    parse_machine_id(&raw).ok()
}

fn extract_credentials_v3_machine_id(val: &Value) -> Option<MachineId> {
    let obj = val.as_object()?;
    if obj.get("version").and_then(Value::as_u64) != Some(3) {
        return None;
    }
    let token = obj.get("token").and_then(Value::as_str)?.trim();
    if token.is_empty() {
        return None;
    }
    let user_id = obj
        .get("user")
        .and_then(Value::as_object)?
        .get("id")
        .and_then(Value::as_str)?
        .trim();
    if user_id.is_empty() {
        return None;
    }
    let machine_id_raw = obj
        .get("machine")
        .and_then(Value::as_object)?
        .get("machineId")
        .and_then(Value::as_str)?;
    parse_machine_id(machine_id_raw).ok()
}

fn read_credentials_machine_id_lenient(data_dir: &Path) -> Option<MachineId> {
    let raw = fs::read_to_string(data_dir.join(CREDENTIALS_FILE_NAME)).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    extract_credentials_v3_machine_id(&parsed)
}

fn read_credentials_strict(data_dir: &Path) -> PortResult<Option<(String, Value, MachineId)>> {
    let path = data_dir.join(CREDENTIALS_FILE_NAME);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(PortError::new(PortErrorKind::Unavailable, e.to_string())),
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| {
        PortError::new(
            PortErrorKind::InvalidInput,
            format!(
                "Existing credentials file at {:?} is not valid JSON. Fix or remove it before restoring.",
                path
            ),
        )
    })?;
    let Some(mid) = extract_credentials_v3_machine_id(&parsed) else {
        return Err(PortError::new(
            PortErrorKind::Conflict,
            format!(
                "Existing credentials file at {:?} has an unsupported format and cannot be updated safely.",
                path
            ),
        ));
    };
    Ok(Some((raw, parsed, mid)))
}

fn create_machine_id_file_exclusive(candidate: &MachineId, data_dir: &Path) -> MachineId {
    let target = data_dir.join(MACHINE_ID_FILE_NAME);
    let publish = (|| -> std::io::Result<()> {
        create_private_dir(data_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let rand = random_entropy_bytes(&target);
            let suffix = format!(
                "{:02x}{:02x}{:02x}{:02x}",
                rand[0], rand[1], rand[2], rand[3]
            );
            let temp = data_dir.join(format!("{MACHINE_ID_FILE_NAME}.{suffix}.tmp"));
            let write_res = (|| -> std::io::Result<()> {
                let mut f = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temp)?;
                f.write_all(candidate.0.as_bytes())?;
                f.sync_all()?;
                fs::hard_link(&temp, &target)
            })();
            let _ = fs::remove_file(&temp);
            write_res
        }
        #[cfg(not(unix))]
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            f.write_all(candidate.0.as_bytes())
        }
    })();

    if publish.is_ok() {
        return candidate.clone();
    }
    if let Some(existing) = read_persisted_machine_id(data_dir) {
        return existing;
    }
    let _ = write_private_file_atomic(&target, &candidate.0);
    read_persisted_machine_id(data_dir).unwrap_or_else(|| candidate.clone())
}

pub struct LocalMachineIdentityStore {
    cfg: MachineIdentityConfig,
    probe: Arc<HardwareProbeFn>,
    cached_probe: Mutex<Option<Option<String>>>,
}

impl LocalMachineIdentityStore {
    pub fn new(cfg: MachineIdentityConfig) -> Self {
        let platform = cfg.platform;
        Self::with_probe(cfg, Arc::new(move || probe_os_hardware_id(platform)))
    }

    pub fn with_probe(cfg: MachineIdentityConfig, probe: Arc<HardwareProbeFn>) -> Self {
        Self {
            cfg,
            probe,
            cached_probe: Mutex::new(None),
        }
    }

    fn anchor_file_path(&self) -> Option<PathBuf> {
        self.cfg
            .state_anchor_dir
            .as_ref()
            .map(|dir| dir.join(ANCHOR_FILE_NAME))
    }

    fn resolve_hardware_id(&self) -> Option<String> {
        if let Some(cached) = self
            .cached_probe
            .lock()
            .expect("hardware probe lock")
            .clone()
        {
            return cached;
        }
        match (self.probe)() {
            HardwareProbeResult::Ok(raw) => {
                let normalized = normalize_hardware_id(&raw);
                *self.cached_probe.lock().expect("hardware probe lock") = Some(normalized.clone());
                normalized
            }
            HardwareProbeResult::Unavailable => {
                *self.cached_probe.lock().expect("hardware probe lock") = Some(None);
                None
            }
            HardwareProbeResult::TransientError => None,
        }
    }

    fn read_anchor(&self) -> Option<MachineIdentityAnchor> {
        let path = self.anchor_file_path()?;
        let raw = fs::read_to_string(path).ok()?;
        let parsed: MachineIdentityAnchor = serde_json::from_str(&raw).ok()?;
        if parsed.version != 1 || parsed.host_fingerprint_hash.len() != 64 {
            return None;
        }
        if !parsed
            .host_fingerprint_hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return None;
        }
        let valid_id = parse_machine_id(&parsed.machine_id).ok()?;
        Some(MachineIdentityAnchor {
            version: 1,
            machine_id: valid_id.0,
            host_fingerprint_hash: parsed.host_fingerprint_hash,
        })
    }

    fn sync_anchor(&self, machine_id: &MachineId, force_refresh: bool) -> AnchorSyncStatus {
        let Some(anchor_path) = self.anchor_file_path() else {
            return AnchorSyncStatus::Skipped;
        };
        let existing = self.read_anchor();
        if let Some(ex) = &existing
            && ex.machine_id == machine_id.0
            && !force_refresh
        {
            return AnchorSyncStatus::Unchanged;
        }

        let Some(raw_hw) = self.resolve_hardware_id() else {
            return AnchorSyncStatus::Skipped;
        };
        let fp = compute_host_fingerprint_hash(self.cfg.platform, &raw_hw);
        if let Some(ex) = &existing
            && ex.machine_id == machine_id.0
            && ex.host_fingerprint_hash == fp
        {
            return AnchorSyncStatus::Unchanged;
        }

        let payload = MachineIdentityAnchor {
            version: 1,
            machine_id: machine_id.0.clone(),
            host_fingerprint_hash: fp,
        };
        let Ok(encoded) = serde_json::to_string_pretty(&payload) else {
            return AnchorSyncStatus::Skipped;
        };
        match write_private_file_atomic(&anchor_path, &encoded) {
            Ok(()) => AnchorSyncStatus::Updated,
            Err(_) => AnchorSyncStatus::Skipped,
        }
    }

    fn recover_from_anchor_or_hardware(&self) -> Option<MachineId> {
        let raw_hw = self.resolve_hardware_id()?;
        let fp = compute_host_fingerprint_hash(self.cfg.platform, &raw_hw);
        if let Some(anchor) = self.read_anchor()
            && anchor.host_fingerprint_hash == fp
        {
            return Some(MachineId(anchor.machine_id));
        }
        Some(derive_deterministic_machine_id(
            &self.cfg.namespace,
            &self.cfg.user_identity,
            &raw_hw,
        ))
    }
}

impl MachineIdentityPort for LocalMachineIdentityStore {
    fn read_existing_machine_id(&self) -> Option<MachineId> {
        read_credentials_machine_id_lenient(&self.cfg.data_dir)
            .or_else(|| read_persisted_machine_id(&self.cfg.data_dir))
    }

    fn get_or_create_machine_id(&self) -> PortResult<MachineId> {
        let persisted = read_persisted_machine_id(&self.cfg.data_dir);
        if let Some(cred_id) = read_credentials_machine_id_lenient(&self.cfg.data_dir) {
            if persisted.as_ref() != Some(&cred_id) {
                let _ = self.persist_machine_id(&cred_id, false);
            } else if self.cfg.is_default_data_dir {
                let _ = self.sync_anchor(&cred_id, false);
            }
            return Ok(cred_id);
        }

        if let Some(existing) = persisted {
            if self.cfg.is_default_data_dir {
                let _ = self.sync_anchor(&existing, false);
            }
            return Ok(existing);
        }

        let candidate = if self.cfg.is_default_data_dir {
            self.recover_from_anchor_or_hardware()
                .unwrap_or_else(|| generate_random_uuid_v4(&self.cfg.data_dir))
        } else {
            generate_random_uuid_v4(&self.cfg.data_dir)
        };

        let created = create_machine_id_file_exclusive(&candidate, &self.cfg.data_dir);
        if self.cfg.is_default_data_dir {
            let _ = self.sync_anchor(&created, false);
        }
        Ok(created)
    }

    fn persist_machine_id(
        &self,
        machine_id: &MachineId,
        force_refresh_anchor: bool,
    ) -> PortResult<AnchorSyncStatus> {
        let valid = parse_machine_id(&machine_id.0)?;
        if read_persisted_machine_id(&self.cfg.data_dir).as_ref() != Some(&valid) {
            write_private_file_atomic(&self.cfg.data_dir.join(MACHINE_ID_FILE_NAME), &valid.0)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        }
        let status = if self.cfg.is_default_data_dir {
            self.sync_anchor(&valid, force_refresh_anchor)
        } else {
            AnchorSyncStatus::Skipped
        };
        Ok(status)
    }

    fn restore_local_machine_id(
        &self,
        target: &str,
        active_host_pid: Option<u32>,
    ) -> PortResult<MachineIdentityRestoreOutcome> {
        let target_id = parse_machine_id(target)?;
        if self.cfg.is_default_data_dir
            && let Some(pid) = active_host_pid
        {
            return Err(PortError::new(
                PortErrorKind::Conflict,
                format!(
                    "Cannot restore machine ID while the Lody daemon is running (pid {pid}). Stop it with `lody daemon stop` and retry."
                ),
            ));
        }

        let machine_id_path = self.cfg.data_dir.join(MACHINE_ID_FILE_NAME);
        let raw_machine_id = match fs::read_to_string(&machine_id_path) {
            Ok(s) => Some(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(PortError::new(PortErrorKind::Unavailable, e.to_string())),
        };
        let previous_machine_id = raw_machine_id
            .as_deref()
            .and_then(|s| parse_machine_id(s).ok());

        let strict_creds = read_credentials_strict(&self.cfg.data_dir)?;
        let previous_credential_machine_id = strict_creds.as_ref().map(|(_, _, mid)| mid.clone());
        let existing_anchor_id = if self.cfg.is_default_data_dir {
            self.read_anchor().map(|a| MachineId(a.machine_id))
        } else {
            None
        };

        let machine_matches = previous_machine_id.as_ref() == Some(&target_id);
        let creds_match =
            strict_creds.is_none() || previous_credential_machine_id.as_ref() == Some(&target_id);
        let anchor_matches =
            !self.cfg.is_default_data_dir || existing_anchor_id.as_ref() == Some(&target_id);

        if machine_matches && creds_match && anchor_matches {
            let anchor_updated = if self.cfg.is_default_data_dir {
                self.persist_machine_id(&target_id, true)? == AnchorSyncStatus::Updated
            } else {
                false
            };
            return Ok(MachineIdentityRestoreOutcome {
                changed: anchor_updated,
                target_machine_id: target_id,
                previous_machine_id,
                previous_credential_machine_id,
                credentials_updated: false,
                anchor_updated,
                backup_dir: None,
            });
        }

        create_private_dir(&self.cfg.data_dir)
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

        let mut backup_dir: Option<PathBuf> = None;
        if raw_machine_id.is_some() || strict_creds.is_some() {
            let secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let rand = random_entropy_bytes(&self.cfg.data_dir);
            let dir = self
                .cfg
                .data_dir
                .join("identity-restore-backups")
                .join(format!("manual-{secs}-{:02x}{:02x}", rand[0], rand[1]));
            create_private_dir(&dir)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            if let Some(raw_mid) = &raw_machine_id {
                write_private_file_atomic(&dir.join(MACHINE_ID_FILE_NAME), raw_mid)
                    .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            }
            if let Some((raw_cred, _, _)) = &strict_creds {
                write_private_file_atomic(&dir.join(CREDENTIALS_FILE_NAME), raw_cred)
                    .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            }
            backup_dir = Some(dir);
        }

        let mut credentials_updated = false;
        if let Some((_, mut cred_val, _)) = strict_creds {
            if let Some(machine_obj) = cred_val.get_mut("machine").and_then(Value::as_object_mut) {
                machine_obj.insert("machineId".to_string(), Value::String(target_id.0.clone()));
            }
            let updated_json = serde_json::to_string_pretty(&cred_val)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            write_private_file_atomic(
                &self.cfg.data_dir.join(CREDENTIALS_FILE_NAME),
                &updated_json,
            )
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            credentials_updated = true;
        }

        let anchor_status = self.persist_machine_id(&target_id, true)?;
        Ok(MachineIdentityRestoreOutcome {
            changed: true,
            target_machine_id: target_id,
            previous_machine_id,
            previous_credential_machine_id,
            credentials_updated,
            anchor_updated: anchor_status == AnchorSyncStatus::Updated,
            backup_dir,
        })
    }
}
