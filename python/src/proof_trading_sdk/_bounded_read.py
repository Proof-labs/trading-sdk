"""Bounded JSON for the opt-in evidence read; existing transports stay intact."""

from __future__ import annotations

import json
import re
import time
import typing as t

import httpx

from proof_trading_sdk.errors import GatewayReadError, TransportError

MAX_READ_BYTES = 1024 * 1024
MAX_READ_CHUNKS = 4096


def _parse_json(body: bytes | bytearray) -> dict[str, t.Any]:
    try:
        text = body.decode("utf-8-sig", errors="strict")
        # Bound nesting before json.loads can exhaust Python's recursion stack.
        depth = 0
        quoted = escaped = False
        for char in text:
            if quoted:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    quoted = False
            elif char == '"':
                quoted = True
            elif char in "[{":
                depth += 1
                if depth > 32:
                    raise GatewayReadError("limit", "JSON depth")
            elif char in "]}":
                depth -= 1

        def unique(pairs: list[tuple[str, t.Any]]) -> dict[str, t.Any]:
            result = {}
            for key, value in pairs:
                if key in result:
                    raise GatewayReadError("malformed", key, "duplicate gateway read field")
                result[key] = value
            return result

        def invalid_constant(_value: str) -> t.NoReturn:
            raise ValueError("non-JSON numeric constant")

        value = json.loads(text, object_pairs_hook=unique, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError) as err:
        raise GatewayReadError("malformed", "json", "invalid gateway read JSON") from err
    if not isinstance(value, dict):
        raise GatewayReadError("malformed", "envelope")
    return value


def bounded_gateway_json(
    http: httpx.Client, url: str, params: dict[str, str], *, timeout: float,
    on_response: t.Callable[[httpx.Response], None],
    check_response: t.Callable[[httpx.Response], httpx.Response],
) -> dict[str, t.Any]:
    """One managed request; no retry, redirect, decompression or fallback.

    Timeout bounds network waits and elapsed time between chunks, not slow
    headers or a custom transport that ignores httpx timeouts. Error bodies
    are discarded so a slow/erroring body cannot replace its HTTP status.
    """
    if (
        isinstance(timeout, bool) or not isinstance(timeout, (int, float))
        or not 0.001 <= timeout <= 60
    ):
        raise GatewayReadError("configuration", "timeout")
    deadline = time.monotonic() + timeout

    def check_deadline() -> None:
        if time.monotonic() >= deadline:
            raise GatewayReadError("deadline", "timeout", "gateway read deadline exceeded")

    body = bytearray()
    try:
        with http.stream(
            "GET", url, params=params, timeout=httpx.Timeout(timeout),
            headers={"Accept-Encoding": "identity", "Cache-Control": "no-store"},
            follow_redirects=False,
        ) as response:
            check_deadline()
            success = 200 <= response.status_code < 300
            try:
                on_response(response)
            except (ValueError, OverflowError) as err:
                if success:
                    raise GatewayReadError("malformed", "rate-limit headers") from err
            if not success:
                # Reuse the client's existing HTTP exception classes without
                # ever waiting for, buffering, or decompressing an error body.
                headers = response.headers.copy()
                for name in ("Content-Encoding", "Content-Length"):
                    headers.pop(name, None)
                error_response = httpx.Response(
                    response.status_code, headers=headers, content=b"", request=response.request,
                )
                try:
                    check_response(error_response)
                except (ValueError, OverflowError) as err:
                    raise TransportError("gateway HTTP refusal", status_code=response.status_code) from err
                raise TransportError("gateway HTTP refusal", status_code=response.status_code)
            if response.headers.get("Content-Encoding", "identity").lower() not in ("", "identity"):
                raise GatewayReadError("malformed", "content encoding")
            length = response.headers.get("Content-Length")
            if length is not None and (
                re.fullmatch(r"0|[1-9][0-9]*", length) is None
                or len(length) > 7 or int(length) > MAX_READ_BYTES
            ):
                raise GatewayReadError("limit", "responseBytes")
            # Read raw chunks to count empty/fragmented input too. iter_bytes()
            # filters empty chunks, which could otherwise hide an endless stream.
            iterator = iter(response.stream)
            chunks = 0
            while True:
                check_deadline()
                try:
                    chunk = next(iterator)
                except StopIteration:
                    break
                check_deadline()
                if not isinstance(chunk, bytes) or not chunk:
                    raise GatewayReadError("malformed", "body")
                chunks += 1
                if chunks > MAX_READ_CHUNKS:
                    raise GatewayReadError("limit", "chunks")
                if len(body) + len(chunk) > MAX_READ_BYTES:
                    raise GatewayReadError("limit", "responseBytes")
                body.extend(chunk)
    except httpx.TimeoutException as err:
        raise GatewayReadError("deadline", "timeout", "gateway read timed out") from err
    except httpx.RequestError as err:
        raise TransportError("gateway read request failed") from err
    check_deadline()
    value = _parse_json(body)
    check_deadline()
    return value
