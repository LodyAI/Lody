use std::time::Duration;

use zeroize::Zeroizing;

use super::*;

const WAIT: Duration = Duration::from_secs(20);

fn config(seed: u8, accept: bool, relays: Vec<String>) -> EndpointConfig {
    EndpointConfig {
        secret_key: Zeroizing::new([seed; 32]),
        relay_urls: relays,
        relay_token: None,
        accept,
        portmapper: false,
        insecure_relay_tls: true,
    }
}

fn public(seed: u8) -> [u8; 32] {
    *SecretKey::from_bytes(&[seed; 32]).public().as_bytes()
}

/// Listener that replies with the request reversed, then "done", for each request.
fn serve(endpoint: Arc<LodyEndpoint>) -> tokio::task::JoinHandle<Vec<[u8; 32]>> {
    tokio::spawn(async move {
        let mut seen = Vec::new();
        while let Some(mut request) = endpoint.next_request().await {
            seen.push(request.remote);
            let mut reversed = request.body.clone();
            reversed.reverse();
            request.reply(&reversed).await.unwrap();
            request.reply(b"done").await.unwrap();
            request.finish();
        }
        seen
    })
}

async fn collect(mut call: Call) -> Vec<Vec<u8>> {
    let mut replies = Vec::new();
    while let Some(reply) = tokio::time::timeout(WAIT, call.next_reply())
        .await
        .expect("reply in time")
        .expect("reply readable")
    {
        replies.push(reply);
    }
    replies
}

#[tokio::test(flavor = "multi_thread")]
async fn direct_call_returns_every_reply_and_authenticates_the_dialer() {
    let listener = LodyEndpoint::open(config(1, true, vec![])).await.unwrap();
    let dialer = LodyEndpoint::open(config(2, false, vec![])).await.unwrap();
    assert_eq!(listener.id_hex(), hex::encode(public(1)));
    let server = serve(listener.clone());
    let target = Target {
        endpoint_id: public(1),
        direct_addrs: listener.direct_addrs(),
    };
    assert!(!dialer.has_connection(&target.endpoint_id).await);
    let call = dialer.call(&target, b"abc", WAIT).await.unwrap();
    assert_eq!(collect(call).await, vec![b"cba".to_vec(), b"done".to_vec()]);
    assert!(dialer.has_connection(&target.endpoint_id).await);
    // A second request reuses the live connection.
    let call = dialer.call(&target, b"xy", WAIT).await.unwrap();
    assert_eq!(collect(call).await, vec![b"yx".to_vec(), b"done".to_vec()]);
    listener.close().await;
    dialer.close().await;
    assert_eq!(server.await.unwrap(), vec![public(2), public(2)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_live_endpoint_per_device_key() {
    let first = LodyEndpoint::open(config(3, false, vec![])).await.unwrap();
    let second = LodyEndpoint::open(config(3, true, vec![])).await;
    assert_eq!(second.err(), Some(EndpointError::KeyInUse));
    first.close().await;
    drop(first);
    let again = LodyEndpoint::open(config(3, false, vec![])).await.unwrap();
    again.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dial_reaches_a_peer_homed_on_any_configured_relay() {
    let (_map_a, url_a, _server_a) = iroh::test_utils::run_relay_server().await.unwrap();
    let (_map_b, url_b, _server_b) = iroh::test_utils::run_relay_server().await.unwrap();
    // The listener only knows relay B; the dialer knows both and publishes nothing.
    let listener = LodyEndpoint::open(config(4, true, vec![url_b.to_string()]))
        .await
        .unwrap();
    assert!(listener.online(WAIT).await);
    let dialer = LodyEndpoint::open(config(
        5,
        false,
        vec![url_a.to_string(), url_b.to_string()],
    ))
    .await
    .unwrap();
    let server = serve(listener.clone());
    let target = Target {
        endpoint_id: public(4),
        direct_addrs: Vec::new(),
    };
    let call = dialer.call(&target, b"relay", WAIT).await.unwrap();
    assert_eq!(collect(call).await, vec![b"yaler".to_vec(), b"done".to_vec()]);
    listener.close().await;
    dialer.close().await;
    assert_eq!(server.await.unwrap(), vec![public(5)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_request_is_refused_before_dialing() {
    let dialer = LodyEndpoint::open(config(6, false, vec![])).await.unwrap();
    let target = Target {
        endpoint_id: public(7),
        direct_addrs: Vec::new(),
    };
    let request = vec![0u8; MAX_MESSAGE_BYTES + 1];
    let result = dialer.call(&target, &request, WAIT).await;
    assert_eq!(result.err(), Some(EndpointError::TooLarge));
    dialer.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unreachable_peer_fails_within_the_connect_budget() {
    let dialer = LodyEndpoint::open(config(8, false, vec![])).await.unwrap();
    let target = Target {
        endpoint_id: public(9),
        direct_addrs: Vec::new(),
    };
    let result = dialer.call(&target, b"x", Duration::from_millis(300)).await;
    assert!(matches!(
        result.err(),
        Some(EndpointError::ConnectTimeout | EndpointError::Connect(_))
    ));
    dialer.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_request_resets_the_dialer_stream() {
    let listener = LodyEndpoint::open(config(10, true, vec![])).await.unwrap();
    let dialer = LodyEndpoint::open(config(11, false, vec![])).await.unwrap();
    let rejecter = {
        let listener = listener.clone();
        tokio::spawn(async move {
            let request = listener.next_request().await.unwrap();
            request.reject();
        })
    };
    let target = Target {
        endpoint_id: public(10),
        direct_addrs: listener.direct_addrs(),
    };
    let mut call = dialer.call(&target, b"x", WAIT).await.unwrap();
    rejecter.await.unwrap();
    let reply = tokio::time::timeout(WAIT, call.next_reply()).await.unwrap();
    assert!(matches!(reply, Err(EndpointError::Stream(_))));
    listener.close().await;
    dialer.close().await;
}
