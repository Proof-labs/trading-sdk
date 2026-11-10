//! Stream one market's book and trades plus this account's events, keeping a
//! local top of book.
//!
//! ```sh
//! cargo run -p proof-sdk-rs --example stream            # throwaway key, 20 messages
//! PROOF_PRIVATE_KEY_HEX=<64 hex> PROOF_MESSAGES=0 cargo run -p proof-sdk-rs --example stream
//! ```

use std::collections::BTreeMap;

use proof_sdk_rs::{
    ClientConfig, ExchangeClient, LocalSigner, Side, Subscription, WsClient, WsConfig, WsMessage,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let market: u32 = std::env::var("PROOF_MARKET").map_or(Ok(1), |m| m.parse())?;
    let limit: usize = std::env::var("PROOF_MESSAGES").map_or(Ok(20), |m| m.parse())?;
    let seed = match std::env::var("PROOF_PRIVATE_KEY_HEX") {
        Ok(hex) => {
            let mut seed = zeroize::Zeroizing::new([0u8; 32]);
            let hex = hex.trim().trim_start_matches("0x");
            for (b, pair) in seed.iter_mut().zip(hex.as_bytes().chunks_exact(2)) {
                *b = u8::from_str_radix(std::str::from_utf8(pair)?, 16)?;
            }
            seed
        }
        Err(_) => proof_sdk_rs::random_seed(),
    };

    let config = ClientConfig::devnet();
    let client = ExchangeClient::connect(&config, LocalSigner::from_bytes(&seed)).await?;
    let ws_config = WsConfig::from_client_config(&config)?.with_account_auth(client.account_auth());
    let (ws, mut rx) = WsClient::connect(ws_config).await?;
    ws.subscribe(Subscription::Orderbook(market))?;
    ws.subscribe(Subscription::Trades(market))?;
    ws.subscribe(Subscription::AccountEvents(client.address()))?;

    // price -> quantity, per side
    let mut bids = BTreeMap::new();
    let mut asks = BTreeMap::new();
    let mut received = 0;
    while let Some(msg) = rx.recv().await {
        match msg {
            WsMessage::OrderbookSnapshot {
                bids: b, asks: a, ..
            } => {
                bids = b.iter().map(|l| (l.price, l.quantity)).collect();
                asks = a.iter().map(|l| (l.price, l.quantity)).collect();
            }
            WsMessage::OrderbookUpdate { side, level, .. } => {
                let book = if side == Side::Buy {
                    &mut bids
                } else {
                    &mut asks
                };
                if level.quantity == 0 {
                    book.remove(&level.price);
                } else {
                    book.insert(level.price, level.quantity);
                }
            }
            WsMessage::Reconnected => println!("reconnected; books will re-snapshot"),
            other => println!("{other:?}"),
        }
        println!(
            "top of book: {:?} / {:?}",
            bids.last_key_value(),
            asks.first_key_value()
        );
        received += 1;
        if limit != 0 && received >= limit {
            break;
        }
    }
    ws.close();
    Ok(())
}
