from __future__ import annotations

import typing as t

from proof_trading_sdk._native import (
    SigningHandle,
    chain_id_from_string,
    decode_tx,
    encode_signed_tx,
    generate_keypair,
    load_key_from_fd,
    load_key_from_pkcs11,
    pubkey_to_owner,
    sign_and_encode,
    verify_signature,
)

from proof_trading_sdk import actions
from proof_trading_sdk.actions import (
    Action,
    ActionType,
    RawAction,
    Side,
    TimeInForce,
    decode_action,
    encode_action,
)

from proof_trading_sdk.errors import (
    AuthenticationError,
    CodecError,
    EngineError,
    GatewayError,
    ProofTradingSdkError,
    RateLimited,
    SigningError,
    TransportError,
    get_error_name,
    get_error_code_table,
)
from proof_trading_sdk.nonce import NonceAllocator
from proof_trading_sdk.config import SdkConfig, load_config
from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.streams import AccountEventStream, OrderbookDeltaStream

__all__ = [
    "chain_id_from_string",
    "decode_tx",
    "encode_signed_tx",
    "generate_keypair",
    "load_key_from_fd",
    "load_key_from_pkcs11",
    "SigningHandle",
    "pubkey_to_owner",
    "sign_and_encode",
    "verify_signature",
    "actions",
    "Action",
    "ActionType",
    "RawAction",
    "Side",
    "TimeInForce",
    "encode_action",
    "decode_action",
    "NonceAllocator",
    "ExchangeClient",
    "SdkConfig",
    "load_config",
    "AccountEventStream",
    "OrderbookDeltaStream",
    "AuthenticationError",
    "CodecError",
    "EngineError",
    "GatewayError",
    "ProofTradingSdkError",
    "RateLimited",
    "SigningError",
    "TransportError",
    "get_error_name",
    "get_error_code_table",
]
