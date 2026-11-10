//! Stream one market's book and trades plus this account's events, keeping a
//! local top of book.
//!
//! ```sh
//! cargo run -p proof-sdk-rs --example stream            # throwaway key, 20 messages
//! PROOF_PRIVATE_KEY_HEX=<64 hex> PROOF_MESSAGES=0 cargo run -p proof-sdk-rs --example stream
//! ```

use proof_sdk_rs::{
    ClientConfig, ExchangeClient, LocalSigner, Orderbook, Subscription, WsClient, WsMessage,
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
    let (ws, mut rx) = WsClient::connect(client.ws_config()).await?;
    ws.subscribe(Subscription::Orderbook(market))?;
    ws.subscribe(Subscription::Trades(market))?;
    ws.subscribe(Subscription::AccountEvents(client.address()))?;

    let mut book = Orderbook::default();
    let mut received = 0;
    while let Some(msg) = rx.recv().await {
        match msg {
            WsMessage::OrderbookSnapshot { book: b, .. } => book = b,
            WsMessage::OrderbookUpdate { side, level, .. } => book.apply(side, level),
            WsMessage::Reconnected => println!("reconnected; books will re-snapshot"),
            other => println!("{other:?}"),
        }
        println!("top of book: {:?} / {:?}", book.best_bid(), book.best_ask());
        received += 1;
        if limit != 0 && received >= limit {
            break;
        }
    }
    ws.close();
    Ok(())
}
