//! UniFFI binding of `lody-iroh` for the mobile native shells.
//!
//! Mobile devices only dial: the CLI machine listens. The binding exposes
//! connection and frame transfer only. `open` copies the 32-byte device seed and
//! the generated Swift/Kotlin wrappers must not keep their own copy; port mapping
//! is always disabled (it raises the iOS Local Network prompt).

use std::{sync::Arc, time::Duration};

use lody_iroh::{EndpointConfig, EndpointError, LodyEndpoint, Target};
use tokio::sync::{Mutex, watch};
use zeroize::Zeroizing;

uniffi::setup_scaffolding!();

/// Stable `iroh_*` failure code; hosts treat any error as "use Streams RPC".
#[derive(Debug, uniffi::Error)]
pub enum IrohError {
    Failed { code: String },
}

impl std::fmt::Display for IrohError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed { code } => f.write_str(code),
        }
    }
}

impl From<EndpointError> for IrohError {
    fn from(error: EndpointError) -> Self {
        Self::Failed {
            code: error.code().to_string(),
        }
    }
}

fn target(endpoint_id: &str) -> Result<Target, IrohError> {
    let mut id = [0u8; 32];
    if endpoint_id.len() != 64 || hex::decode_to_slice(endpoint_id, &mut id).is_err() {
        return Err(EndpointError::InvalidKey.into());
    }
    Ok(Target {
        endpoint_id: id,
        direct_addrs: Vec::new(),
    })
}

/// A dial-only endpoint for one ledger device seed.
#[derive(uniffi::Object)]
pub struct MobileIrohEndpoint {
    inner: Arc<LodyEndpoint>,
}

/// Opens an endpoint. `seed` must be the 32-byte device seed; the Rust copy is
/// wiped when the endpoint drops. `proxy_url` is an optional HTTP(S) proxy.
#[uniffi::export(async_runtime = "tokio")]
pub async fn open_mobile_endpoint(
    seed: Vec<u8>,
    relay_urls: Vec<String>,
    relay_token: Option<String>,
    proxy_url: Option<String>,
) -> Result<Arc<MobileIrohEndpoint>, IrohError> {
    let mut seed = Zeroizing::new(seed);
    if seed.len() != 32 {
        return Err(EndpointError::InvalidKey.into());
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&seed);
    seed.iter_mut().for_each(|b| *b = 0);
    let inner = LodyEndpoint::open(EndpointConfig {
        secret_key: key,
        relay_urls,
        relay_token,
        accept: false,
        portmapper: false,
        proxy_url,
        insecure_relay_tls: false,
    })
    .await?;
    Ok(Arc::new(MobileIrohEndpoint { inner }))
}

#[uniffi::export(async_runtime = "tokio")]
impl MobileIrohEndpoint {
    /// Lower-case hex EndpointId (the ledger signing public key).
    pub fn endpoint_id(&self) -> String {
        self.inner.id_hex()
    }

    /// Whether a live connection exists; never waits for a dial in progress.
    pub async fn has_connection(&self, endpoint_id: String) -> Result<bool, IrohError> {
        Ok(self.inner.has_connection(&target(&endpoint_id)?.endpoint_id).await)
    }

    /// Prepares a connection; errors once `timeout_ms` passes without one.
    pub async fn warm(&self, endpoint_id: String, timeout_ms: u32) -> Result<(), IrohError> {
        Ok(self
            .inner
            .warm(&target(&endpoint_id)?, Duration::from_millis(timeout_ms.into()))
            .await?)
    }

    /// Sends one request message; read replies from the returned call.
    pub async fn call(
        &self,
        endpoint_id: String,
        request: Vec<u8>,
        connect_timeout_ms: u32,
    ) -> Result<Arc<MobileIrohCall>, IrohError> {
        let call = self
            .inner
            .call(
                &target(&endpoint_id)?,
                &request,
                Duration::from_millis(connect_timeout_ms.into()),
            )
            .await?;
        Ok(Arc::new(MobileIrohCall {
            inner: Mutex::new(Some(call)),
            cancelled: watch::Sender::new(false),
        }))
    }

    /// Closes the endpoint and its connections. Idempotent. Not named `close`:
    /// Kotlin bindings already generate `AutoCloseable.close()` on every object.
    pub async fn shutdown(&self) {
        self.inner.close().await;
    }
}

/// Replies of one outgoing request.
#[derive(uniffi::Object)]
pub struct MobileIrohCall {
    inner: Mutex<Option<lody_iroh::Call>>,
    cancelled: watch::Sender<bool>,
}

#[uniffi::export(async_runtime = "tokio")]
impl MobileIrohCall {
    /// Next reply, or `None` once the stream finished or the call was cancelled.
    pub async fn next_reply(&self) -> Result<Option<Vec<u8>>, IrohError> {
        let mut cancelled = self.cancelled.subscribe();
        let mut guard = self.inner.lock().await;
        if *cancelled.borrow() {
            if let Some(call) = guard.take() {
                call.cancel();
            }
            return Ok(None);
        }
        let Some(call) = guard.as_mut() else {
            return Ok(None);
        };
        let reply = tokio::select! {
            reply = call.next_reply() => reply,
            _ = cancelled.wait_for(|cancelled| *cancelled) => {
                if let Some(call) = guard.take() {
                    call.cancel();
                }
                return Ok(None);
            }
        };
        match reply? {
            Some(reply) => Ok(Some(reply)),
            None => {
                guard.take();
                Ok(None)
            }
        }
    }

    /// Stops reading and resets the stream at once; a pending read returns `None`.
    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
        if let Ok(mut guard) = self.inner.try_lock() {
            if let Some(call) = guard.take() {
                call.cancel();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lody_iroh::EndpointConfig;

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_a_seed_of_the_wrong_length() {
        let result = open_mobile_endpoint(vec![1; 31], vec![], None, None).await;
        assert!(matches!(result, Err(IrohError::Failed { code }) if code == "iroh_invalid_key"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_ends_a_pending_reply_read_while_the_listener_holds_the_stream() {
        let listener = LodyEndpoint::open(EndpointConfig {
            secret_key: Zeroizing::new([21; 32]),
            relay_urls: vec![],
            relay_token: None,
            accept: true,
            portmapper: false,
            proxy_url: None,
            insecure_relay_tls: false,
        })
        .await
        .unwrap();
        let mobile = open_mobile_endpoint(vec![22; 32], vec![], None, None).await.unwrap();
        // Mobile dials by key only; reach the loopback listener through its core.
        let call = mobile
            .inner
            .call(
                &Target {
                    endpoint_id: hex::decode(listener.id_hex()).unwrap().try_into().unwrap(),
                    direct_addrs: listener.direct_addrs(),
                },
                b"hold",
                Duration::from_secs(10),
            )
            .await
            .unwrap();
        let held = listener.next_request().await.expect("request");
        let call = Arc::new(MobileIrohCall {
            inner: Mutex::new(Some(call)),
            cancelled: watch::Sender::new(false),
        });
        let reader = {
            let call = call.clone();
            tokio::spawn(async move { call.next_reply().await })
        };
        tokio::task::yield_now().await;
        call.cancel();
        let read = tokio::time::timeout(Duration::from_secs(20), reader).await;
        assert!(matches!(read, Ok(Ok(Ok(None)))));
        drop(held);
        mobile.shutdown().await;
        listener.close().await;
    }
}
