//! The one error type every client call returns.

use std::fmt;

use proof_trading_sdk::gateway::{GatewayError, TxHash};
use proof_trading_sdk::SignerError;

use crate::exchange::SignedTx;

/// A client failure. Never carries a key, signature or API key in its text.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The configuration was refused (bad URL, out-of-range timeout, empty
    /// API key).
    Config(String),
    /// A caller argument was malformed (address, hash).
    InvalidInput(String),
    /// A read failed below HTTP (connect, TLS, reset) or timed out.
    Transport(reqwest::Error),
    /// A read returned a non-success status. `body` is the gateway's error
    /// text, truncated.
    Http { status: u16, body: String },
    /// A response did not decode as the type the route promises.
    Decode(String),
    /// A read response exceeded the configured cap
    /// ([`crate::ClientConfig::with_max_read_bytes`]).
    ResponseTooLarge,
    /// A gateway call made through the core transport failed with no
    /// submission in flight (chain identity, receipt read). The source error
    /// names the operation and kind.
    Gateway(GatewayError),
    /// The submission may have reached the gateway, but no verdict came back.
    /// The transaction can still land. Keep `tx` and reconcile it with
    /// [`crate::ExchangeClient::wait_for_receipt`] on `tx.hash`. **Do not
    /// re-sign it under a fresh nonce**, or both copies may execute.
    Ambiguous {
        tx: Box<SignedTx>,
        source: GatewayError,
    },
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
    /// The gateway's chain differs from the one the client was configured for.
    ChainMismatch { expected: String, actual: String },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Config(m) => write!(f, "invalid configuration: {m}"),
            Error::InvalidInput(m) => write!(f, "invalid input: {m}"),
            Error::Transport(e) => write!(f, "transport: {e}"),
            Error::Http { status, body } => write!(f, "HTTP {status}: {body}"),
            Error::Decode(m) => write!(f, "decode: {m}"),
            Error::ResponseTooLarge => f.write_str("response exceeds max_read_bytes"),
            Error::Gateway(e) => write!(f, "{e}"),
            Error::Ambiguous { tx, source } => write!(
                f,
                "submission of {} may have landed ({source}); reconcile by hash, do not re-sign",
                tx.hash
            ),
            Error::Encode(m) => write!(f, "encode: {m}"),
            Error::Signer(e) => write!(f, "{e}"),
            Error::NonceWindow { next, now_ms } => write!(
                f,
                "nonce {next} would run more than 60s ahead of the clock ({now_ms})"
            ),
            Error::ReceiptTimeout { hash } => write!(f, "no committed receipt for {hash} yet"),
            Error::ChainMismatch { expected, actual } => {
                write!(f, "gateway serves chain {actual:?}, expected {expected:?}")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Transport(e) => Some(e),
            Error::Gateway(e) | Error::Ambiguous { source: e, .. } => Some(e),
            Error::Signer(e) => Some(e),
            _ => None,
        }
    }
}

impl From<GatewayError> for Error {
    fn from(e: GatewayError) -> Self {
        Error::Gateway(e)
    }
}

impl From<SignerError> for Error {
    fn from(e: SignerError) -> Self {
        Error::Signer(e)
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Transport(e.without_url())
    }
}

/// `Result` with this crate's [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;
