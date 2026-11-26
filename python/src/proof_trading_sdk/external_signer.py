"""Vendor-neutral synchronous Ed25519 callback, without private-key storage."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass(frozen=True)
class ExternalSigner:
    """Sign the SDK's exact immutable message bytes; return a 64-byte signature.

    ``public_key`` is the 32-byte Ed25519 public key. The client snapshots it
    when connected and verifies every returned signature in Rust. ``sign_raw``
    is synchronous; asynchronous callbacks are unsupported. The callback owns
    any key storage, wallet prompts and device timeouts.
    """

    public_key: bytes
    sign_raw: Callable[[bytes], bytes] = field(repr=False)
