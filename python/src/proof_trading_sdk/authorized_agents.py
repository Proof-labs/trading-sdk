"""Complete explicit agent grants from a bounded, witnessed gateway read.

Witness metadata is a gateway assertion, not a verified chain proof. The list
excludes owner-key and inherited master authority; it is not a signing permission.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

from proof_trading_sdk._native import (
    AUTHORIZED_AGENTS_LIMIT,
    MAX_AUTHORIZED_AGENTS_BYTES,
    decode_authorized_agents as _decode_wire,
)
from proof_trading_sdk.errors import (
    AuthorizedAgentsBindingMismatch,
    AuthorizedAgentsIncomplete,
    CodecError,
    TransportError,
)

if TYPE_CHECKING:
    from proof_trading_sdk.client import ExchangeClient

_MAX_BODY = 32 * 1024
_MAX_PAYLOAD = MAX_AUTHORIZED_AGENTS_BYTES
_I64_MAX = (1 << 63) - 1


@dataclass(frozen=True)
class AuthorizedAgentsWitness:
    """Unverified gateway finality metadata for a complete or partial grant list."""

    finalized_height: int
    finalized_block_time_ms: int
    node_id: str
    app_hash: str


@dataclass(frozen=True)
class AuthorizedAgentsSnapshot:
    """Complete explicit grants plus unverified gateway finality metadata."""

    owner: str
    agents: tuple[str, ...]
    witness: AuthorizedAgentsWitness


def _owner_hex(owner: bytes | str) -> str:
    if isinstance(owner, bytes):
        if len(owner) == 20:
            return owner.hex()
    elif isinstance(owner, str):
        value = owner.lower().removeprefix("0x")
        if re.fullmatch(r"[0-9a-f]{40}", value):
            return value
    raise ValueError("owner must be a 20-byte address or 40-digit hex string")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant {value}")


def _positive_decimal(value: Any, field: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", value):
        raise CodecError(f"authorized agents: invalid witness {field}")
    number = int(value)
    if number > _I64_MAX:
        raise CodecError(f"authorized agents: invalid witness {field}")
    return number


def _decode_snapshot(body: bytes, owner: str) -> AuthorizedAgentsSnapshot:
    if len(body) > _MAX_BODY:
        raise CodecError("authorized agents: response exceeds 32 KiB")
    try:
        value = json.loads(body.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_reject_constant)
        if not isinstance(value, dict) or set(value) != {"data", "witness"}:
            raise ValueError("expected data and witness envelope")
        witness = value["witness"]
        if not isinstance(witness, dict):
            raise ValueError("missing witness")
        if type(witness.get("version")) is not int or witness["version"] != 1:
            raise ValueError("invalid witness version")
        node_id, app_hash = witness.get("nodeId"), witness.get("appHash")
        if (not isinstance(node_id, str) or not re.fullmatch(r"[a-f0-9]{40}", node_id)
                or int(node_id, 16) == 0):
            raise ValueError("invalid witness nodeId")
        if (not isinstance(app_hash, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", app_hash)
                or int(app_hash, 16) == 0):
            raise ValueError("invalid witness appHash")
        height = _positive_decimal(witness.get("height"), "height")
        timestamp = _positive_decimal(witness.get("finalizedBlockTimeMs"), "time")
        data = value["data"]
        if not isinstance(data, str) or len(data) > ((_MAX_PAYLOAD + 2) // 3) * 4:
            raise ValueError("invalid or oversized data")
        payload = base64.b64decode(data, validate=True)
        if len(payload) > _MAX_PAYLOAD or base64.b64encode(payload).decode("ascii") != data:
            raise ValueError("non-canonical or oversized base64")
        # The pinned proof-wire DTO owns MessagePack field shapes and widths.
        decoded = _decode_wire(payload)
        bound_owner = bytes(decoded["owner"]).hex()
        if bound_owner != owner or decoded["finalized_height"] != height:
            raise AuthorizedAgentsBindingMismatch(
                expected_owner=owner, actual_owner=bound_owner,
                expected_height=height, actual_height=decoded["finalized_height"],
            )
        agents = tuple(bytes(agent).hex() for agent in decoded["agents"])
        if len(agents) > AUTHORIZED_AGENTS_LIMIT or any(a >= b for a, b in zip(agents, agents[1:])):
            raise ValueError(f"agent list must be sorted, unique and at most {AUTHORIZED_AGENTS_LIMIT} entries")
        metadata = AuthorizedAgentsWitness(height, timestamp, node_id, app_hash.upper())
        if not decoded["complete"]:
            if len(agents) != AUTHORIZED_AGENTS_LIMIT:
                raise ValueError("invalid incomplete list length")
            raise AuthorizedAgentsIncomplete(owner, agents, metadata)
        return AuthorizedAgentsSnapshot(owner=owner, agents=agents, witness=metadata)
    except (ValueError, TypeError, KeyError, RecursionError, binascii.Error) as error:
        raise CodecError(f"authorized agents: malformed response: {error}") from error


def _read_authorized_agents(client: ExchangeClient, owner: bytes | str, *, timeout: float) -> AuthorizedAgentsSnapshot:
    bound_owner = _owner_hex(owner)
    if type(timeout) not in (int, float) or not 0 < timeout <= 60:
        raise ValueError("timeout must be finite and in (0, 60] seconds")
    deadline = time.monotonic() + timeout
    body = bytearray()
    url = f"{client._gateway_url}/v2/account/{bound_owner}/agents?witness=1"
    try:
        with client._http.stream(
            "GET", url, headers={"Accept-Encoding": "identity"},
            timeout=httpx.Timeout(timeout), follow_redirects=False,
        ) as response:
            client._parse_rate_limits(response)
            identity = response.headers.get("Content-Encoding", "identity").lower() in ("", "identity")
            if response.status_code != 200:
                prefix = bytearray()
                if identity:
                    for index, chunk in enumerate(response.iter_bytes()):
                        prefix.extend(chunk[:200 - len(prefix)])
                        if len(prefix) >= 200 or index >= 4095 or time.monotonic() > deadline:
                            break
                headers = response.headers.copy()
                for name in ("Content-Encoding", "Content-Length"):
                    headers.pop(name, None)
                client._check_response(httpx.Response(response.status_code, headers=headers,
                    content=bytes(prefix), request=response.request))
                raise TransportError(f"authorized agents: unexpected HTTP {response.status_code}",
                    status_code=response.status_code)
            if not identity:
                raise CodecError("authorized agents: compressed response refused")
            for index, chunk in enumerate(response.iter_bytes()):
                if len(body) + len(chunk) > _MAX_BODY or index >= 4096:
                    raise CodecError("authorized agents: response exceeds read budget")
                body.extend(chunk)
                if time.monotonic() > deadline:
                    raise TransportError("authorized agents: response deadline exceeded")
    except ValueError as error:
        raise TransportError(f"authorized agents: invalid response headers: {error}") from error
    except httpx.RequestError as error:
        raise TransportError(f"authorized agents: request failed: {error}") from error
    return _decode_snapshot(bytes(body), bound_owner)
