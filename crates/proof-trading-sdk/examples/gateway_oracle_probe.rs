//! Explicit read-only contract probe. No keys, signing or submission path.
use proof_trading_sdk::gateway::{GatewayClient, GatewayOptions};
use std::{num::NonZeroU32, time::Duration};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: gateway_oracle_probe GATEWAY_ORIGIN EXPECTED_CHAIN MARKET".into());
    }
    let market: NonZeroU32 = args[3]
        .parse()
        .map_err(|_| "market must be a positive uint32")?;
    let client = GatewayClient::new(
        &args[1],
        GatewayOptions {
            timeout: Duration::from_secs(5),
            ..GatewayOptions::default()
        },
    )?;
    let chain = client.chain_identity().await?;
    if chain.network != args[2] {
        return Err("gateway chain identity mismatch".into());
    }
    let permission = client.oracle_permissions(market).await?;
    println!(
        "{}",
        serde_json::json!({
            "network": chain.network,
            "latestHeight": chain.latest_height.to_string(),
            "latestBlockTimeMs": chain.latest_block_time_ms.to_string(),
            "catchingUp": chain.catching_up,
            "market": permission.market,
            "finalizedHeight": permission.finalized_height.to_string(),
            "state": format!("{:?}", permission.state),
            "oraclePermission": permission.oracle_permission.map(|p| format!("{p:?}")),
            "verdictStatus": permission.verdict.as_ref().map(|v| format!("{:?}", v.status)),
            "verdictReason": permission.verdict.as_ref().map(|v| format!("{:?}", v.reason)),
            "releaseAccepted": false
        })
    );
    Ok(())
}
