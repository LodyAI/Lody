//! Lody encrypted-workspace RPC transport over iroh.
//!
//! This crate only moves opaque, already signed and encrypted frames between two
//! ledger devices. It never parses, verifies or authorizes a frame: the TypeScript
//! hosts keep that responsibility unchanged on every route.
//!
//! Wire format on ALPN [`ALPN`]: the dialer opens one bidirectional QUIC stream
//! per request, writes exactly one length-prefixed message and finishes its send
//! side. The listener writes zero or more length-prefixed reply messages on the
//! same stream and finishes it. A length prefix is a big-endian `u32`; messages
//! larger than [`MAX_MESSAGE_BYTES`] are refused.
//!
//! Identity: the endpoint secret is the workspace ledger device's Ed25519 seed,
//! so the EndpointId equals the ledger signing public key. A process may hold at
//! most one live endpoint per key ([`EndpointError::KeyInUse`]): two endpoints
//! sharing a key make relays evict each other (iroh issue #3813).

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::Duration,
};

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::{
        Connection, PortmapperConfig, QuicTransportConfig, RecvStream, SendStream, VarInt, presets,
    },
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::{Mutex, mpsc, watch},
    task::JoinSet,
};
use zeroize::Zeroizing;

/// ALPN identifying the Lody encrypted RPC protocol, version 1.
pub const ALPN: &[u8] = b"lody/e2ee-rpc/1";
/// Largest accepted message. A Streams envelope carries at most a 2 MiB hex frame
/// plus a short JSON wrapper; the slack keeps both routes equivalent.
pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024 + 4096;
/// Bound on requests waiting for the host to pull them. A full queue resets the
/// new stream instead of buffering without limit.
pub const INCOMING_QUEUE: usize = 128;
/// Concurrent request streams one peer may open on a listening endpoint.
pub const MAX_CONCURRENT_STREAMS_PER_PEER: u32 = 32;
/// Includes incoming handshakes, before a remote identity is available.
pub const MAX_INCOMING_CONNECTIONS: usize = 64;
pub const MAX_INCOMING_CONNECTIONS_PER_PEER: usize = 4;
const INITIAL_MESSAGE_CAPACITY: usize = 16 * 1024;
const READ_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESET_QUEUE_FULL: u32 = 1;
const RESET_CANCELLED: u32 = 2;
const CLOSE_NORMAL: u32 = 0;
const CLOSE_CONNECTION_LIMIT: u32 = 3;

/// Stable failure codes exposed to hosts. Callers branch on the code; the
/// message is diagnostic only and never contains key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointError {
    InvalidKey,
    KeyInUse,
    InvalidRelay(String),
    Bind(String),
    Closed,
    ConnectTimeout,
    Connect(String),
    Stream(String),
    TooLarge,
}

impl EndpointError {
    /// Short machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidKey => "iroh_invalid_key",
            Self::KeyInUse => "iroh_key_in_use",
            Self::InvalidRelay(_) => "iroh_invalid_relay",
            Self::Bind(_) => "iroh_bind",
            Self::Closed => "iroh_closed",
            Self::ConnectTimeout => "iroh_connect_timeout",
            Self::Connect(_) => "iroh_connect",
            Self::Stream(_) => "iroh_stream",
            Self::TooLarge => "iroh_too_large",
        }
    }
}

impl std::fmt::Display for EndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRelay(m) | Self::Bind(m) | Self::Connect(m) | Self::Stream(m) => {
                write!(f, "{}: {m}", self.code())
            }
            _ => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for EndpointError {}

/// Endpoint options supplied by a trusted native host.
pub struct EndpointConfig {
    #[cfg(test)]
    relay_only: bool,
    /// Ed25519 seed of the ledger device. Wiped when this config is dropped.
    pub secret_key: Zeroizing<[u8; 32]>,
    /// Lody relay URLs. Every dial targets all of them, so the peer is reachable
    /// on whichever relay it chose as home without any address publication.
    pub relay_urls: Vec<String>,
    /// Shared relay access token, sent as a bearer token.
    pub relay_token: Option<String>,
    /// Accept incoming requests (machine side). Dialers leave this off.
    pub accept: bool,
    /// UPnP/NAT-PMP/PCP port mapping. Mobile hosts must disable it: on iOS it
    /// raises the Local Network permission prompt.
    pub portmapper: bool,
    /// HTTP(S) proxy for relay connections (`http://host:port`). Networks that
    /// reach the internet only through a proxy cannot connect to relays without it;
    /// direct UDP paths never use it.
    pub proxy_url: Option<String>,
    /// Tests only: trust self-signed relay certificates.
    pub insecure_relay_tls: bool,
}

/// A remote ledger device to dial.
#[derive(Debug, Clone)]
pub struct Target {
    /// Ledger signing public key of the remote device (= its EndpointId).
    pub endpoint_id: [u8; 32],
    /// Optional direct addresses, mainly for loopback tests. Relays from the
    /// local configuration are always added.
    pub direct_addrs: Vec<SocketAddr>,
}

fn registry() -> &'static StdMutex<HashSet<[u8; 32]>> {
    static KEYS: OnceLock<StdMutex<HashSet<[u8; 32]>>> = OnceLock::new();
    KEYS.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// Holds one device key's process-wide reservation until dropped.
struct KeyReservation([u8; 32]);

impl KeyReservation {
    fn take(public: [u8; 32]) -> Result<Self, EndpointError> {
        let mut keys = registry().lock().unwrap_or_else(|e| e.into_inner());
        if !keys.insert(public) {
            return Err(EndpointError::KeyInUse);
        }
        Ok(Self(public))
    }
}

impl Drop for KeyReservation {
    fn drop(&mut self) {
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// One encrypted-RPC request received from a remote device.
pub struct IncomingRequest {
    /// Transport-authenticated EndpointId of the sender. This is not authority:
    /// the host still verifies the frame signer against the ledger.
    pub remote: [u8; 32],
    /// The request message exactly as written by the dialer.
    pub body: Vec<u8>,
    send: SendStream,
}

impl IncomingRequest {
    /// Writes one reply message on the request stream.
    pub async fn reply(&mut self, message: &[u8]) -> Result<(), EndpointError> {
        write_message(&mut self.send, message).await
    }

    /// Ends the reply stream after the last reply.
    pub fn finish(mut self) {
        let _ = self.send.finish();
    }

    /// Abandons the stream; the dialer observes a reset and may retry elsewhere.
    pub fn reject(mut self) {
        let _ = self.send.reset(VarInt::from_u32(RESET_CANCELLED));
    }
}

/// An in-flight call: read replies until `None` (the listener finished).
pub struct Call {
    recv: RecvStream,
    send: SendStream,
}

impl Call {
    /// Next reply message, or `None` once the listener finished the stream.
    pub async fn next_reply(&mut self) -> Result<Option<Vec<u8>>, EndpointError> {
        read_message(&mut self.recv).await
    }

    /// Stops waiting for replies. Already delivered requests are not recalled.
    pub fn cancel(mut self) {
        let _ = self.recv.stop(VarInt::from_u32(RESET_CANCELLED));
        let _ = self.send.reset(VarInt::from_u32(RESET_CANCELLED));
    }
}

/// A Lody iroh endpoint bound to one ledger device key.
pub struct LodyEndpoint {
    endpoint: Endpoint,
    relays: Vec<RelayUrl>,
    connections: Mutex<HashMap<EndpointId, Arc<Mutex<Option<Connection>>>>>,
    incoming: Mutex<mpsc::Receiver<IncomingRequest>>,
    closed: watch::Sender<bool>,
    accept_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    _reservation: KeyReservation,
}

impl LodyEndpoint {
    /// Binds an endpoint for `config.secret_key`. Fails with `KeyInUse` while
    /// another live endpoint in this process holds the same key.
    pub async fn open(config: EndpointConfig) -> Result<Arc<Self>, EndpointError> {
        let secret = SecretKey::from_bytes(&config.secret_key);
        let reservation = KeyReservation::take(*secret.public().as_bytes())?;
        let relays = config
            .relay_urls
            .iter()
            .map(|url| {
                url.parse::<RelayUrl>()
                    .map_err(|e| EndpointError::InvalidRelay(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut builder = Endpoint::builder(presets::Minimal)
            .secret_key(secret)
            .clear_address_lookup()
            // UDP segmentation offload stays off. When a NIC refuses a segmented send,
            // noq-udp lowers the socket's limit, but iroh 1.4.1 caches the limit at
            // sender creation, so open connections keep sending batches that fail
            // (iroh #4555; seen as EIO on the Android emulator, and #4647 reports
            // dropped batches on Android cellular). RPC frames are small, so batching
            // saves nothing here.
            .transport_config(
                QuicTransportConfig::builder()
                    .enable_segmentation_offload(false)
                    .build(),
            )
            .alpns(if config.accept {
                vec![ALPN.to_vec()]
            } else {
                Vec::new()
            });
        builder = if relays.is_empty() {
            builder.relay_mode(RelayMode::Disabled)
        } else {
            let mut map: RelayMap = relays.iter().cloned().collect();
            if let Some(token) = &config.relay_token {
                map = map.with_auth_token(token.clone());
            }
            builder.relay_mode(RelayMode::Custom(map))
        };
        if !config.portmapper {
            builder = builder.portmapper_config(PortmapperConfig::Disabled);
        }
        if let Some(proxy) = &config.proxy_url {
            let proxy = proxy
                .parse::<url::Url>()
                .map_err(|e| EndpointError::InvalidRelay(format!("proxy: {e}")))?;
            builder = builder.proxy_url(proxy);
        }
        #[cfg(test)]
        if config.relay_only {
            builder = builder.clear_ip_transports();
        }
        builder = with_test_tls(builder, config.insecure_relay_tls);
        let endpoint = builder
            .bind()
            .await
            .map_err(|e| EndpointError::Bind(e.to_string()))?;
        let (tx, rx) = mpsc::channel(INCOMING_QUEUE);
        let this = Arc::new(Self {
            endpoint: endpoint.clone(),
            relays,
            connections: Mutex::new(HashMap::new()),
            incoming: Mutex::new(rx),
            closed: watch::Sender::new(false),
            accept_task: StdMutex::new(None),
            _reservation: reservation,
        });
        if config.accept {
            let task = tokio::spawn(accept_loop(endpoint, tx));
            *this.accept_task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
        }
        Ok(this)
    }

    /// Lower-case hex EndpointId, equal to the ledger signing public key.
    pub fn id_hex(&self) -> String {
        hex::encode(self.endpoint.id().as_bytes())
    }

    /// Currently known direct socket addresses of this endpoint.
    pub fn direct_addrs(&self) -> Vec<SocketAddr> {
        self.endpoint.addr().ip_addrs().copied().collect()
    }

    /// Waits until a home relay is connected (or returns at once when relays are
    /// disabled). Bounded by `timeout`; returns whether it became online.
    pub async fn online(&self, timeout: Duration) -> bool {
        if self.relays.is_empty() {
            return true;
        }
        tokio::time::timeout(timeout, self.endpoint.online())
            .await
            .is_ok()
    }

    /// Whether a live connection to `endpoint_id` already exists. Never waits for
    /// a dial in progress: a peer whose slot is busy dialing is reported as not
    /// connected, so callers can use another route immediately.
    pub async fn has_connection(&self, endpoint_id: &[u8; 32]) -> bool {
        let Ok(id) = EndpointId::from_bytes(endpoint_id) else {
            return false;
        };
        let slot = self.connections.lock().await.get(&id).cloned();
        match slot.as_ref().map(|slot| slot.try_lock()) {
            Some(Ok(guard)) => guard.as_ref().is_some_and(|c| c.close_reason().is_none()),
            _ => false,
        }
    }

    /// Selected path on an existing connection. Never dials or waits for a dial.
    pub async fn connection_path(&self, endpoint_id: &[u8; 32]) -> &'static str {
        let Ok(id) = EndpointId::from_bytes(endpoint_id) else {
            return "none";
        };
        let slot = self.connections.lock().await.get(&id).cloned();
        let Some(slot) = slot else {
            return "none";
        };
        let Ok(guard) = slot.try_lock() else {
            return "none";
        };
        let Some(connection) = guard.as_ref().filter(|c| c.close_reason().is_none()) else {
            return "none";
        };
        let paths = connection.paths();
        match paths.iter().find(|path| path.is_selected()) {
            Some(path) if path.is_ip() => "direct",
            Some(path) if path.is_relay() => "relay",
            _ => "none",
        }
    }

    async fn connection(
        &self,
        target: &Target,
        timeout: Duration,
    ) -> Result<Connection, EndpointError> {
        if self.endpoint.is_closed() || *self.closed.borrow() {
            return Err(EndpointError::Closed);
        }
        let id =
            EndpointId::from_bytes(&target.endpoint_id).map_err(|_| EndpointError::InvalidKey)?;
        let slot = self
            .connections
            .lock()
            .await
            .entry(id)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone();
        // Per-peer lock: concurrent calls to one peer share a single dial, while
        // dials to other peers proceed independently.
        let mut guard = slot.lock().await;
        if let Some(conn) = guard.as_ref() {
            if conn.close_reason().is_none() {
                return Ok(conn.clone());
            }
        }
        *guard = None;
        let mut addr = EndpointAddr::new(id);
        for relay in &self.relays {
            addr = addr.with_relay_url(relay.clone());
        }
        for direct in &target.direct_addrs {
            addr = addr.with_ip_addr(*direct);
        }
        let conn = match tokio::time::timeout(timeout, self.endpoint.connect(addr, ALPN)).await {
            Err(_) => return Err(EndpointError::ConnectTimeout),
            Ok(Err(e)) => return Err(EndpointError::Connect(e.to_string())),
            Ok(Ok(conn)) => conn,
        };
        *guard = Some(conn.clone());
        Ok(conn)
    }

    /// Dials `target` (reusing a live connection) and sends one request message.
    /// `connect_timeout` bounds only connection establishment.
    pub async fn call(
        &self,
        target: &Target,
        request: &[u8],
        connect_timeout: Duration,
    ) -> Result<Call, EndpointError> {
        if request.len() > MAX_MESSAGE_BYTES {
            return Err(EndpointError::TooLarge);
        }
        let conn = self.connection(target, connect_timeout).await?;
        let (mut send, recv) = conn
            .open_bi()
            .await
            .map_err(|e| EndpointError::Stream(e.to_string()))?;
        write_message(&mut send, request).await?;
        send.finish()
            .map_err(|e| EndpointError::Stream(e.to_string()))?;
        Ok(Call { recv, send })
    }

    /// Starts dialing `target` without sending anything, so a later call can
    /// reuse the connection. Errors are reported but never retried here.
    pub async fn warm(&self, target: &Target, timeout: Duration) -> Result<(), EndpointError> {
        self.connection(target, timeout).await.map(|_| ())
    }

    /// Next incoming request, or `None` once the endpoint is closed.
    pub async fn next_request(&self) -> Option<IncomingRequest> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow() {
            return None;
        }
        tokio::select! {
            request = async { self.incoming.lock().await.recv().await } => request,
            _ = closed.wait_for(|closed| *closed) => None,
        }
    }

    /// Closes connections and the endpoint. Idempotent. The key reservation is
    /// released when the last reference to this endpoint is dropped.
    pub async fn close(&self) {
        if let Some(task) = self
            .accept_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
        self.closed.send_replace(true);
        for slot in self.connections.lock().await.drain().map(|(_, s)| s) {
            if let Some(conn) = slot.lock().await.take() {
                conn.close(VarInt::from_u32(CLOSE_NORMAL), b"close");
            }
        }
        self.endpoint.close().await;
    }
}

#[cfg(test)]
fn with_test_tls(builder: iroh::endpoint::Builder, insecure: bool) -> iroh::endpoint::Builder {
    if insecure {
        builder.ca_tls_config(iroh::tls::CaTlsConfig::insecure_skip_verify())
    } else {
        builder
    }
}

#[cfg(not(test))]
fn with_test_tls(builder: iroh::endpoint::Builder, _insecure: bool) -> iroh::endpoint::Builder {
    builder
}

/// Admission happens before spawning or handshaking. Peer IDs are retained only
/// while an admitted connection is alive; cancellation releases both limits.
#[derive(Default)]
struct ConnectionLimits(StdMutex<ConnectionCounts>);

#[derive(Default)]
struct ConnectionCounts {
    total: usize,
    peers: HashMap<EndpointId, usize>,
}

impl ConnectionLimits {
    fn try_acquire(self: &Arc<Self>) -> Option<ConnectionPermit> {
        let mut counts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if counts.total >= MAX_INCOMING_CONNECTIONS {
            return None;
        }
        counts.total += 1;
        Some(ConnectionPermit {
            limits: self.clone(),
            remote: None,
        })
    }
}

struct ConnectionPermit {
    limits: Arc<ConnectionLimits>,
    remote: Option<EndpointId>,
}

impl ConnectionPermit {
    fn admit_peer(&mut self, remote: EndpointId) -> bool {
        debug_assert!(self.remote.is_none());
        let mut counts = self.limits.0.lock().unwrap_or_else(|e| e.into_inner());
        let count = counts.peers.entry(remote).or_default();
        if *count >= MAX_INCOMING_CONNECTIONS_PER_PEER {
            return false;
        }
        *count += 1;
        self.remote = Some(remote);
        true
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        let mut counts = self.limits.0.lock().unwrap_or_else(|e| e.into_inner());
        counts.total -= 1;
        if let Some(remote) = self.remote {
            let count = counts.peers.get_mut(&remote).expect("admitted peer");
            *count -= 1;
            if *count == 0 {
                counts.peers.remove(&remote);
            }
        }
    }
}

async fn accept_loop(endpoint: Endpoint, tx: mpsc::Sender<IncomingRequest>) {
    let limits = Arc::new(ConnectionLimits::default());
    let mut tasks = JoinSet::new();
    while let Some(incoming) = endpoint.accept().await {
        while tasks.try_join_next().is_some() {}
        // Do not spawn waiters: even incomplete handshakes consume a slot.
        let Some(mut permit) = limits.try_acquire() else {
            incoming.refuse();
            continue;
        };
        let tx = tx.clone();
        tasks.spawn(async move {
            let Ok(accepting) = incoming.accept() else {
                return;
            };
            let Ok(Ok(conn)) = tokio::time::timeout(READ_REQUEST_TIMEOUT, accepting).await else {
                return;
            };
            if conn.alpn() != ALPN {
                conn.close(VarInt::from_u32(CLOSE_NORMAL), b"alpn");
                return;
            }
            if !permit.admit_peer(conn.remote_id()) {
                conn.close(
                    VarInt::from_u32(CLOSE_CONNECTION_LIMIT),
                    b"connection limit",
                );
                return;
            }
            conn.set_max_concurrent_bi_streams(VarInt::from_u32(MAX_CONCURRENT_STREAMS_PER_PEER));
            let remote = *conn.remote_id().as_bytes();
            let _permit = permit;
            let mut streams = JoinSet::new();
            loop {
                let stream = tokio::select! {
                    stream = conn.accept_bi() => stream,
                    _ = streams.join_next(), if !streams.is_empty() => continue,
                };
                let Ok((send, mut recv)) = stream else { break };
                let tx = tx.clone();
                streams.spawn(async move {
                    let body =
                        match tokio::time::timeout(READ_REQUEST_TIMEOUT, read_message(&mut recv))
                            .await
                        {
                            Ok(Ok(Some(body))) => body,
                            _ => return,
                        };
                    let request = IncomingRequest { remote, body, send };
                    if let Err(mpsc::error::TrySendError::Full(mut rejected)) = tx.try_send(request)
                    {
                        let _ = rejected.send.reset(VarInt::from_u32(RESET_QUEUE_FULL));
                    }
                });
            }
        });
    }
}

async fn write_message(send: &mut SendStream, message: &[u8]) -> Result<(), EndpointError> {
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(EndpointError::TooLarge);
    }
    let len = u32::try_from(message.len()).map_err(|_| EndpointError::TooLarge)?;
    send.write_all(&len.to_be_bytes())
        .await
        .map_err(|e| EndpointError::Stream(e.to_string()))?;
    send.write_all(message)
        .await
        .map_err(|e| EndpointError::Stream(e.to_string()))
}

async fn read_message(recv: &mut RecvStream) -> Result<Option<Vec<u8>>, EndpointError> {
    let result = read_frame(recv).await;
    if matches!(result, Err(EndpointError::TooLarge)) {
        let _ = recv.stop(VarInt::from_u32(RESET_CANCELLED));
    }
    result
}

async fn read_frame(recv: &mut (impl AsyncRead + Unpin)) -> Result<Option<Vec<u8>>, EndpointError> {
    let mut len = [0u8; 4];
    // Only EOF before the first header byte is a clean end of replies.
    if recv
        .read(&mut len[..1])
        .await
        .map_err(|e| EndpointError::Stream(e.to_string()))?
        == 0
    {
        return Ok(None);
    }
    recv.read_exact(&mut len[1..])
        .await
        .map_err(|e| EndpointError::Stream(e.to_string()))?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_MESSAGE_BYTES {
        return Err(EndpointError::TooLarge);
    }
    let mut body = Vec::with_capacity(len.min(INITIAL_MESSAGE_CAPACITY));
    recv.take(len as u64)
        .read_to_end(&mut body)
        .await
        .map_err(|e| EndpointError::Stream(e.to_string()))?;
    if body.len() != len {
        return Err(EndpointError::Stream("truncated message body".into()));
    }
    Ok(Some(body))
}

#[cfg(test)]
mod tests;
