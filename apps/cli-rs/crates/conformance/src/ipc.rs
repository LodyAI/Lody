use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const LOCAL_CONTROL_HEADER: &str = "x-lody-local-control";
pub const LOCAL_IPC_TOKEN_HEADER: &str = "x-lody-ipc-token";
pub const LOCAL_PROBE_HEALTH_PATH: &str = "/healthz";
pub const LOCAL_PROBE_STATE_PATH: &str = "/state";
pub const LOCAL_SESSION_CONTROL_PATH: &str = "/session-control";
pub const LOCAL_PROJECT_CONTROL_PATH: &str = "/project-control";
pub const LOCAL_MACHINE_RPC_PATH: &str = "/machine-rpc";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRunFile {
    pub pid: u32,
    pub socket_path: String,
    pub control_socket_path: String,
    pub version: String,
    pub started_at: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub data_plane_socket_path: Option<String>,
}

impl DaemonRunFile {
    pub fn read_from_data_dir(data_dir: &Path) -> io::Result<Self> {
        let path = data_dir.join("run").join("daemon.json");
        let raw = fs::read_to_string(path)?;
        serde_json::from_str(&raw).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

#[derive(Debug, Clone)]
pub struct LocalIpcClient {
    probe_socket: PathBuf,
    control_socket: PathBuf,
    token: Option<String>,
}

impl LocalIpcClient {
    pub fn from_run_file(run_file: &DaemonRunFile) -> Self {
        Self {
            probe_socket: PathBuf::from(&run_file.socket_path),
            control_socket: PathBuf::from(&run_file.control_socket_path),
            token: run_file.token.clone(),
        }
    }

    pub fn probe_health(&self) -> io::Result<Value> {
        let (_, body) = self.send_http(
            &self.probe_socket,
            "GET",
            LOCAL_PROBE_HEALTH_PATH,
            None,
            None,
        )?;
        serde_json::from_str(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn probe_state(&self) -> io::Result<Value> {
        let (_, body) = self.send_http(
            &self.probe_socket,
            "GET",
            LOCAL_PROBE_STATE_PATH,
            None,
            None,
        )?;
        serde_json::from_str(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn project_control(&self, payload: &Value) -> io::Result<Value> {
        let (_, body) = self.send_http(
            &self.control_socket,
            "POST",
            LOCAL_PROJECT_CONTROL_PATH,
            Some(payload),
            None,
        )?;
        serde_json::from_str(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn machine_rpc(&self, payload: &Value) -> io::Result<Value> {
        let (_, body) = self.send_http(
            &self.control_socket,
            "POST",
            LOCAL_MACHINE_RPC_PATH,
            Some(payload),
            None,
        )?;
        serde_json::from_str(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn session_control(&self, payload: &Value) -> io::Result<Vec<Value>> {
        let (_, body) = self.send_http(
            &self.control_socket,
            "POST",
            LOCAL_SESSION_CONTROL_PATH,
            Some(payload),
            Some("application/x-ndjson"),
        )?;
        if let Ok(envelope) = serde_json::from_str::<Value>(&body)
            && let Some(arr) = envelope.get("responses").and_then(Value::as_array)
        {
            return Ok(arr.clone());
        }
        let mut responses = Vec::new();
        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let frame: Value = serde_json::from_str(trimmed)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            match frame.get("kind").and_then(Value::as_str) {
                Some("response") => {
                    if let Some(resp) = frame.get("response") {
                        responses.push(resp.clone());
                    }
                }
                Some("error") => {
                    let msg = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("local session control error");
                    return Err(io::Error::other(msg.to_string()));
                }
                _ => {}
            }
        }
        Ok(responses)
    }

    #[cfg(unix)]
    fn send_http(
        &self,
        socket_path: &Path,
        method: &str,
        path: &str,
        body: Option<&Value>,
        accept: Option<&str>,
    ) -> io::Result<(u16, String)> {
        use std::os::unix::net::UnixStream;

        let mut stream = UnixStream::connect(socket_path)?;
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        stream.set_write_timeout(Some(Duration::from_secs(30)))?;

        let body_bytes = match body {
            Some(v) => serde_json::to_vec(v)?,
            None => Vec::new(),
        };

        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{LOCAL_CONTROL_HEADER}: 1\r\n"
        );
        if let Some(token) = &self.token {
            req.push_str(&format!("{LOCAL_IPC_TOKEN_HEADER}: {token}\r\n"));
        }
        if let Some(acc) = accept {
            req.push_str(&format!("Accept: {acc}\r\n"));
        }
        if body.is_some() {
            req.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body_bytes.len()
            ));
        }
        req.push_str("\r\n");

        stream.write_all(req.as_bytes())?;
        if !body_bytes.is_empty() {
            stream.write_all(&body_bytes)?;
        }
        stream.flush()?;

        read_http_response(stream)
    }

    #[cfg(not(unix))]
    fn send_http(
        &self,
        _socket_path: &Path,
        _method: &str,
        _path: &str,
        _body: Option<&Value>,
        _accept: Option<&str>,
    ) -> io::Result<(u16, String)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Named pipe HTTP transport is not yet wired on non-Unix hosts",
        ))
    }
}

fn read_http_response<R: Read>(stream: R) -> io::Result<(u16, String)> {
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line)?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP status line"))?;

    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            let lower = name.trim().to_ascii_lowercase();
            let val = val.trim();
            if lower == "transfer-encoding" && val.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            } else if lower == "content-length" {
                content_length = val.parse::<usize>().ok();
            }
        }
    }

    let raw_bytes = if chunked {
        read_chunked_body(&mut reader)?
    } else if let Some(len) = content_length {
        let mut buf = vec![0u8; len];
        reader.read_exact(&mut buf)?;
        buf
    } else {
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf)?;
        buf
    };

    let text =
        String::from_utf8(raw_bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok((status, text))
}

fn read_chunked_body<R: BufRead>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let mut size_line = String::new();
        reader.read_line(&mut size_line)?;
        let hex = size_line.trim().split(';').next().unwrap_or("0");
        let chunk_len = usize::from_str_radix(hex, 16)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        if chunk_len == 0 {
            let mut trailer = String::new();
            let _ = reader.read_line(&mut trailer);
            break;
        }
        let mut chunk = vec![0u8; chunk_len];
        reader.read_exact(&mut chunk)?;
        out.extend_from_slice(&chunk);
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf)?;
    }
    Ok(out)
}
