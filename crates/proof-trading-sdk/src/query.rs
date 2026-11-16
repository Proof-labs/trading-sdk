//! Node read-model (response) DTOs — re-exported from the shared `proof-wire`
//! crate so the SDK and the engine share one definition (no positional-wire
//! drift). Client representation that needs it wraps these.

pub use proof_wire::query::{
    AccountInfo, AccountStateInfo, BindingScenario, LevelSummary, OrderbookSnapshot, PositionBrief,
};
pub use proof_wire::query_v2::{AuthorizedAgents, AUTHORIZED_AGENTS_LIMIT};
pub use proof_wire::query_v2::{InsuranceFundDirectory, InsuranceFundLedger, InsuranceFundState};

/// Validate the canonical account binding using the wire's sole address derivation.
pub fn insurance_fund_owner_matches(fund: &InsuranceFundLedger) -> bool {
    use proof_wire::crypto::{derive_vault, Vault};
    fund.owner.0 == *derive_vault(Vault::Insurance(fund.pool_id)).as_bytes()
}

fn validate_insurance_fund_ledger(fund: &InsuranceFundLedger) -> Result<(), &'static str> {
    if !insurance_fund_owner_matches(fund) {
        return Err("insurance fund owner does not match pool");
    }
    if i128::from(fund.cash).checked_sub(i128::from(fund.debt)) != Some(i128::from(fund.net_cash)) {
        return Err("insurance net cash does not match cash minus debt");
    }
    Ok(())
}

/// Validate the complete finite directory for all language bindings.
pub fn validate_insurance_fund_directory(
    view: &InsuranceFundDirectory,
) -> Result<(), &'static str> {
    if view.funds.len() > 256 {
        return Err("insurance fund directory bound");
    }
    let mut previous = None;
    for fund in &view.funds {
        validate_insurance_fund_ledger(fund)?;
        if previous.is_some_and(|pool| pool >= fund.pool_id)
            || (!fund.registered && !fund.stored_ledger)
        {
            return Err("insurance fund directory ordering or presence");
        }
        previous = Some(fund.pool_id);
    }
    Ok(())
}

/// Validate the bounded display preview, never authorization to execute an exit.
pub fn validate_insurance_fund_state(view: &InsuranceFundState) -> Result<(), &'static str> {
    use proof_wire::query_v2::{InsurancePositionNotional, INSURANCE_FUND_POSITIONS_LIMIT};
    validate_insurance_fund_ledger(&view.fund)?;
    if view.positions.len() > INSURANCE_FUND_POSITIONS_LIMIT
        || (!view.positions_complete && view.positions.len() != INSURANCE_FUND_POSITIONS_LIMIT)
    {
        return Err("insurance positions completeness");
    }
    let mut previous = 0;
    for position in &view.positions {
        if position.market <= previous || position.size == 0 || position.sz_decimals > 37 {
            return Err("insurance position ordering, quantity or decimals");
        }
        previous = position.market;
        if let InsurancePositionNotional::Priced {
            reference_price,
            notional_micro_usdc,
        } = &position.notional
        {
            let expected = u128::from(*reference_price)
                .checked_mul(u128::from(position.size))
                .zip(10u128.checked_pow(u32::from(position.sz_decimals)))
                .and_then(|(product, scale)| product.checked_div(scale));
            if *reference_price == 0 || expected.map(|e| e.to_string()).as_ref() != Some(&notional_micro_usdc.0) {
                return Err("insurance notional is not the exact canonical floor amount");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod insurance_validation_tests {
    use super::*;
    use proof_wire::crypto::{derive_vault, Vault};
    use proof_wire::query_v2::{Address, Side};
    use proof_wire::query_v2::{
        InsuranceFundPosition, InsurancePositionNotional, NotionalMicroUsdc,
        INSURANCE_FUND_POSITIONS_LIMIT,
    };
    use proof_wire::types::InsurancePoolId;

    fn state() -> InsuranceFundState {
        InsuranceFundState {
            finalized_height: 1,
            finalized_time_ms: 2,
            fund: InsuranceFundLedger {
                pool_id: InsurancePoolId(7),
                owner: Address(*derive_vault(Vault::Insurance(InsurancePoolId(7))).as_bytes()),
                registered: false,
                stored_ledger: true,
                cash: 23,
                debt: 29,
                net_cash: -6,
            },
            positions: vec![InsuranceFundPosition {
                market: 1,
                side: Side::Sell,
                size: 7,
                sz_decimals: 1,
                notional: InsurancePositionNotional::Priced {
                    reference_price: 13,
                    notional_micro_usdc: NotionalMicroUsdc("9".into()),
                },
            }],
            positions_complete: true,
        }
    }

    #[test]
    fn shared_fund_validation_rejects_bad_ledger_and_position_facts() {
        let original = state();
        assert_eq!(validate_insurance_fund_state(&original), Ok(()));
        for mutation in 0..8 {
            let mut value = original.clone();
            match mutation {
                0 => value.fund.owner = Address([0; 20]),
                1 => value.fund.net_cash += 1,
                2 => value.positions[0].market = 0,
                3 => value.positions[0].size = 0,
                4 => value.positions[0].sz_decimals = 38,
                5 => value.positions.push(value.positions[0].clone()),
                6 => value.positions_complete = false,
                _ => {
                    value.positions =
                        vec![value.positions[0].clone(); INSURANCE_FUND_POSITIONS_LIMIT + 1]
                }
            }
            assert!(
                validate_insurance_fund_state(&value).is_err(),
                "mutation {mutation}"
            );
        }
        for amount in [
            "09",
            "10",
            "-9",
            "9.0",
            "340282366920938463463374607431768211456",
        ] {
            let mut value = original.clone();
            if let InsurancePositionNotional::Priced {
                notional_micro_usdc,
                ..
            } = &mut value.positions[0].notional
            {
                notional_micro_usdc.0 = amount.into();
            }
            assert!(validate_insurance_fund_state(&value).is_err());
        }
        let mut value = original;
        value.positions = (1..=INSURANCE_FUND_POSITIONS_LIMIT)
            .map(|market| {
                let mut item = value.positions[0].clone();
                item.market = market as u32;
                item
            })
            .collect();
        value.positions_complete = false;
        assert_eq!(validate_insurance_fund_state(&value), Ok(()));
    }

    #[test]
    fn directory_requires_canonical_sorted_present_ledgers() {
        let fund = state().fund;
        let mut value = InsuranceFundDirectory {
            finalized_height: 1,
            finalized_time_ms: 2,
            funds: vec![fund.clone()],
        };
        assert_eq!(validate_insurance_fund_directory(&value), Ok(()));
        value.funds.push(fund);
        assert!(validate_insurance_fund_directory(&value).is_err());
        value.funds.pop();
        value.funds[0].stored_ledger = false;
        assert!(validate_insurance_fund_directory(&value).is_err());
    }
}
