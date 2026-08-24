from typing import Optional

class SigningHandle:
    """Opaque signing key. Exposes the public key, derived owner, and a
    sign-and-encode operation — but never the secret bytes. Returned by
    :func:`load_key_from_fd`; the key lives in Rust memory (zeroized on drop)
    or, for HSM-backed signers, on the device."""

    @property
    def public_key(self) -> bytes: ...
    @property
    def owner(self) -> bytes: ...
    def sign_and_encode(
        self,
        chain_id: bytes,
        action_type: int,
        action_payload: bytes,
        seq: int,
    ) -> bytes: ...
    def __repr__(self) -> str: ...

def generate_keypair(seed: Optional[bytes] = None) -> dict[str, bytes]:
    ...

def load_key_from_fd(fd: int) -> SigningHandle:
    ...

def load_key_from_pkcs11(
    module: str,
    slot_id: int,
    pin: str,
    key_label: str,
) -> SigningHandle:
    """Bind to an Ed25519 key resident in a PKCS#11 token (HSM).

    Signing happens on the device; the private key never enters this process.
    References an existing key by ``key_label`` (no import/generation). ``pin``
    is used only to log in and is not retained. ``module`` is the path to the
    vendor PKCS#11 ``.so``. Requires the native ``pkcs11`` feature (default-on).
    """
    ...

def pubkey_to_owner(pubkey: bytes) -> bytes:
    ...

def sign_and_encode(
    chain_id: bytes,
    action_type: int,
    action_payload: bytes,
    seq: int,
    secret_key: bytes,
) -> bytes:
    ...

def encode_signed_tx(
    action_type: int,
    action_payload: bytes,
    seq: int,
    pubkey: bytes,
    signature: bytes,
) -> bytes:
    ...

def encode_action(action_type: int, fields: dict[str, object]) -> bytes:
    ...

def decode_action(action_type: int, payload: bytes) -> dict[str, object]:
    ...

def decode_tx(tx_bytes: bytes) -> dict[str, object]:
    ...

def verify_signature(
    chain_id: bytes,
    pubkey: bytes,
    signature: bytes,
    action_type: int,
    seq: int,
    payload: bytes,
) -> bool:
    ...

def chain_id_from_string(chain_id: str) -> bytes:
    ...

def admin_proposal_content_hash(
    chain_id: bytes,
    proposal_id: int,
    registry_version: int,
    threshold: int,
    proposer: bytes,
    created_height: int,
    created_ms: int,
    expiry_ms: int,
    action: dict[str, object],
) -> bytes:
    """Recompute the engine's §2.4 domain-separated admin-proposal content
    hash in the authoritative Rust core, so an approving client can verify a
    server-supplied ``content_hash`` locally. ``action`` is the serde map form
    (``{"Variant": {snake_case_fields}}``), as used by :func:`encode_action`
    for the governance actions' ``action`` field."""
    ...

def get_action_types() -> list[dict[str, object]]:
    ...

def get_error_code_table() -> list[dict[str, object]]:
    ...
