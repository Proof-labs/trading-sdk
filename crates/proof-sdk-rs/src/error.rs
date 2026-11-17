//! The one error type every client call returns.

use std::fmt;

use proof_trading_sdk::gateway::{ErrorKind, GatewayError, TxHash};

use crate::exchange::SignedTx;
use proof_trading_sdk::SignerError;

/// A client failure. Never carries a key, signature or API key in its text.
///
/// Engine rejections and gateway refusals are not errors: they come back as
/// [`crate::TxStatus`]. An `Err` means the call did not get an answer, or the
/// caller passed something unusable.
///
/// The client keeps no state about a failed submission. When a submission may
/// have reached the gateway, the error is [`Error::Unconfirmed`] and carries
/// the signed transaction: reconcile its hash with
/// [`crate::ExchangeClient::wait_for_receipt`], or resend the same bytes,
/// before signing a replacement.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The configuration was refused (bad URL, out-of-range timeout, invalid
    /// API key).
    Config(String),
    /// A caller argument was malformed (address, hash, path).
    InvalidInput(String),
    /// The request failed below HTTP (connect, TLS, reset) or timed out.
    Transport(Box<dyn std::error::Error + Send + Sync>),
    /// The gateway answered with a non-success status. `body` is its error
    /// text, truncated, and may be empty.
    Http { status: u16, body: String },
    /// The response did not decode as the type the route promises.
    Decode(String),
    /// A row of a history page did not decode, so the page is refused.
    /// `next_cursor` is the page's own cursor: pass it back to continue after
    /// this page (losing its other rows), or narrow `limit` and the window to
    /// isolate the row. `None` on the last page.
    HistoryRow {
        message: String,
        next_cursor: Option<String>,
    },
    /// An account read needs a mark price the engine doesn't have (gateway
    /// `503 errorCode=MissingMark`), for example a held market left unpriced
    /// after a resolution. Retry once the market is priced.
    MissingMark { message: String },
    /// The response exceeded the configured cap
    /// ([`crate::ClientConfig::with_max_read_bytes`]).
    ResponseTooLarge,
    /// The action could not be encoded (engine `ExecError` text).
    Encode(String),
    /// The signing backend failed.
    Signer(SignerError),
    /// The nonce allocator refused to run more than its safety window ahead of
    /// the wall clock.
    NonceWindow { next: u64, now_ms: u64 },
    /// No committed receipt for `hash` arrived before the deadline. The
    /// transaction may still land.
    ReceiptTimeout { hash: TxHash },
    /// The WebSocket handshake failed or timed out.
    WsConnect(String),
    /// The feed has closed; the handle can no longer subscribe.
    Closed,
    /// The gateway's chain differs from the one the client was configured for.
    ChainMismatch { expected: String, actual: String },
    /// A submission got no verdict and may have landed. `tx` is exactly what
    /// was sent; `source` is why no verdict came back.
    Unconfirmed { tx: SignedTx, source: Box<Error> },
    /// A core transport failure with no closer match above (a hash mismatch,
    /// a rejected option), as the core reported it.
    Gateway(GatewayError),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Config(m) => write!(f, "invalid configuration: {m}"),
            Error::InvalidInput(m) => write!(f, "invalid input: {m}"),
            Error::Transport(e) => write!(f, "transport: {e}"),
            Error::Http { status, body } => write!(f, "HTTP {status}: {body}"),
            Error::Decode(m) => write!(f, "decode: {m}"),
            Error::HistoryRow { message, .. } => write!(f, "decode: {message}"),
            Error::MissingMark { message } => write!(f, "mark price unavailable: {message}"),
            Error::ResponseTooLarge => f.write_str("response exceeds max_read_bytes"),
            Error::Encode(m) => write!(f, "encode: {m}"),
            Error::Signer(e) => write!(f, "{e}"),
            Error::NonceWindow { next, now_ms } => write!(
                f,
                "nonce {next} would run more than 60s ahead of the clock ({now_ms})"
            ),
            Error::ReceiptTimeout { hash } => write!(f, "no committed receipt for {hash} yet"),
            Error::WsConnect(m) => write!(f, "websocket connect: {m}"),
            Error::Closed => f.write_str("the feed is closed"),
            Error::ChainMismatch { expected, actual } => {
                write!(f, "gateway serves chain {actual:?}, expected {expected:?}")
            }
            Error::Unconfirmed { tx, source } => {
                write!(f, "{} may have landed: {source}", tx.hash)
            }
            Error::Gateway(e) => write!(f, "gateway: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Transport(e) => Some(&**e),
            Error::Signer(e) => Some(e),
            Error::Unconfirmed { source, .. } => Some(&**source),
            Error::Gateway(e) => Some(e),
            _ => None,
        }
    }
}

/// The core transport's failures, folded into the variants the reads use
/// where one fits exactly, so one failure has one name whichever path the
/// call took. Anything else stays [`Error::Gateway`].
impl From<GatewayError> for Error {
    fn from(e: GatewayError) -> Self {
        match e.kind {
            ErrorKind::Transport | ErrorKind::Timeout | ErrorKind::RpcUnavailable => {
                Error::Transport(Box::new(e))
            }
            ErrorKind::BodyTooLarge => Error::ResponseTooLarge,
            ErrorKind::HttpStatus(status) => Error::Http {
                status,
                body: e.log.unwrap_or_default(),
            },
            ErrorKind::InvalidResponse => Error::Decode(format!("{:?}", e.operation)),
            ErrorKind::MissingMark => Error::MissingMark {
                message: e.log.unwrap_or_default(),
            },
            ErrorKind::InvalidConfiguration | ErrorKind::InvalidInput | ErrorKind::HashMismatch => {
                Error::Gateway(e)
            }
        }
    }
}

impl From<SignerError> for Error {
    fn from(e: SignerError) -> Self {
        Error::Signer(e)
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Transport(Box::new(e.without_url()))
    }
}

/// `Result` with this crate's [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;
