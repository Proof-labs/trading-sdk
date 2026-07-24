from __future__ import annotations

import typing as t

from proof_trading_sdk._native import (
    SigningHandle,
    admin_proposal_content_hash,
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

# ── Convenience aliases (match the TS SDK naming) ────────────────────────────


def owner_to_hex(owner: bytes) -> str:
    """20-byte owner bytes → 40-char hex string (no ``0x``)."""
    return owner.hex()


def hex_to_owner(hex_str: str) -> bytes:
    """Hex string (with or without ``0x``) → 20-byte owner bytes."""
    return bytes.fromhex(hex_str.removeprefix("0x"))

from proof_trading_sdk import actions
from proof_trading_sdk.actions import (  # noqa: F401
    Action,
    ActionType,
    RawAction,
    Side,
    TimeInForce,
    PlaceOrder,
    MarketOrder,
    CancelOrder,
    CancelClientOrder,
    CancelAllOrders,
    CancelReplaceOrder,
    AmendOrder,
    ClosePosition,
    ApproveAgent,
    RevokeAgent,
    Deposit,
    Withdraw,
    WithdrawRequest,
    ConfirmDeposit,
    ConfirmWithdrawal,
    FailWithdrawal,
    SetUserMarketLeverage,
    CreateImpactMarket,
    UpdateMarketFees,
    OracleUpdateComposite,
    encode_action,
    decode_action,
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
    "admin_proposal_content_hash",
    "chain_id_from_string",
    "owner_to_hex",
    "hex_to_owner",
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
    "PlaceOrder",
    "MarketOrder",
    "CancelOrder",
    "CancelClientOrder",
    "CancelAllOrders",
    "CancelReplaceOrder",
    "AmendOrder",
    "ClosePosition",
    "ApproveAgent",
    "RevokeAgent",
    "Deposit",
    "Withdraw",
    "WithdrawRequest",
    "ConfirmDeposit",
    "ConfirmWithdrawal",
    "FailWithdrawal",
    "SetUserMarketLeverage",
    "CreateImpactMarket",
    "UpdateMarketFees",
    "OracleUpdateComposite",
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
