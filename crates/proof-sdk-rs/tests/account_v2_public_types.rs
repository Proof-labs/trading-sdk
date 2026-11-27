#![allow(clippy::expect_used)]

use proof_sdk_rs::{
    core,
    query_v2::{BindingOutcome, Branch, Side},
    AccountView, EventId, PositionSummary,
};

fn is_long(position: &PositionSummary) -> Option<bool> {
    match position.side {
        Side::Buy => Some(true),
        Side::Sell => Some(false),
        Side::Unknown => None,
    }
}

#[test]
fn consumers_can_match_account_directions_without_a_wire_dependency() {
    let bytes: Vec<u8> = include_str!("../../../conformance/account-v2.hex")
        .trim()
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("fixture hex is ASCII"), 16)
                .expect("fixture hex is valid")
        })
        .collect();
    let mut view: AccountView =
        core::query::decode_account_view(&bytes).expect("the engine's account map decodes");
    let _: &core::query_v2::Account = &view;
    assert_eq!(is_long(&view.positions[0]), Some(true));
    view.positions[0].side = Side::Sell;
    assert_eq!(is_long(&view.positions[0]), Some(false));
    view.positions[0].side = Side::Unknown;
    assert_eq!(is_long(&view.positions[0]), None);

    for branch in [Branch::Yes, Branch::No, Branch::Unknown] {
        view.binding_scenario = vec![BindingOutcome {
            event_id: EventId(42),
            branch,
        }];
        let actual = match view.binding_scenario[0].branch {
            Branch::Yes => "yes",
            Branch::No => "no",
            Branch::Unknown => "unknown",
        };
        assert_eq!(
            serde_json::to_value(branch).expect("the public branch serializes"),
            actual,
        );
    }
}
