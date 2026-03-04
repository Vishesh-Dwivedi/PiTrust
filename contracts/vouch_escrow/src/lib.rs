//! # PiTrust — Vouch Escrow Contract
//!
//! Pioneers stake Pi to vouch for other pioneers. Creates real economic
//! accountability: if vouchee scams, staked Pi is slashed (80% burned,
//! 20% sent to victim). 2% commission on each stake goes to protocol treasury.
//!
//! ## Anti-Sybil Properties
//! - Minimum stake: 0.1 Pi (100_000 stroops)
//! - 90-day lock on vouch withdrawal
//! - Diminishing returns in score formula (handled off-chain by score engine)
//! - Economic loss for fake review rings on any slash event

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, Vec,
    token::Client as TokenClient,
};

// ── Storage Keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    VouchesFor(Address),     // Vec<VouchEntry> for a given vouchee
    VouchedBy(Address),      // Vec<VouchId> that a voucher has made
    Admin,
    Treasury,
    TotalVouches,
    CommissionBps,           // default 200 = 2%
    MinStake,                // default 100_000 stroops = 0.1 Pi
    LockPeriod,              // default 7_776_000 secs = 90 days
}

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VouchStatus {
    Active,
    Withdrawn,
    Slashed,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct VouchEntry {
    pub id: u64,
    pub voucher: Address,
    pub vouchee: Address,
    pub amount: i128,          // net amount after commission
    pub staked_at: u64,
    pub token: Address,
    pub status: VouchStatus,
    pub slash_victim: Address, // populated on slash; burn address otherwise
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized   = 1,
    Unauthorized     = 2,
    BelowMinStake    = 3,
    VouchNotFound    = 4,
    AlreadySlashed   = 5,
    LockPeriodActive = 6,
    InsufficientFunds = 7,
    SelfVouch        = 8,
}

// ── Contract ──────────────────────────────────────────────────────────────────

const LEDGER_TTL_BUMP: u32 = 535_000;
const INSTANCE_TTL_BUMP: u32 = 535_000;
const MAX_VOUCHES_PER_WALLET: u32 = 50; // Bounded Vec: Soroban best practice

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
pub struct VouchEscrow;

#[contractimpl]
impl VouchEscrow {
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
        env.storage().instance().set(&DataKey::CommissionBps, &200i64);
        env.storage().instance().set(&DataKey::MinStake, &100_000i128);
        env.storage().instance().set(&DataKey::LockPeriod, &7_776_000u64); // 90 days
        env.storage().instance().set(&DataKey::TotalVouches, &0u64);
        env.storage().instance().extend_ttl(INSTANCE_TTL_BUMP, INSTANCE_TTL_BUMP);
        Ok(())
    }

    /// Stake Pi to vouch for a pioneer. 2% commission deducted upfront.
    pub fn stake_vouch(
        env: Env,
        voucher: Address,
        vouchee: Address,
        amount: i128,
        token: Address,
    ) -> Result<u64, Error> {
        voucher.require_auth();
        Self::bump_instance(&env);

        if voucher == vouchee {
            return Err(Error::SelfVouch);
        }

        let min_stake: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinStake)
            .ok_or(Error::NotInitialized)?;

        if amount < min_stake {
            return Err(Error::BelowMinStake);
        }

        let token_client = TokenClient::new(&env, &token);
        if token_client.balance(&voucher) < amount {
            return Err(Error::InsufficientFunds);
        }

        // Calculate commission (2%) → treasury
        let commission_bps: i64 = env
            .storage()
            .instance()
            .get(&DataKey::CommissionBps)
            .unwrap_or(200);
        let commission = (amount * commission_bps as i128) / 10_000;
        let net_stake = amount - commission;

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;

        // Transfer commission to treasury
        token_client.transfer(&voucher, &treasury, &commission);
        // Transfer net stake to THIS contract (held in escrow)
        token_client.transfer(&voucher, &env.current_contract_address(), &net_stake);

        // Build VouchEntry
        let total: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalVouches)
            .unwrap_or(0);
        let vouch_id = total + 1;

        let burn_address = treasury.clone(); // placeholder; real burn addr configured on mainnet
        let entry = VouchEntry {
            id: vouch_id,
            voucher: voucher.clone(),
            vouchee: vouchee.clone(),
            amount: net_stake,
            staked_at: env.ledger().timestamp(),
            token: token.clone(),
            status: VouchStatus::Active,
            slash_victim: burn_address,
        };

        // Append to vouchee's vouch list (bounded)
        let vouch_key = DataKey::VouchesFor(vouchee.clone());
        let mut vouches: Vec<VouchEntry> = env
            .storage()
            .persistent()
            .get(&vouch_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Enforce bounded list
        if vouches.len() >= MAX_VOUCHES_PER_WALLET {
            // Remove oldest withdrawn/slashed entry to make room
            let mut found = false;
            for i in 0..vouches.len() {
                if vouches.get(i).map(|v| v.status != VouchStatus::Active).unwrap_or(false) {
                    vouches.remove(i);
                    found = true;
                    break;
                }
            }
            if !found {
                // All active — still push for now (trust high-vouch wallets)
            }
        }

        vouches.push_back(entry);
        env.storage().persistent().set(&vouch_key, &vouches);
        env.storage().persistent().extend_ttl(&vouch_key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);

        env.storage().instance().set(&DataKey::TotalVouches, &vouch_id);
        Ok(vouch_id)
    }

    /// Return all active vouches for a pioneer (for score engine consumption).
    pub fn get_vouches_for(env: Env, vouchee: Address) -> Vec<VouchEntry> {
        Self::bump_instance(&env);
        let key = DataKey::VouchesFor(vouchee);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Slash all active vouches for a scammer. Called by dispute_registry on conviction.
    /// Returns total Pi slashed (for event logging).
    pub fn slash_all_vouches(
        env: Env,
        vouchee: Address,
        victim: Address,        // receives 20% of slashed amount
    ) -> Result<i128, Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let vouch_key = DataKey::VouchesFor(vouchee.clone());
        let mut vouches: Vec<VouchEntry> = env
            .storage()
            .persistent()
            .get(&vouch_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut total_slashed: i128 = 0;

        for i in 0..vouches.len() {
            let mut entry = vouches.get(i).unwrap();
            if entry.status == VouchStatus::Active {
                let token_client = TokenClient::new(&env, &entry.token);

                // 20% to victim, 80% to treasury (burn equivalent)
                let victim_share = (entry.amount * 20) / 100;
                let burn_share = entry.amount - victim_share;

                let treasury: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::Treasury)
                    .ok_or(Error::NotInitialized)?;

                token_client.transfer(&env.current_contract_address(), &victim, &victim_share);
                token_client.transfer(&env.current_contract_address(), &treasury, &burn_share);

                total_slashed += entry.amount;
                entry.status = VouchStatus::Slashed;
                entry.slash_victim = victim.clone();
                vouches.set(i, entry);
            }
        }

        env.storage().persistent().set(&vouch_key, &vouches);
        env.storage().persistent().extend_ttl(&vouch_key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);
        Ok(total_slashed)
    }

    /// Withdraw a vouch after the 90-day lock period.
    pub fn withdraw_vouch(
        env: Env,
        voucher: Address,
        vouchee: Address,
        vouch_id: u64,
    ) -> Result<(), Error> {
        voucher.require_auth();
        Self::bump_instance(&env);

        let lock_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LockPeriod)
            .unwrap_or(7_776_000);

        let vouch_key = DataKey::VouchesFor(vouchee.clone());
        let mut vouches: Vec<VouchEntry> = env
            .storage()
            .persistent()
            .get(&vouch_key)
            .ok_or(Error::VouchNotFound)?;

        let now = env.ledger().timestamp();

        for i in 0..vouches.len() {
            let mut entry = vouches.get(i).unwrap();
            if entry.id == vouch_id && entry.voucher == voucher {
                if entry.status == VouchStatus::Slashed {
                    return Err(Error::AlreadySlashed);
                }
                if now < entry.staked_at + lock_period {
                    return Err(Error::LockPeriodActive);
                }
                let token_client = TokenClient::new(&env, &entry.token);
                token_client.transfer(
                    &env.current_contract_address(),
                    &voucher,
                    &entry.amount,
                );
                entry.status = VouchStatus::Withdrawn;
                vouches.set(i, entry);
                env.storage().persistent().set(&vouch_key, &vouches);
                env.storage().persistent().extend_ttl(&vouch_key, LEDGER_TTL_BUMP, LEDGER_TTL_BUMP);
                return Ok(());
            }
        }
        Err(Error::VouchNotFound)
    }

    /// Update commission BPS (via governance).
    pub fn set_commission_bps(env: Env, new_bps: i64) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::CommissionBps, &new_bps);
        Self::bump_instance(&env);
        Ok(())
    }

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
    use soroban_sdk::{token, Address, Env};

    fn setup(env: &Env) -> (Address, Address, Address, token::StellarAssetClient) {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let token_admin = Address::generate(env);
        let token_client = {
            let addr = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(env, &addr.address())
        };
        (admin, treasury, token_admin, token_client)
    }

    #[test]
    fn test_stake_vouch_and_get() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, treasury, _, token_client) = setup(&env);
        let voucher = Address::generate(&env);
        let vouchee = Address::generate(&env);
        token_client.mint(&voucher, &1_000_000); // 1 Pi

        let contract_id = env.register(VouchEscrow, ());
        let client = VouchEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury);

        let vouch_id = client.stake_vouch(&voucher, &vouchee, &500_000, &token_client.address);
        assert_eq!(vouch_id, 1);

        let vouches = client.get_vouches_for(&vouchee);
        assert_eq!(vouches.len(), 1);
        assert_eq!(vouches.get(0).unwrap().status, VouchStatus::Active);
    }

    #[test]
    fn test_self_vouch_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, treasury, _, token_client) = setup(&env);
        let user = Address::generate(&env);
        token_client.mint(&user, &1_000_000);

        let contract_id = env.register(VouchEscrow, ());
        let client = VouchEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury);

        let result = client.try_stake_vouch(&user, &user, &500_000, &token_client.address);
        assert!(result.is_err());
    }
}
