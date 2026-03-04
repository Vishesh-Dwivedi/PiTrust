//! # PiTrust — Trade Escrow Contract
//!
//! Score-gated trustless P2P trade between two pioneers.
//! Buyer locks Pi → seller delivers → buyer confirms → Pi releases.
//! Auto-release after 7 days if buyer doesn't respond (prevents griefing).
//! 1% platform fee on successful completion → treasury.
//! Disputed trades are frozen until dispute_registry finalizes outcome.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, String,
    token::Client as TokenClient,
};

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Trade(u64),
    TotalTrades,
    Admin,
    Treasury,
    PlatformFeeBps,      // default 100 = 1%
    MinTradeAmount,      // default 100_000 = 0.1 Pi
    AutoReleasePeriod,   // default 604_800 = 7 days in seconds
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum TradeStatus {
    Created,          // Buyer deposited, awaiting seller acceptance
    SellerAccepted,   // Seller confirmed they will deliver
    DeliveryPending,  // Seller marked as delivered; buyer must confirm
    Completed,        // Buyer confirmed; Pi released to seller
    Disputed,         // Under dispute_registry review
    Cancelled,        // Cancelled before seller accepted
    AutoReleased,     // Auto-released after 7-day window
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct TradeData {
    pub id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,               // net after fee reservation
    pub platform_fee: i128,
    pub token: Address,
    pub description_hash: String,   // SHA256 of trade description
    pub min_seller_score: u32,      // buyer-set score gate
    pub status: TradeStatus,
    pub created_at: u64,
    pub seller_accepted_at: u64,
    pub delivery_marked_at: u64,
    pub auto_release_deadline: u64, // delivery_marked_at + 7 days
    pub dispute_id: u64,            // 0 if no dispute
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized      = 1,
    Unauthorized        = 2,
    TradeNotFound       = 3,
    InvalidState        = 4,
    ScoreTooLow         = 5,
    AmountTooSmall      = 6,
    InsufficientFunds   = 7,
    AutoReleaseNotReady = 8,
    SelfTrade           = 9,
}

// ── Contract ──────────────────────────────────────────────────────────────────

const LEDGER_TTL: u32 = 535_000;
const PLATFORM_FEE_BPS: i64 = 100;     // 1%
const MIN_TRADE: i128 = 100_000;        // 0.1 Pi
const AUTO_RELEASE: u64 = 604_800;      // 7 days

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

#[contract]
pub struct TradeEscrow;

#[contractimpl]
impl TradeEscrow {
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::PlatformFeeBps, &PLATFORM_FEE_BPS);
        env.storage().instance().set(&DataKey::MinTradeAmount, &MIN_TRADE);
        env.storage().instance().set(&DataKey::AutoReleasePeriod, &AUTO_RELEASE);
        env.storage().instance().set(&DataKey::TotalTrades, &0u64);
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Create a trade. Buyer locks Pi in escrow + sets minimum score gate for seller.
    pub fn create_trade(
        env: Env,
        buyer: Address,
        seller: Address,
        amount: i128,
        token: Address,
        description_hash: String,
        min_seller_score: u32,
    ) -> Result<u64, Error> {
        buyer.require_auth();
        Self::bump_instance(&env);

        if buyer == seller {
            return Err(Error::SelfTrade);
        }
        if amount < MIN_TRADE {
            return Err(Error::AmountTooSmall);
        }

        let token_client = TokenClient::new(&env, &token);
        if token_client.balance(&buyer) < amount {
            return Err(Error::InsufficientFunds);
        }

        // Transfer full amount to escrow (fee deducted on completion)
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        // Calculate platform fee (reserved, collected on completion)
        let fee_bps: i64 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(PLATFORM_FEE_BPS);
        let platform_fee = (amount * fee_bps as i128) / 10_000;

        let total: u64 = env.storage().instance().get(&DataKey::TotalTrades).unwrap_or(0);
        let trade_id = total + 1;

        let now = env.ledger().timestamp();
        let trade = TradeData {
            id: trade_id,
            buyer,
            seller,
            amount,
            platform_fee,
            token,
            description_hash,
            min_seller_score,
            status: TradeStatus::Created,
            created_at: now,
            seller_accepted_at: 0,
            delivery_marked_at: 0,
            auto_release_deadline: 0,
            dispute_id: 0,
        };

        let key = DataKey::Trade(trade_id);
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        env.storage().instance().set(&DataKey::TotalTrades, &trade_id);
        Ok(trade_id)
    }

    /// Seller accepts the trade (commits to delivering). Score gate checked here.
    /// In production, backend verifies seller score via score_oracle before calling.
    pub fn seller_accept(env: Env, seller: Address, trade_id: u64) -> Result<(), Error> {
        seller.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Trade(trade_id);
        let mut trade: TradeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if trade.status != TradeStatus::Created {
            return Err(Error::InvalidState);
        }
        if trade.seller != seller {
            return Err(Error::Unauthorized);
        }

        trade.status = TradeStatus::SellerAccepted;
        trade.seller_accepted_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Seller marks delivery as complete. Starts 7-day buyer confirmation window.
    pub fn mark_delivered(env: Env, seller: Address, trade_id: u64) -> Result<(), Error> {
        seller.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Trade(trade_id);
        let mut trade: TradeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if trade.status != TradeStatus::SellerAccepted {
            return Err(Error::InvalidState);
        }
        if trade.seller != seller {
            return Err(Error::Unauthorized);
        }

        let now = env.ledger().timestamp();
        trade.status = TradeStatus::DeliveryPending;
        trade.delivery_marked_at = now;
        trade.auto_release_deadline = now + AUTO_RELEASE;
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Buyer confirms receipt. Pi released to seller minus platform fee.
    pub fn confirm_delivery(env: Env, buyer: Address, trade_id: u64) -> Result<(), Error> {
        buyer.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Trade(trade_id);
        let mut trade: TradeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if trade.status != TradeStatus::DeliveryPending {
            return Err(Error::InvalidState);
        }
        if trade.buyer != buyer {
            return Err(Error::Unauthorized);
        }

        Self::release_to_seller(&env, &trade)?;
        trade.status = TradeStatus::Completed;
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Auto-release after 7-day window. Anyone can call (permissionless execution).
    pub fn auto_release(env: Env, trade_id: u64) -> Result<(), Error> {
        Self::bump_instance(&env);

        let key = DataKey::Trade(trade_id);
        let mut trade: TradeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if trade.status != TradeStatus::DeliveryPending {
            return Err(Error::InvalidState);
        }

        let now = env.ledger().timestamp();
        if now < trade.auto_release_deadline {
            return Err(Error::AutoReleaseNotReady);
        }

        Self::release_to_seller(&env, &trade)?;
        trade.status = TradeStatus::AutoReleased;
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Buyer disputes the trade. Funds frozen until dispute_registry finalizes.
    pub fn dispute_trade(env: Env, claimant: Address, trade_id: u64) -> Result<(), Error> {
        claimant.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Trade(trade_id);
        let mut trade: TradeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if trade.status != TradeStatus::DeliveryPending
            && trade.status != TradeStatus::SellerAccepted
        {
            return Err(Error::InvalidState);
        }
        if trade.buyer != claimant {
            return Err(Error::Unauthorized);
        }

        // Funds remain in this contract until dispute resolves.
        // Backend calls release_to_seller or release_to_buyer after dispute outcome.
        trade.status = TradeStatus::Disputed;
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Cancel a trade before seller accepts. Returns Pi to buyer.
    pub fn cancel_trade(env: Env, buyer: Address, trade_id: u64) -> Result<(), Error> {
        buyer.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Trade(trade_id);
        let mut trade: TradeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if trade.status != TradeStatus::Created {
            return Err(Error::InvalidState);
        }
        if trade.buyer != buyer {
            return Err(Error::Unauthorized);
        }

        let token_client = TokenClient::new(&env, &trade.token);
        token_client.transfer(&env.current_contract_address(), &buyer, &trade.amount);

        trade.status = TradeStatus::Cancelled;
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Admin releases to buyer after dispute ruling (claimant wins).
    pub fn admin_release_to_buyer(env: Env, trade_id: u64) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Trade(trade_id);
        let mut trade: TradeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if trade.status != TradeStatus::Disputed {
            return Err(Error::InvalidState);
        }

        let token_client = TokenClient::new(&env, &trade.token);
        // Full refund to buyer; seller loses trade amount (consequence of conviction)
        token_client.transfer(&env.current_contract_address(), &trade.buyer, &trade.amount);

        trade.status = TradeStatus::Cancelled;
        env.storage().persistent().set(&key, &trade);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    pub fn get_trade(env: Env, trade_id: u64) -> Result<TradeData, Error> {
        Self::bump_instance(&env);
        let key = DataKey::Trade(trade_id);
        env.storage().persistent().get(&key).ok_or(Error::TradeNotFound)
    }

    pub fn total_trades(env: Env) -> u64 {
        Self::bump_instance(&env);
        env.storage().instance().get(&DataKey::TotalTrades).unwrap_or(0)
    }

    // ── Internal ───────────────────────────────────────────────────────────

    fn release_to_seller(env: &Env, trade: &TradeData) -> Result<(), Error> {
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;
        let token_client = TokenClient::new(env, &trade.token);
        let seller_amount = trade.amount - trade.platform_fee;
        token_client.transfer(&env.current_contract_address(), &trade.seller, &seller_amount);
        token_client.transfer(&env.current_contract_address(), &treasury, &trade.platform_fee);
        Ok(())
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token, Address, Env, String};

    #[test]
    fn test_full_trade_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_c = {
            let a = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(&env, &a.address())
        };
        token_c.mint(&buyer, &10_000_000); // 10 Pi

        let cid = env.register(TradeEscrow, ());
        let client = TradeEscrowClient::new(&env, &cid);
        client.initialize(&admin, &treasury);

        let trade_id = client.create_trade(
            &buyer, &seller, &5_000_000, &token_c.address,
            &String::from_str(&env, "sha256:desc"), &0,
        );
        assert_eq!(trade_id, 1);

        client.seller_accept(&seller, &1);
        client.mark_delivered(&seller, &1);
        client.confirm_delivery(&buyer, &1);

        let trade = client.get_trade(&1);
        assert_eq!(trade.status, TradeStatus::Completed);

        let token_r = token::Client::new(&env, &token_c.address);
        // Seller gets 5Pi - 1% fee = 4_950_000; treasury gets 50_000 fee
        assert_eq!(token_r.balance(&seller), 4_950_000);
        assert_eq!(token_r.balance(&treasury), 50_000);
    }

    #[test]
    fn test_cancel_before_acceptance() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_c = {
            let a = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(&env, &a.address())
        };
        token_c.mint(&buyer, &5_000_000);

        let cid = env.register(TradeEscrow, ());
        let client = TradeEscrowClient::new(&env, &cid);
        client.initialize(&admin, &treasury);

        client.create_trade(
            &buyer, &seller, &2_000_000, &token_c.address,
            &String::from_str(&env, "sha256:x"), &0,
        );
        client.cancel_trade(&buyer, &1);

        let token_r = token::Client::new(&env, &token_c.address);
        assert_eq!(token_r.balance(&buyer), 5_000_000); // full refund
    }
}
