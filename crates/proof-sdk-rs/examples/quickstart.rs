//! Connect to devnet, read the book and the account, and (with `PROOF_LIVE=1`)
//! rest a post-only bid below the touch, then cancel it.
//!
//! ```sh
//! # read-only, throwaway key
//! cargo run -p proof-sdk-rs --example quickstart
//!
//! # place + cancel with a funded key
//! PROOF_PRIVATE_KEY_HEX=<64 hex> PROOF_LIVE=1 \
//!   cargo run -p proof-sdk-rs --example quickstart
//! ```
//!
//! Optional: `PROOF_GATEWAY_URL`, `PROOF_CHAIN_ID`, `PROOF_MARKET` (default 1).

use std::time::Duration;

use proof_sdk_rs::{ClientConfig, ExchangeClient, LocalSigner, Side};

type AnyResult<T> = Result<T, Box<dyn std::error::Error>>;

#[tokio::main]
async fn main() -> AnyResult<()> {
    let config = match std::env::var("PROOF_GATEWAY_URL") {
        Ok(url) => ClientConfig::new(url).with_chain_id(
            std::env::var("PROOF_CHAIN_ID").unwrap_or_else(|_| "exchange-devnet-1".into()),
        ),
        Err(_) => ClientConfig::devnet(),
    };
    let market: u32 = std::env::var("PROOF_MARKET").map_or(Ok(1), |m| m.parse())?;

    let seed = match std::env::var("PROOF_PRIVATE_KEY_HEX") {
        Ok(hex) => parse_seed(&hex)?,
        Err(_) => proof_sdk_rs::random_seed(),
    };
    let client = ExchangeClient::connect(&config, LocalSigner::from_bytes(&seed)).await?;
    println!(
        "connected to {} as 0x{}",
        client.network(),
        client.address()
    );

    let info = client.info();
    let markets = info.markets().await?;
    let Some(cfg) = markets.iter().find(|m| m.market == market) else {
        return Err(format!("market {market} not listed").into());
    };
    println!(
        "market {} {:?}: tick {} lot {} sz_decimals {}",
        cfg.market, cfg.ticker, cfg.tick_size, cfg.lot_size, cfg.sz_decimals
    );

    let book = info.orderbook(market).await?;
    println!("best bid {:?}", book.best_bid());
    println!("best ask {:?}", book.best_ask());

    let account = info.account(client.address()).await?;
    println!(
        "balance {} µUSDC, equity {}, {} positions, {} open orders",
        account.balance,
        account.equity,
        account.positions.len(),
        info.open_orders(client.address()).await?.len()
    );

    if std::env::var("PROOF_LIVE").as_deref() != Ok("1") {
        println!("read-only (set PROOF_LIVE=1 to place and cancel an order)");
        return Ok(());
    }

    // Ten ticks under the best bid, post-only so it can never take.
    let Some(bid) = book.best_bid() else {
        return Err("empty bid side".into());
    };
    let price = bid.price.saturating_sub(cfg.tick_size.saturating_mul(10));
    let mut order = client.limit_order(market, Side::Buy, price, cfg.lot_size);
    order.post_only = true;
    order.client_order_id = Some(proof_sdk_rs::NonceAllocator::new().next()?);
    let cid = order.client_order_id;

    let placed = client
        .submit_and_wait(
            &proof_sdk_rs::Action::PlaceOrder(order),
            Duration::from_secs(10),
        )
        .await?;
    println!(
        "placed {}: events={:?} error={:?}",
        placed.tx.hash,
        placed.receipt().map(|r| &r.events),
        placed.error()
    );

    if let Some(cid) = cid.filter(|_| placed.is_success()) {
        let cancelled = client.cancel_order_by_client_id(cid).await?;
        println!("cancelled {}: {:?}", cancelled.tx.hash, cancelled.error());
    }
    Ok(())
}

fn parse_seed(hex: &str) -> AnyResult<zeroize::Zeroizing<[u8; 32]>> {
    let hex = hex.trim().trim_start_matches("0x");
    if hex.len() != 64 {
        return Err("PROOF_PRIVATE_KEY_HEX must be 64 hex digits".into());
    }
    let mut seed = zeroize::Zeroizing::new([0u8; 32]);
    for (byte, pair) in seed.iter_mut().zip(hex.as_bytes().as_chunks::<2>().0) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair)?, 16)?;
    }
    Ok(seed)
}
