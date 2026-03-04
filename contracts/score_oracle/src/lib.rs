//! # PiTrust — Score Oracle Contract
//!
//! Stores an on-chain snapshot of each Pioneer's PiScore.
//! Written exclusively by the PiTrust backend oracle (admin-controlled keypair).
//! Read by any contract or external caller for trust-gating.
//!
//! Uses Temporary storage (cheaper) since score is refreshed by backend every 4h.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env,
};

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum Tier {
    Unverified,
    Bronze,
    Silver,
    Gold,
    Platinum,
    Sentinel,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Score(Address),
    Admin,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ScoreEntry {
    pub score: u32,
    pub tier: Tier,
    pub updated_at: u64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotFound       = 1,
    Unauthorized   = 2,
    InvalidScore   = 3,
    NotInitialized = 4,
}

// ── Contract ──────────────────────────────────────────────────────────────────

const TEMP_TTL: u32 = 17_280; // ~24 hours at 5s/ledger
const INSTANCE_TTL: u32 = 535_000;

fn score_to_tier(score: u32) -> Tier {
    match score {
        0..=99    => Tier::Unverified,
        100..=299 => Tier::Bronze,
        300..=499 => Tier::Silver,
        500..=699 => Tier::Gold,
        700..=899 => Tier::Platinum,
        _         => Tier::Sentinel,
    }
}

#[contract]
pub struct ScoreOracle;

#[contractimpl]
impl ScoreOracle {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);
        Ok(())
    }

    /// Write or update a pioneer's score. Oracle admin only.
    pub fn set_score(env: Env, owner: Address, score: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if score > 1000 {
            return Err(Error::InvalidScore);
        }

        let entry = ScoreEntry {
            score,
            tier: score_to_tier(score),
            updated_at: env.ledger().timestamp(),
        };

        let key = DataKey::Score(owner);
        // Temporary storage: auto-expires if oracle goes offline
        env.storage().temporary().set(&key, &entry);
        env.storage().temporary().extend_ttl(&key, TEMP_TTL, TEMP_TTL);
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);
        Ok(())
    }

    /// Get a pioneer's score. Returns 0 if no entry (un-staked).
    pub fn get_score(env: Env, owner: Address) -> u32 {
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);
        let key = DataKey::Score(owner);
        if let Some(entry) = env.storage().temporary().get::<DataKey, ScoreEntry>(&key) {
            env.storage().temporary().extend_ttl(&key, TEMP_TTL, TEMP_TTL);
            entry.score
        } else {
            0
        }
    }

    /// Get full score entry including tier and last updated timestamp.
    pub fn get_score_entry(env: Env, owner: Address) -> Result<ScoreEntry, Error> {
        env.storage().instance().extend_ttl(INSTANCE_TTL, INSTANCE_TTL);
        let key = DataKey::Score(owner);
        let entry = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::NotFound)?;
        env.storage().temporary().extend_ttl(&key, TEMP_TTL, TEMP_TTL);
        Ok(entry)
    }

    /// Get the tier for a pioneer. Used by trade_escrow, sentinel_staking, etc.
    pub fn get_tier(env: Env, owner: Address) -> Tier {
        let score = Self::get_score(env, owner);
        score_to_tier(score)
    }

    /// Check if pioneer meets a minimum score requirement.
    pub fn meets_minimum(env: Env, owner: Address, min_score: u32) -> bool {
        Self::get_score(env, owner) >= min_score
    }

    /// Update the oracle admin (for key rotation).
    pub fn rotate_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env};

    #[test]
    fn test_set_and_get_score() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let contract_id = env.register(ScoreOracle, ());
        let client = ScoreOracleClient::new(&env, &contract_id);

        client.initialize(&admin);
        client.set_score(&user, &750);

        assert_eq!(client.get_score(&user), 750);
        assert_eq!(client.get_tier(&user), Tier::Platinum);
        assert!(client.meets_minimum(&user, &700));
        assert!(!client.meets_minimum(&user, &800));
    }

    #[test]
    fn test_unknown_user_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let unknown = Address::generate(&env);

        let contract_id = env.register(ScoreOracle, ());
        let client = ScoreOracleClient::new(&env, &contract_id);
        client.initialize(&admin);

        assert_eq!(client.get_score(&unknown), 0);
        assert_eq!(client.get_tier(&unknown), Tier::Unverified);
    }

    #[test]
    fn test_invalid_score_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let contract_id = env.register(ScoreOracle, ());
        let client = ScoreOracleClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = client.try_set_score(&user, &1001);
        assert!(result.is_err());
    }
}
