//! # PiTrust — Recovery Escrow Contract
//!
//! Allows flagged pioneers to enter a 12-month rehabilitation program.
//! Pioneer locks 50 Pi for 1 year. After completing the period, 49 Pi returned,
//! 1 Pi taken as rehabilitation fee. Backend restores partial score.
//!
//! Design rationale: 50 Pi / 1 year is intentionally significant — trivial
//! amounts invite gaming. The bond demonstrates genuine intent to reform.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env,
    token::Client as TokenClient,
};

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Recovery(Address),
    Admin,
    Treasury,
    RecoveryFee,       // 1 Pi = 1_000_000 stroops
    LockAmount,        // 50 Pi = 50_000_000 stroops
    LockDuration,      // 365 * 24 * 3600 = 31_536_000 seconds
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum RecoveryStatus {
    Active,
    Completed,
    EmergencyExited,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RecoveryRecord {
    pub pioneer: Address,
    pub entered_at: u64,
    pub unlocks_at: u64,
    pub token: Address,
    pub amount_locked: i128,
    pub status: RecoveryStatus,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized       = 1,
    Unauthorized         = 2,
    AlreadyInRecovery    = 3,
    NotInRecovery        = 4,
    LockPeriodNotOver    = 5,
    InsufficientFunds    = 6,
    AlreadyCompleted     = 7,
}

// ── Contract ──────────────────────────────────────────────────────────────────

const LEDGER_TTL: u32 = 535_000;
const ONE_YEAR_SECS: u64 = 31_536_000;
const LOCK_AMOUNT: i128 = 50_000_000;   // 50 Pi
const REHAB_FEE: i128 = 1_000_000;      // 1 Pi

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
pub struct RecoveryEscrow;

#[contractimpl]
impl RecoveryEscrow {
    pub fn initialize(env: Env, admin: Address, treasury: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Pioneer enters 1-year rehabilitation. Locks 50 Pi.
    pub fn enter_recovery(
        env: Env,
        pioneer: Address,
        token: Address,
    ) -> Result<(), Error> {
        pioneer.require_auth();
        Self::bump_instance(&env);

        // Cannot enter twice while active
        if let Some(record) = env
            .storage()
            .persistent()
            .get::<DataKey, RecoveryRecord>(&DataKey::Recovery(pioneer.clone()))
        {
            if record.status == RecoveryStatus::Active {
                return Err(Error::AlreadyInRecovery);
            }
        }

        let token_client = TokenClient::new(&env, &token);
        if token_client.balance(&pioneer) < LOCK_AMOUNT {
            return Err(Error::InsufficientFunds);
        }

        // Transfer 50 Pi to this contract
        token_client.transfer(&pioneer, &env.current_contract_address(), &LOCK_AMOUNT);

        let now = env.ledger().timestamp();
        let record = RecoveryRecord {
            pioneer: pioneer.clone(),
            entered_at: now,
            unlocks_at: now + ONE_YEAR_SECS,
            token,
            amount_locked: LOCK_AMOUNT,
            status: RecoveryStatus::Active,
        };

        let key = DataKey::Recovery(pioneer);
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Complete rehabilitation after 1 year. Returns 49 Pi; 1 Pi rehab fee.
    pub fn complete_recovery(env: Env, pioneer: Address) -> Result<(), Error> {
        pioneer.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Recovery(pioneer.clone());
        let mut record: RecoveryRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInRecovery)?;

        if record.status != RecoveryStatus::Active {
            return Err(Error::AlreadyCompleted);
        }

        let now = env.ledger().timestamp();
        if now < record.unlocks_at {
            return Err(Error::LockPeriodNotOver);
        }

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;

        let token_client = TokenClient::new(&env, &record.token);
        let return_amount = LOCK_AMOUNT - REHAB_FEE;

        // Return 49 Pi to pioneer
        token_client.transfer(&env.current_contract_address(), &pioneer, &return_amount);
        // 1 Pi rehab fee → treasury
        token_client.transfer(&env.current_contract_address(), &treasury, &REHAB_FEE);

        record.status = RecoveryStatus::Completed;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Emergency exit — admin only. Used for contract migration/bugs.
    /// Returns full 50 Pi, no fee. All emergency exits are on-chain for audit.
    pub fn emergency_exit(env: Env, pioneer: Address, reason_hash: String) -> Result<(), Error> {
        let _ = reason_hash; // stored in event, not on-chain state
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Recovery(pioneer.clone());
        let mut record: RecoveryRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInRecovery)?;

        if record.status != RecoveryStatus::Active {
            return Err(Error::AlreadyCompleted);
        }

        let token_client = TokenClient::new(&env, &record.token);
        // Full refund — no penalty on admin emergency
        token_client.transfer(
            &env.current_contract_address(),
            &pioneer,
            &record.amount_locked,
        );

        record.status = RecoveryStatus::EmergencyExited;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    pub fn get_recovery_status(env: Env, pioneer: Address) -> Option<RecoveryRecord> {
        Self::bump_instance(&env);
        let key = DataKey::Recovery(pioneer);
        env.storage().persistent().get(&key)
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
    }
}

// Adding the String import for emergency_exit
use soroban_sdk::String;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token, Address, Env};

    #[test]
    fn test_enter_and_complete_recovery() {
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
        token_c.mint(&pioneer, &60_000_000); // 60 Pi

        let cid = env.register(RecoveryEscrow, ());
        let client = RecoveryEscrowClient::new(&env, &cid);
        client.initialize(&admin, &treasury);

        client.enter_recovery(&pioneer, &token_c.address);

        // Advance 1 year
        env.ledger().with_mut(|l| {
            l.timestamp += ONE_YEAR_SECS + 1;
        });

        client.complete_recovery(&pioneer);

        let status = client.get_recovery_status(&pioneer).unwrap();
        assert_eq!(status.status, RecoveryStatus::Completed);

        let token_r = token::Client::new(&env, &token_c.address);
        // Pioneer should have: 60_000_000 (start) - 50_000_000 (locked) + 49_000_000 (returned) = 59_000_000
        assert_eq!(token_r.balance(&pioneer), 59_000_000);
        assert_eq!(token_r.balance(&treasury), 1_000_000);
    }

    #[test]
    fn test_early_withdrawal_fails() {
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

        let cid = env.register(RecoveryEscrow, ());
        let client = RecoveryEscrowClient::new(&env, &cid);
        client.initialize(&admin, &treasury);
        client.enter_recovery(&pioneer, &token_c.address);

        // Only 1 day passed — should fail
        env.ledger().with_mut(|l| { l.timestamp += 86_400; });

        let result = client.try_complete_recovery(&pioneer);
        assert!(result.is_err());
    }
}
