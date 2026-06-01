from __future__ import annotations

import proof_trading_sdk._native as _native

# Generated from the Rust codec — never hand-synced.
_ACTION_MAP: dict[str, int] = {
    entry["name"]: entry["code"] for entry in _native.get_action_types()
}

# Action type constants. Every constant here is a compile-time-verified
# mapping from the Rust core's `impl_action_encoding!` macro — the two
# can never drift.
PlaceOrder = _ACTION_MAP["PlaceOrder"]
CancelOrder = _ACTION_MAP["CancelOrder"]
CancelClientOrder = _ACTION_MAP["CancelClientOrder"]
CancelAllOrders = _ACTION_MAP["CancelAllOrders"]
CancelReplaceOrder = _ACTION_MAP["CancelReplaceOrder"]
OracleUpdate = _ACTION_MAP["OracleUpdate"]
MarketOrder = _ACTION_MAP["MarketOrder"]
Deposit = _ACTION_MAP["Deposit"]
Withdraw = _ACTION_MAP["Withdraw"]
CreateMarket = _ACTION_MAP["CreateMarket"]
WithdrawRequest = _ACTION_MAP["WithdrawRequest"]
ConfirmDeposit = _ACTION_MAP["ConfirmDeposit"]
ConfirmWithdrawal = _ACTION_MAP["ConfirmWithdrawal"]
FailWithdrawal = _ACTION_MAP["FailWithdrawal"]
ApproveAgent = _ACTION_MAP["ApproveAgent"]
RevokeAgent = _ACTION_MAP["RevokeAgent"]
CreateImpactMarket = _ACTION_MAP["CreateImpactMarket"]
ResolveEvent = _ACTION_MAP["ResolveEvent"]
UpdateMarketFees = _ACTION_MAP["UpdateMarketFees"]
SetAccountFeeOverride = _ACTION_MAP["SetAccountFeeOverride"]
RunLiquidationSweep = _ACTION_MAP["RunLiquidationSweep"]
RunFundingTick = _ACTION_MAP["RunFundingTick"]
OracleUpdateComposite = _ACTION_MAP["OracleUpdateComposite"]
FailDeposit = _ACTION_MAP["FailDeposit"]
SetUserMarketLeverage = _ACTION_MAP["SetUserMarketLeverage"]
ClosePosition = _ACTION_MAP["ClosePosition"]
AmendOrder = _ACTION_MAP["AmendOrder"]

__all__ = sorted(_ACTION_MAP.keys())
