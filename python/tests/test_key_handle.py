"""SigningHandle: the FD-isolation / HSM-ready signing path.

The security guarantee under test is that a key loaded via `load_key_from_fd`
signs correctly while its secret bytes never cross into Python — the handle
exposes the public key, owner, and a sign operation, and nothing else.
"""

from __future__ import annotations

import os

import pytest

import proof_trading_sdk as pts

_SEED = bytes(range(32))
_CID = bytes(range(32, 64))


def _load_handle(seed: bytes) -> pts.SigningHandle:
    """Feed `seed` through a pipe fd, the way a launcher would hand off a key."""
    r, w = os.pipe()
    os.write(w, seed)
    os.close(w)
    return pts.load_key_from_fd(r)


class TestLoadKeyFromFd:
    def test_returns_handle_not_dict(self):
        handle = _load_handle(_SEED)
        assert isinstance(handle, pts.SigningHandle)

    def test_public_key_and_owner_match_core(self):
        handle = _load_handle(_SEED)
        expected = pts.generate_keypair(_SEED)
        assert handle.public_key == expected["public_key"]
        assert handle.owner == pts.pubkey_to_owner(expected["public_key"])

    def test_short_fd_payload_errors(self):
        r, w = os.pipe()
        os.write(w, b"\x00" * 16)  # only 16 of the required 32 bytes
        os.close(w)
        with pytest.raises(ValueError):
            pts.load_key_from_fd(r)


class TestNoSecretLeak:
    def test_handle_exposes_no_secret(self):
        handle = _load_handle(_SEED)
        # No attribute, item, or dict entry hands back the private key.
        assert not hasattr(handle, "secret_key")
        assert not hasattr(handle, "secret")
        with pytest.raises(TypeError):
            handle["secret_key"]  # type: ignore[index]

    def test_repr_is_redacted(self):
        handle = _load_handle(_SEED)
        text = repr(handle)
        assert "<redacted>" in text
        # The secret seed must never appear in any string form.
        assert _SEED.hex() not in text


class TestSignAndEncode:
    def test_envelope_verifies(self):
        handle = _load_handle(_SEED)
        payload = pts.encode_action(
            pts.actions.MarketOrder(
                market=1, owner=handle.owner, side=pts.Side.Buy, quantity=5
            )
        )[1]
        env = handle.sign_and_encode(_CID, 0x04, payload, 42)

        decoded = pts.decode_tx(env)
        assert decoded["pubkey"] == handle.public_key
        assert decoded["seq"] == 42
        assert pts.verify_signature(
            _CID,
            handle.public_key,
            decoded["signature"],
            0x04,
            42,
            payload,
        )

    def test_matches_secret_key_path(self):
        """The handle path and the raw-bytes path produce identical bytes."""
        handle = _load_handle(_SEED)
        payload = b"\x91\x01"  # arbitrary msgpack payload
        via_handle = handle.sign_and_encode(_CID, 0x01, payload, 7)
        via_bytes = pts.sign_and_encode(_CID, 0x01, payload, 7, _SEED)
        assert via_handle == via_bytes


class TestPkcs11:
    """HSM path. Full coverage needs a PKCS#11 token (SoftHSM2 in CI); here we
    only assert the binding is wired and fails cleanly without one."""

    def test_function_exists(self):
        assert hasattr(pts, "load_key_from_pkcs11")

    def test_bogus_module_raises_valueerror(self):
        with pytest.raises(ValueError):
            pts.load_key_from_pkcs11(
                "/nonexistent/libsofthsm2.so", 0, "1234", "proof-key"
            )
