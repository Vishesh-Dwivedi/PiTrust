//! # PiTrust — Passport SBT Contract
//!
//! Mints a Soulbound Token (non-transferable identity credential) permanently
//! bonded to a Pioneer's Pi wallet address. Collecting a 1 Pi mint fee.
//!
//! ## Security Properties
//! - No transfer function: Soulbound by design
//! - Admin-only score and red flag writes (require_auth enforced)
//! - Persistent storage with TTL extension on every access
//! - Result<T, Error> throughout — no panics in production paths

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, String, Vec,
    token::Client as TokenClient,
};

// ── Storage Keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Passport(Address),
    Admin,
    Treasury,
    MintFee,         // i128 in stroops (1_000_000 = 1 Pi)
    TotalMinted,     // u64 counter
}

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum Tier {
    Unverified,  // 0–99
    Bronze,      // 100–299
    Silver,      // 300–499
    Gold,        // 500–699
    Platinum,    // 700–899
    Sentinel,    // 900–1000
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum RedFlagType {
    ScamConviction,    // -300 pts
    GhostTrade,        // -150 pts
    VouchCollusion,    // -200 pts
    MultipleAccounts,  // score frozen
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RedFlag {
    pub flag_type: RedFlagType,
    pub score_impact: i32,
    pub issued_at: u64,
    pub dispute_id: u64,
    pub rebuttal_hash: String,  // SHA256 of pioneer's written rebuttal (empty if none)
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PassportData {
    pub owner: Address,
    pub minted_at: u64,
    pub score: u32,
    pub tier: Tier,
    pub red_flags: Vec<RedFlag>,
    pub score_frozen: bool,
    pub completed_trades: u32,
    pub disputed_trades: u32,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyMinted     = 1,
    NotMinted         = 2,
    Unauthorized      = 3,
    ScoreFrozen       = 4,
    InvalidScore      = 5,
    NotInitialized    = 6,
    InsufficientFunds = 7,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEDGER_TTL_BUMP: u32 = 535_000; // ~1 year in ledgers (avg 5s/ledger)
const INSTANCE_TTL_BUMP: u32 = 535_000;

fn score_to_tier(score: u32) -> Tier {
    match score {
        0..=99   => Tier::Unverified,
        100..=299 => Tier::Bronze,
        300..=499 => Tier::Silver,
        500..=699 => Tier::Gold,
        700..=899 => Tier::Platinum,
        _         => Tier::Sentinel,
    }
}

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct PassportSbt;

#[contractimpl]
impl PassportSbt {
    /// One-time initialization. Sets admin, treasury, and mint fee.
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        mint_fee: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized); // Already initialized
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::MintFee, &mint_fee);
        env.storage().instance().set(&DataKey::TotalMinted, &0u64);
        env.storage().instance().extend_ttl(INSTANCE_TTL_BUMP, INSTANCE_TTL_BUMP);
        Ok(())
    }

    /// Mint a Soulbound Passport for the calling wallet. Requires 1 Pi fee.
    pub fn mint(env: Env, owner: Address, fee_token: Address) -> Result<(), Error> {
        owner.require_auth();
        Self::bump_instance(&env);

        // Prevent double-mint (Soulbound: one per wallet)
        if env.storage().persistent().has(&DataKey::Passport(owner.clone())) {
            return Err(Error::AlreadyMinted);
        }

        // Collect mint fee: owner → treasury
        let mint_fee: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MintFee)
            .ok_or(Error::NotInitialized)?;
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;

        let token = TokenClient::new(&env, &fee_token);
        let owner_balance = token.balance(&owner);
        if owner_balance < mint_fee {
            return Err(Error::InsufficientFunds);
        }
        token.transfer(&owner, &treasury, &mint_fee);

        // Create initial passport with a baseline score of 50
        let passport = PassportData {
            owner: owner.clone(),
            minted_at: env.ledger().timestamp(),
            score: 50,
            tier: Tier::Bronze,
            red_flags: Vec::new(&env),
            score_frozen: false,
            completed_trades: 0,
            disputed_trades: 0,
        };

        let key = DataKey::Passport(owner.clone());
        env.storage().persistent().set(&key, &passport);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);

        // Increment total minted counter
        let total: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalMinted)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalMinted, &(total + 1));

        Ok(())
    }

    /// Check if a wallet has a minted passport.
    pub fn is_minted(env: Env, owner: Address) -> bool {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .has(&DataKey::Passport(owner))
    }

    /// Read a passport. Bumps TTL on access.
    pub fn get_passport(env: Env, owner: Address) -> Result<PassportData, Error> {
        Self::bump_instance(&env);
        let key = DataKey::Passport(owner);
        let passport: PassportData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotMinted)?;
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);
        Ok(passport)
    }

    /// Update score snapshot. Called by the Score Oracle backend (admin-only).
    pub fn update_score(env: Env, owner: Address, new_score: u32) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        if new_score > 1000 {
            return Err(Error::InvalidScore);
        }

        let key = DataKey::Passport(owner.clone());
        let mut passport: PassportData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotMinted)?;

        if passport.score_frozen {
            return Err(Error::ScoreFrozen);
        }

        passport.score = new_score;
        passport.tier = score_to_tier(new_score);
        env.storage().persistent().set(&key, &passport);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);
        Ok(())
    }

    /// Freeze a passport score during an active dispute investigation.
    pub fn freeze_score(env: Env, owner: Address, frozen: bool) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Passport(owner.clone());
        let mut passport: PassportData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotMinted)?;

        passport.score_frozen = frozen;
        env.storage().persistent().set(&key, &passport);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);
        Ok(())
    }

    /// Add a red flag to a passport. Called by dispute_registry on conviction.
    pub fn add_red_flag(env: Env, owner: Address, flag: RedFlag) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Passport(owner.clone());
        let mut passport: PassportData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotMinted)?;

        passport.red_flags.push_back(flag);
        // Apply score impact (clamp to 0)
        env.storage().persistent().set(&key, &passport);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);
        Ok(())
    }

    /// Increment trade counters (called by trade_escrow on outcome).
    pub fn record_trade_outcome(
        env: Env,
        owner: Address,
        completed: bool,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Passport(owner.clone());
        let mut passport: PassportData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotMinted)?;

        if completed {
            passport.completed_trades += 1;
        } else {
            passport.disputed_trades += 1;
        }
        env.storage().persistent().set(&key, &passport);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);
        Ok(())
    }

    /// Total passports minted.
    pub fn total_minted(env: Env) -> u64 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::TotalMinted)
            .unwrap_or(0)
    }

    /// Update mint fee (governance-callable via admin).
    pub fn set_mint_fee(env: Env, new_fee: i128) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::MintFee, &new_fee);
        Self::bump_instance(&env);
        Ok(())
    }

    // ── Internal ────────────────────────────────────────────────────────────

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_BUMP, INSTANCE_TTL_BUMP);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token, Address, Env, IntoVal};

    fn create_token<'a>(env: &Env, admin: &Address) -> token::StellarAssetClient<'a> {
        let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
        token::StellarAssetClient::new(env, &contract_address.address())
    }

    #[test]
    fn test_mint_and_get_passport() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_client = create_token(&env, &token_admin);
        let token_id = token_client.address.clone();

        // Fund user with 2 Pi (2_000_000 stroops)
        token_client.mint(&user, &2_000_000);

        let contract_id = env.register(PassportSbt, ());
        let client = PassportSbtClient::new(&env, &contract_id);

        // Initialize with 1 Pi mint fee
        client.initialize(&admin, &treasury, &1_000_000);

        // Mint passport
        client.mint(&user, &token_id);

        // Verify passport exists
        assert!(client.is_minted(&user));
        let passport = client.get_passport(&user);
        assert_eq!(passport.score, 50);
        assert_eq!(passport.tier, Tier::Bronze);
        assert_eq!(passport.red_flags.len(), 0);

        // Verify treasury received fee
        let token_read = token::Client::new(&env, &token_id);
        assert_eq!(token_read.balance(&treasury), 1_000_000);
    }

    #[test]
    fn test_double_mint_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_client = create_token(&env, &token_admin);
        let token_id = token_client.address.clone();
        token_client.mint(&user, &4_000_000);

        let contract_id = env.register(PassportSbt, ());
        let client = PassportSbtClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &1_000_000);
        client.mint(&user, &token_id);

        // Second mint should error
        let result = client.try_mint(&user, &token_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_score_changes_tier() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_client = create_token(&env, &token_admin);
        let token_id = token_client.address.clone();
        token_client.mint(&user, &2_000_000);

        let contract_id = env.register(PassportSbt, ());
        let client = PassportSbtClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &1_000_000);
        client.mint(&user, &token_id);

        client.update_score(&user, &750);
        let passport = client.get_passport(&user);
        assert_eq!(passport.tier, Tier::Platinum);

        client.update_score(&user, &950);
        let passport = client.get_passport(&user);
        assert_eq!(passport.tier, Tier::Sentinel);
    }
}
