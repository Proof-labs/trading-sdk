from typing import Optional

def generate_keypair(seed: Optional[bytes] = None) -> dict[str, bytes]:
    ...

def load_key_from_fd(fd: int) -> dict[str, bytes]:
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
