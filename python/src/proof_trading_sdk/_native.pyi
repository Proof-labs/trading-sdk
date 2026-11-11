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
    def sign_account_ws_auth(self, chain_id: bytes, timestamp_ms: int, after_id: int = 0) -> bytes:
        """Sign owner-bound account-stream auth with a JSON-safe cursor."""
        ...
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

def sign_account_ws_auth(
    chain_id: bytes, timestamp_ms: int, secret_key: bytes, after_id: int = 0,
) -> bytes:
    """Sign owner-bound account-stream auth with a JSON-safe cursor."""
    ...

def encode_signed_tx(
    action_type: int,
    action_payload: bytes,
    seq: int,
    pubkey: bytes,
    signature: bytes,
) -> bytes:
    ...

def signing_message(chain_id: bytes, action_type: int, seq: int, payload: bytes) -> bytes:
    """Canonical transaction message, owned by the shared Rust core."""
    ...

def account_ws_auth_message(
    chain_id: bytes, public_key: bytes, timestamp_ms: int, after_id: int = 0,
) -> bytes:
    """Owner-bound account-stream authentication message."""
    ...

def verify_raw_signature(public_key: bytes, signature: bytes, message: bytes) -> bool:
    """Strict Ed25519 verification for callback results."""
    ...

def encode_action(action_type: int, fields: dict[str, object]) -> bytes:
    ...

def decode_action(action_type: int, payload: bytes) -> dict[str, object]:
    ...

def decode_tx(tx_bytes: bytes) -> dict[str, object]:
    ...

MAX_MARKETS_SNAPSHOT_BYTES: int
"""Largest complete ``GET /v1/markets-snapshot`` body the decoder accepts."""

MAX_OPEN_ORDERS_BYTES: int

def decode_open_orders(body: bytes, owner: bytes) -> list[dict[str, object]]:
    """Decode canonical resting orders; raises ValueError on malformed or foreign rows."""
    ...

def decode_markets_snapshot(body: bytes, chain_id: bytes) -> dict[str, object]:
    """Decode a complete ``GET /v1/markets-snapshot`` response body bound to
    ``chain_id``. Raises ``ValueError`` on any fault; nothing partial is
    returned."""
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
    action: dict[str, object] | str,
) -> bytes:
    """Recompute the engine's §2.4 domain-separated admin-proposal content
    hash in the authoritative Rust core, so an approving client can verify a
    server-supplied ``content_hash`` locally. ``action`` is the serde map form
    (``{"Variant": {snake_case_fields}}``), as used by :func:`encode_action`
    for the governance actions' ``action`` field — except for a fieldless UNIT
    variant, which serde represents as the bare variant-name string (e.g.
    ``"UnpauseBridge"``). A fieldless STRUCT variant (``Variant {}``) is NOT
    one of those and keeps the ``{"Variant": {}}`` map form."""
    ...

def get_action_types() -> list[dict[str, object]]:
    ...

def get_error_code_table() -> list[dict[str, object]]:
    ...

MAX_BOOK_BYTES: int
MAX_ACCOUNT_STATE_BYTES: int

def decode_account_state(data: bytes, owner: bytes) -> dict:
    """Canonical raw account state with owner binding and strict record widths."""
    ...
class FinalizedBindingError(ValueError): ...

def decode_finalized_account(data: bytes, owner: bytes) -> dict: ...
def decode_finalized_agent_authorization(data: bytes) -> bool: ...
def decode_finalized_recent_nonces(data: bytes) -> list[int]: ...
def decode_finalized_open_orders(data: bytes, owner: bytes, limit: int) -> list[dict]: ...

def decode_finalized_orderbook(data: bytes, depth: int) -> dict:
    ...

MAX_GOVERNANCE_READ_BYTES: int

def decode_authorities(data: bytes) -> dict:
    ...

def decode_liquidation_config(data: bytes) -> tuple:
    ...
