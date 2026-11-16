"""PyO3 ownership and argument boundaries, using the compiled extension.

These are regression checks, not a proof of native heap leak freedom.
"""

import errno
import gc
import inspect
import os

import pytest

from proof_trading_sdk import _native


SEED = bytes(range(32))
CHAIN = bytes(range(32, 64))


def test_signing_signature_and_unsigned_integer_boundaries():
    assert list(inspect.signature(_native.sign_and_encode).parameters) == [
        "chain_id", "action_type", "action_payload", "seq", "secret_key",
    ]
    for action in (0, 255):
        for seq in (0, 2**64 - 1):
            encoded = _native.sign_and_encode(CHAIN, action, b"\x00\xff", seq, SEED)
            decoded = _native.decode_tx(encoded)
            assert decoded["action_type"] == action
            assert decoded["seq"] == seq
            assert decoded["payload"] == b"\x00\xff"


@pytest.mark.parametrize("action,seq", [(-1, 0), (256, 0), (1, -1), (1, 2**64)])
def test_out_of_range_integers_raise_without_wrapping(action, seq):
    with pytest.raises(OverflowError):
        _native.sign_and_encode(CHAIN, action, b"", seq, SEED)


@pytest.mark.parametrize("index", [0, 2, 4])
def test_required_byte_arguments_reject_none(index):
    args = [CHAIN, 1, b"payload", 7, SEED]
    args[index] = None
    with pytest.raises(TypeError):
        _native.sign_and_encode(*args)


def test_text_boundary_rejects_invalid_unicode_and_wrong_types():
    # An unpaired surrogate cannot cross Rust's UTF-8 str boundary.
    with pytest.raises(UnicodeEncodeError):
        _native.chain_id_from_string("\ud800")
    with pytest.raises(TypeError):
        _native.chain_id_from_string(None)
    assert len(_native.chain_id_from_string("chain-한글")) == 32


@pytest.mark.parametrize("length", [0, 31, 32])
def test_fd_is_consumed_on_success_and_failure(length):
    # Check each transferred descriptor directly: process-wide FD counts can
    # include unrelated test-runner activity. Never reuse an invalid raw FD.
    for _ in range(32):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, SEED[:length])
        os.close(write_fd)
        try:
            if length == 32:
                handle = _native.load_key_from_fd(read_fd)
                public_key = handle.public_key
                encoded = handle.sign_and_encode(CHAIN, 1, b"payload", 7)
                del handle
                gc.collect()
                decoded = _native.decode_tx(encoded)
                assert decoded["pubkey"] == public_key
                assert _native.verify_signature(
                    CHAIN, public_key, decoded["signature"], 1, 7, b"payload",
                )
            else:
                with pytest.raises(ValueError, match="failed to read key from fd"):
                    _native.load_key_from_fd(read_fd)
            with pytest.raises(OSError) as error:
                os.fstat(read_fd)
            assert error.value.errno == errno.EBADF
        finally:
            # Clean up even if a regression leaves ownership with the caller.
            try:
                os.close(read_fd)
            except OSError as error:
                assert error.errno == errno.EBADF


def test_decoded_results_remain_owned_after_source_and_later_calls():
    encoded = _native.sign_and_encode(CHAIN, 1, b"\x00\xffpayload", 7, SEED)
    first = _native.decode_tx(encoded)
    expected = dict(first)
    del encoded
    gc.collect()
    for seq in range(64):
        other = _native.decode_tx(
            _native.sign_and_encode(CHAIN, 1, b"different", seq, SEED)
        )
        other["payload"] = b"mutated"
    assert first == expected
    assert first["payload"] == b"\x00\xffpayload"
