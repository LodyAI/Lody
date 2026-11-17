//! Node-API binding of `lody-iroh` for the Electron main process and the CLI.
//!
//! The binding exposes connection and frame transfer only: no signing, no key
//! export and no frame interpretation. `openEndpoint` copies the 32-byte device
//! seed and overwrites the caller's buffer with zeros before returning.

#![deny(clippy::all)]

use std::{net::SocketAddr, sync::Arc, time::Duration};

use lody_iroh::{EndpointConfig, EndpointError, LodyEndpoint, Target};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::{Mutex, watch};
use zeroize::{Zeroize, Zeroizing};

fn js_error(error: EndpointError) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

/// Options for {@link openEndpoint}. Relay URLs and token come only from the
/// official build composition.
#[napi(object)]
pub struct OpenOptions {
    pub relay_urls: Vec<String>,
    pub relay_token: Option<String>,
    /// Accept incoming requests (machine side).
    pub accept: bool,
    /// UPnP/NAT-PMP/PCP port mapping; defaults to enabled.
    pub portmapper: Option<bool>,
    /// HTTP(S) proxy for relay connections, e.g. `http://127.0.0.1:7890`.
    pub proxy_url: Option<String>,
}

/// A remote ledger device.
#[napi(object)]
pub struct CallTarget {
    /// 64 lower-case hex characters: the remote ledger signing public key.
    pub endpoint_id: String,
    /// Optional direct `ip:port` addresses (tests and local diagnostics).
    pub direct_addrs: Option<Vec<String>>,
}

fn parse_target(target: CallTarget) -> Result<Target> {
    let mut endpoint_id = [0u8; 32];
    if target.endpoint_id.len() != 64
        || hex::decode_to_slice(&target.endpoint_id, &mut endpoint_id).is_err()
    {
        return Err(js_error(EndpointError::InvalidKey));
    }
    let direct_addrs = target
        .direct_addrs
        .unwrap_or_default()
        .iter()
        .map(|addr| {
            addr.parse::<SocketAddr>()
                .map_err(|_| Error::new(Status::InvalidArg, "iroh_invalid_addr"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Target {
        endpoint_id,
        direct_addrs,
    })
}

/// Opens an endpoint for one ledger device seed. The seed buffer is zeroed
/// before this function returns, whether or not opening succeeds.
#[napi(ts_return_type = "Promise<IrohEndpoint>")]
pub fn open_endpoint<'env>(
    env: &'env Env,
    mut secret_key: Buffer,
    options: OpenOptions,
) -> Result<PromiseRaw<'env, IrohEndpoint>> {
    let valid = secret_key.len() == 32;
    let mut seed = Zeroizing::new([0u8; 32]);
    if valid {
        seed.copy_from_slice(&secret_key);
    }
    secret_key.as_mut().zeroize();
    if !valid {
        return env.spawn_future(async { Err(js_error(EndpointError::InvalidKey)) });
    }
    let config = EndpointConfig {
        secret_key: seed,
        relay_urls: options.relay_urls,
        relay_token: options.relay_token,
        accept: options.accept,
        portmapper: options.portmapper.unwrap_or(true),
        proxy_url: options.proxy_url,
        insecure_relay_tls: false,
    };
    env.spawn_future(async move {
        let inner = LodyEndpoint::open(config).await.map_err(js_error)?;
        Ok(IrohEndpoint { inner })
    })
}

/// A live endpoint bound to one ledger device key.
#[napi]
pub struct IrohEndpoint {
    inner: Arc<LodyEndpoint>,
}

#[napi]
impl IrohEndpoint {
    /// Lower-case hex EndpointId (the ledger signing public key).
    #[napi(getter)]
    pub fn endpoint_id(&self) -> String {
        self.inner.id_hex()
    }

    /// Known direct `ip:port` addresses of this endpoint.
    #[napi]
    pub fn direct_addrs(&self) -> Vec<String> {
        self.inner
            .direct_addrs()
            .into_iter()
            .map(|addr| addr.to_string())
            .collect()
    }

    /// Resolves `true` once a home relay is connected, or `false` after `timeoutMs`.
    #[napi]
    pub async fn online(&self, timeout_ms: u32) -> bool {
        self.inner
            .online(Duration::from_millis(timeout_ms.into()))
            .await
    }

    /// Whether a live connection to the target exists.
    #[napi]
    pub async fn has_connection(&self, endpoint_id: String) -> Result<bool> {
        let target = parse_target(CallTarget {
            endpoint_id,
            direct_addrs: None,
        })?;
        Ok(self.inner.has_connection(&target.endpoint_id).await)
    }

    /// Selected path of an existing connection; never dials.
    #[napi]
    pub async fn connection_path(&self, endpoint_id: String) -> Result<String> {
        let target = parse_target(CallTarget {
            endpoint_id,
            direct_addrs: None,
        })?;
        Ok(self
            .inner
            .connection_path(&target.endpoint_id)
            .await
            .to_owned())
    }

    /// Prepares a connection without sending anything. Rejects with an
    /// `iroh_*` code when it cannot connect within `timeoutMs`.
    #[napi]
    pub async fn warm(&self, target: CallTarget, timeout_ms: u32) -> Result<()> {
        let target = parse_target(target)?;
        self.inner
            .warm(&target, Duration::from_millis(timeout_ms.into()))
            .await
            .map_err(js_error)
    }

    /// Sends one request message and returns its reply stream.
    #[napi]
    pub async fn call(
        &self,
        target: CallTarget,
        request: Buffer,
        connect_timeout_ms: u32,
    ) -> Result<IrohCall> {
        let target = parse_target(target)?;
        let call = self
            .inner
            .call(
                &target,
                &request,
                Duration::from_millis(connect_timeout_ms.into()),
            )
            .await
            .map_err(js_error)?;
        Ok(IrohCall {
            inner: Mutex::new(Some(call)),
            cancelled: watch::Sender::new(false),
        })
    }

    /// Next incoming request, or `null` once the endpoint closes.
    #[napi]
    pub async fn next_request(&self) -> Option<IrohRequest> {
        let request = self.inner.next_request().await?;
        Some(IrohRequest {
            remote: hex::encode(request.remote),
            body: request.body.clone(),
            inner: Mutex::new(Some(request)),
        })
    }

    /// Closes the endpoint and its connections. Idempotent.
    #[napi]
    pub async fn close(&self) {
        self.inner.close().await;
    }
}

/// Replies of one outgoing request.
#[napi]
pub struct IrohCall {
    inner: Mutex<Option<lody_iroh::Call>>,
    cancelled: watch::Sender<bool>,
}

#[napi]
impl IrohCall {
    /// Next reply, or `null` when the listener finished the stream or the call
    /// was cancelled.
    #[napi]
    pub async fn next_reply(&self) -> Result<Option<Buffer>> {
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
        match reply.map_err(js_error)? {
            Some(reply) => Ok(Some(reply.into())),
            None => {
                guard.take();
                Ok(None)
            }
        }
    }

    /// Stops reading replies and resets the stream. Returns at once, even while a
    /// `nextReply` is waiting: that read ends with `null`.
    #[napi]
    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
        if let Ok(mut guard) = self.inner.try_lock() {
            if let Some(call) = guard.take() {
                call.cancel();
            }
        }
    }
}

/// One incoming request on a listening endpoint.
#[napi]
pub struct IrohRequest {
    remote: String,
    body: Vec<u8>,
    inner: Mutex<Option<lody_iroh::IncomingRequest>>,
}

#[napi]
impl IrohRequest {
    /// Transport-authenticated sender EndpointId (hex). Not authority.
    #[napi(getter)]
    pub fn remote_endpoint_id(&self) -> String {
        self.remote.clone()
    }

    /// The request message as written by the dialer.
    #[napi(getter)]
    pub fn body(&self) -> Buffer {
        self.body.clone().into()
    }

    /// Writes one reply message.
    #[napi]
    pub async fn reply(&self, message: Buffer) -> Result<()> {
        let mut guard = self.inner.lock().await;
        let request = guard
            .as_mut()
            .ok_or_else(|| js_error(EndpointError::Closed))?;
        request.reply(&message).await.map_err(js_error)
    }

    /// Ends the reply stream.
    #[napi]
    pub async fn finish(&self) {
        if let Some(request) = self.inner.lock().await.take() {
            request.finish();
        }
    }

    /// Abandons the request; the dialer sees a reset.
    #[napi]
    pub async fn reject(&self) {
        if let Some(request) = self.inner.lock().await.take() {
            request.reject();
        }
    }
}
