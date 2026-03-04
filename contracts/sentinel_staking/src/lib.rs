//! # PiTrust — Sentinel Staking Contract
//!
//! Sentinel-tier pioneers (score ≥ 900) stake 50 Pi to become dispute arbitrators.
//! They earn 40% of filing fees on resolved disputes.
//! Corrupt votes (sole outlier in 3+ panel) slash 20% of bond.
//! Bounded: max 100 sentinels at a time.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, String, Vec,
    token::Client as TokenClient,
};

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Sentinel(Address),
    SentinelList,          // Vec<Address>: bounded at 100
    Admin,
    Treasury,
    BondAmount,            // 50 Pi
    MaxSentinels,
    TotalEarned,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum SentinelStatus {
    Active,
    Withdrawn,
    PartiallySlashed,      // Bond reduced but still active
    FullySlashed,          // Bond depleted; sentinel removed
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SentinelRecord {
    pub pioneer: Address,
    pub token: Address,
    pub bond_amount: i128,
    pub original_bond: i128,
    pub joined_at: u64,
    pub status: SentinelStatus,
    pub disputes_arbitrated: u32,
    pub total_earned: i128,
    pub active_disputes: u32,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized      = 1,
    Unauthorized        = 2,
    AlreadySentinel     = 3,
    NotASentinel        = 4,
    SentinelCapReached  = 5,
    HasActiveDisputes   = 6,
    InsufficientFunds   = 7,
    AlreadyWithdrawn    = 8,
    BondDepleted        = 9,
}

// ── Contract ──────────────────────────────────────────────────────────────────

const LEDGER_TTL: u32 = 535_000;
const BOND_AMOUNT: i128 = 50_000_000;    // 50 Pi
const MAX_SENTINELS: u32 = 100;
const SLASH_PCT: i128 = 20;              // 20% of remaining bond

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
pub struct SentinelStaking;

#[contractimpl]
impl SentinelStaking {
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
        env.storage().instance().set(&DataKey::BondAmount, &BOND_AMOUNT);
        env.storage().instance().set(&DataKey::MaxSentinels, &MAX_SENTINELS);
        env.storage().instance().set(&DataKey::TotalEarned, &0i128);
        // Initialize empty sentinel list
        let empty: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::SentinelList, &empty);
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Pioneer stakes 50 Pi to become a Sentinel arbitrator.
    /// Backend must validate score ≥ 900 before calling.
    pub fn apply_as_sentinel(
        env: Env,
        pioneer: Address,
        token: Address,
    ) -> Result<(), Error> {
        pioneer.require_auth();
        Self::bump_instance(&env);

        if env
            .storage()
            .persistent()
            .has(&DataKey::Sentinel(pioneer.clone()))
        {
            return Err(Error::AlreadySentinel);
        }

        // Check capacity (bounded at 100)
        let sentinels: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SentinelList)
            .unwrap_or_else(|| Vec::new(&env));
        if sentinels.len() >= MAX_SENTINELS {
            return Err(Error::SentinelCapReached);
        }

        let bond: i128 = env
            .storage()
            .instance()
            .get(&DataKey::BondAmount)
            .unwrap_or(BOND_AMOUNT);
        let token_client = TokenClient::new(&env, &token);
        if token_client.balance(&pioneer) < bond {
            return Err(Error::InsufficientFunds);
        }

        // Lock 50 Pi in contract
        token_client.transfer(&pioneer, &env.current_contract_address(), &bond);

        let record = SentinelRecord {
            pioneer: pioneer.clone(),
            token,
            bond_amount: bond,
            original_bond: bond,
            joined_at: env.ledger().timestamp(),
            status: SentinelStatus::Active,
            disputes_arbitrated: 0,
            total_earned: 0,
            active_disputes: 0,
        };

        let key = DataKey::Sentinel(pioneer.clone());
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        // Add to bounded sentinel list
        let mut updated_sentinels = sentinels;
        updated_sentinels.push_back(pioneer);
        env.storage().instance().set(&DataKey::SentinelList, &updated_sentinels);
        Ok(())
    }

    /// Distribute arbitration fee to a sentinel (called by dispute resolution backend).
    pub fn earn_arbitration_fee(
        env: Env,
        sentinel: Address,
        amount: i128,
        token: Address,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Sentinel(sentinel.clone());
        let mut record: SentinelRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotASentinel)?;

        let token_client = TokenClient::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &sentinel, &amount);

        record.total_earned += amount;
        record.disputes_arbitrated += 1;
        if record.active_disputes > 0 {
            record.active_disputes -= 1;
        }
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Slash a sentinel for casting a corrupt vote. Admin only.
    /// Slashes 20% of remaining bond; if bond ≤ 0, removes from sentinel list.
    pub fn slash_corrupt_vote(
        env: Env,
        sentinel: Address,
        reason_hash: String,
    ) -> Result<(), Error> {
        let _ = reason_hash;
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Sentinel(sentinel.clone());
        let mut record: SentinelRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotASentinel)?;

        let slash_amount = (record.bond_amount * SLASH_PCT) / 100;
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;

        let token_client = TokenClient::new(&env, &record.token);
        token_client.transfer(&env.current_contract_address(), &treasury, &slash_amount);

        record.bond_amount -= slash_amount;
        if record.bond_amount <= 0 {
            record.status = SentinelStatus::FullySlashed;
            // Remove from sentinel list
            Self::remove_from_list(&env, &sentinel);
        } else {
            record.status = SentinelStatus::PartiallySlashed;
        }

        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Withdraw bond. Only allowed if no active disputes assigned.
    pub fn withdraw_bond(env: Env, pioneer: Address) -> Result<(), Error> {
        pioneer.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Sentinel(pioneer.clone());
        let mut record: SentinelRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotASentinel)?;

        if record.active_disputes > 0 {
            return Err(Error::HasActiveDisputes);
        }
        if record.status == SentinelStatus::Withdrawn {
            return Err(Error::AlreadyWithdrawn);
        }
        if record.bond_amount <= 0 {
            return Err(Error::BondDepleted);
        }

        let token_client = TokenClient::new(&env, &record.token);
        token_client.transfer(
            &env.current_contract_address(),
            &pioneer,
            &record.bond_amount,
        );

        record.status = SentinelStatus::Withdrawn;
        record.bond_amount = 0;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        Self::remove_from_list(&env, &pioneer);
        Ok(())
    }

    /// Assign an active dispute to a sentinel (increments active_disputes counter).
    pub fn assign_dispute(env: Env, sentinel: Address) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Sentinel(sentinel.clone());
        let mut record: SentinelRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotASentinel)?;

        record.active_disputes += 1;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    pub fn get_sentinel(env: Env, pioneer: Address) -> Result<SentinelRecord, Error> {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Sentinel(pioneer))
            .ok_or(Error::NotASentinel)
    }

    /// Returns list of all active sentinel addresses. Bounded at 100.
    pub fn list_sentinels(env: Env) -> Vec<Address> {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::SentinelList)
            .unwrap_or_else(|| Vec::new(&env))
    }

    // ── Internal ───────────────────────────────────────────────────────────

    fn remove_from_list(env: &Env, sentinel: &Address) {
        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SentinelList)
            .unwrap_or_else(|| Vec::new(env));
        for i in 0..list.len() {
            if list.get(i).as_ref() == Some(sentinel) {
                list.remove(i);
                break;
            }
        }
        env.storage().instance().set(&DataKey::SentinelList, &list);
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token, Address, Env};

    #[test]
    fn test_apply_and_withdraw() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let pioneer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_c = {
            let a = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(&env, &a.address())
        };
        token_c.mint(&pioneer, &60_000_000);

        let cid = env.register(SentinelStaking, ());
        let client = SentinelStakingClient::new(&env, &cid);
        client.initialize(&admin, &treasury);

        client.apply_as_sentinel(&pioneer, &token_c.address);
        let sentinels = client.list_sentinels();
        assert_eq!(sentinels.len(), 1);

        client.withdraw_bond(&pioneer);
        let token_r = token::Client::new(&env, &token_c.address);
        assert_eq!(token_r.balance(&pioneer), 60_000_000); // full bond returned
        assert_eq!(client.list_sentinels().len(), 0);
    }
}
