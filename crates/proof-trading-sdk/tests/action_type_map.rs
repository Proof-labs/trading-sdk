//! The TypeScript `ActionType` map is written by hand in `src/types.ts`; the core's
//! `codec::get_action_types()` comes from proof-wire. This holds the two to the
//! same name-to-byte pairs, in both directions, so a wire bump that adds, moves
//! or renames an action is a red build until `src/types.ts` follows.
//!
//! The TypeScript source is read as text: there is no other way to see a
//! hand-written TypeScript object from Rust.

use std::collections::BTreeMap;
use std::path::Path;

use proof_trading_sdk::codec;

/// Core actions the main TypeScript entry deliberately does not export, and why.
/// Adding a name here is a reviewed decision, not a way to quiet the check.
const NOT_IN_THE_MAIN_ENTRY: &[(&str, &str)] = &[
    (
        "RunFundingTick",
        "engine-internal; exported only from the `testing` subpath",
    ),
    (
        "SetAccountFeeOverride",
        "relayer-only; removed from the SDK surface",
    ),
    ("FailDeposit", "relayer-only; removed from the SDK surface"),
    (
        "LiquidateAccounts",
        "unsigned, injected by the block proposer",
    ),
    (
        "ExecuteTriggers",
        "unsigned, injected by the block proposer",
    ),
];

/// `Name: 0x1a,` entries of `export const <name> = { … } as const;`.
fn ts_map(src: &str, name: &str) -> BTreeMap<String, u8> {
    let start = format!("export const {name} = {{");
    let body = src
        .split_once(start.as_str())
        .unwrap_or_else(|| panic!("`{name}` is still declared"))
        .1;
    let body = &body[..body.find("} as const;").expect("the map is closed")];
    body.lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            let hex = value.trim().trim_end_matches(',').strip_prefix("0x")?;
            let key = key.trim();
            key.chars().all(|c| c.is_ascii_alphanumeric()).then(|| {
                let byte = u8::from_str_radix(hex, 16)
                    .unwrap_or_else(|_| panic!("`{key}` has a non-byte value {hex}"));
                (key.to_string(), byte)
            })
        })
        .collect()
}

fn read(rel: &str) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::read_to_string(root.join(rel)).unwrap_or_else(|e| panic!("reading {rel}: {e}"))
}

#[test]
fn the_typescript_action_map_matches_the_core() {
    let core: BTreeMap<String, u8> = codec::get_action_types()
        .into_iter()
        .map(|(name, byte)| (name.to_string(), byte))
        .collect();
    let main = ts_map(&read("src/types.ts"), "ActionType");
    assert!(
        main.len() >= 30,
        "the extractor read only {} entries",
        main.len()
    );

    let excluded: BTreeMap<&str, &str> = NOT_IN_THE_MAIN_ENTRY.iter().copied().collect();
    let expected: BTreeMap<String, u8> = core
        .iter()
        .filter(|(name, _)| !excluded.contains_key(name.as_str()))
        .map(|(name, byte)| (name.clone(), *byte))
        .collect();
    assert_eq!(
        main, expected,
        "src/types.ts `ActionType` and the core disagree (left: TypeScript, right: core)"
    );

    for name in excluded.keys() {
        assert!(
            core.contains_key(*name),
            "`{name}` is excused from the main entry but the core no longer has it"
        );
    }
    let testing = ts_map(&read("src/testing.ts"), "TestActionType");
    for (name, byte) in &testing {
        assert_eq!(
            core.get(name),
            Some(byte),
            "src/testing.ts `{name}` disagrees with the core"
        );
        assert!(
            excluded.contains_key(name.as_str()),
            "`{name}` is in both entries"
        );
    }
}
