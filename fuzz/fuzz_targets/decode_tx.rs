#![no_main]
//! Fuzz the wire-envelope decoders against arbitrary bytes.
//!
//! `decode_tx` / `decode_tx_raw` parse untrusted input straight off the wire,
//! so they must reject malformed bytes with an error — never panic, overflow,
//! or over-allocate. This target asserts the no-panic invariant.

use libfuzzer_sys::fuzz_target;
use proof_trading_sdk::codec;

fuzz_target!(|data: &[u8]| {
    let _ = codec::decode_tx_raw(data);
    let _ = codec::decode_tx(data);
});
