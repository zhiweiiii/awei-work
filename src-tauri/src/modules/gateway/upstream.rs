//! The outbound half: one blocking call into a relay, driven by a runtime that
//! only exists once a request has actually been made.

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde_json::Value;

use super::config::{ApiFormat, AuthStyle, Provider};

/// Created on first use so an install that never opens the gateway pays
/// nothing for it. Two workers are enough: they only drive the IO reactor,
/// because `block_on` runs the request future on the calling connection thread.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("terax-gateway-io")
            .enable_all()
            .build()
            .expect("gateway runtime")
    })
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        // The connector registers its resolver and timers with the reactor as
        // it is built, so construction has to happen inside the runtime even
        // though no request is sent yet.
        let _guard = runtime().enter();
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            // No overall timeout: a long generation is a normal response, not a
            // stalled one. A dead connection is caught by the read timeout.
            .read_timeout(Duration::from_secs(180))
            .build()
            .expect("gateway http client")
    })
}

pub struct Response {
    pub status: StatusCode,
    pub is_sse: bool,
    pub body: reqwest::Response,
}

fn request_headers(provider: &Provider, session: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let key = provider.api_key.trim();
    // A pasted key can contain characters that cannot live in a header. Sending
    // nothing yields a clean 401 from the relay instead of a panic here.
    let Ok(value) = HeaderValue::from_str(key) else {
        return headers;
    };
    match provider.auth_style {
        AuthStyle::ApiKey => {
            headers.insert(HeaderName::from_static("x-api-key"), value);
        }
        AuthStyle::Bearer => {
            if let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {key}")) {
                headers.insert(reqwest::header::AUTHORIZATION, bearer);
            }
        }
    }
    if provider.api_format == ApiFormat::Anthropic {
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static("2023-06-01"),
        );
    }
    if provider.wants_session_header() {
        if let Some(value) = session.and_then(|s| HeaderValue::from_str(s).ok()) {
            headers.insert(HeaderName::from_static("x-opencode-session"), value);
        }
    }
    headers
}

/// Send one converted request. Returns the live response so the caller can
/// stream it; the body is not read here.
pub fn send(provider: &Provider, body: &Value, session: Option<&str>) -> Result<Response, String> {
    let url = provider.messages_url();
    let headers = request_headers(provider, session);
    let request = client().post(&url).headers(headers).json(body);
    // `send` arms the timeout as it is called, not when the future is polled,
    // so it has to be called from inside the runtime rather than passed in.
    let response = runtime()
        .block_on(async { request.send().await })
        .map_err(|e| format!("{e}"))?;
    let is_sse = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    Ok(Response {
        status: response.status(),
        is_sse,
        body: response,
    })
}

/// Read the whole body. Used for non-streaming replies and for error bodies.
pub fn read_all(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for_each_chunk(response, |chunk| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok(bytes)
}

/// Pump the response body, handing each chunk to `on_chunk`. Running on the
/// calling thread means `on_chunk` may block on socket writes without stalling
/// the reactor.
pub fn for_each_chunk<F>(response: reqwest::Response, mut on_chunk: F) -> Result<(), String>
where
    F: FnMut(&[u8]) -> Result<(), String>,
{
    runtime().block_on(async {
        let mut stream = response.bytes_stream();
        let mut received = 0usize;
        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| format!("{e}"))?;
            received = received.saturating_add(chunk.len());
            if received > 64 * 1024 * 1024 {
                return Err("upstream response exceeds size limit".into());
            }
            on_chunk(&chunk)?;
        }
        Ok(())
    })
}
