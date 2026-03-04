//! # PiTrust — Dispute Registry Contract
//!
//! Manages the full lifecycle of disputes between pioneers.
//! Three-arbitrator majority vote system. On conviction: slashes vouches,
//! writes red flag to passport_sbt, distributes filing fee to victim.
//!
//! State machine: Filed → ArbitratorsAssigned → Voting → Finalized

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
    Dispute(u64),
    TotalDisputes,
    Admin,
    Treasury,
    FilingFee,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum DisputeStatus {
    Filed,
    ArbitratorsAssigned,
    Voting,
    FinalizedConvicted,
    FinalizedExonerated,
    Withdrawn,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum VoteChoice {
    Convict,
    Exonerate,
    Abstain,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ArbitratorVote {
    pub arbitrator: Address,
    pub vote: VoteChoice,
    pub voted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DisputeData {
    pub id: u64,
    pub claimant: Address,
    pub defendant: Address,
    pub evidence_hash: String,      // IPFS hash or SHA256 of evidence package
    pub status: DisputeStatus,
    pub arbitrators: Vec<Address>,  // bounded: max 5
    pub votes: Vec<ArbitratorVote>,
    pub filed_at: u64,
    pub voting_deadline: u64,       // filed_at + 72 hours
    pub filing_fee_token: Address,
    pub filing_fee_paid: i128,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized    = 1,
    Unauthorized      = 2,
    DisputeNotFound   = 3,
    InvalidState      = 4,
    AlreadyVoted      = 5,
    VotingExpired     = 6,
    VotingStillOpen   = 7,
    InsufficientFunds = 8,
    SelfDispute       = 9,
    TooManyArbitrators = 10,
}

// ── Contract ──────────────────────────────────────────────────────────────────

const LEDGER_TTL: u32 = 535_000;
const VOTING_WINDOW: u64 = 259_200; // 72 hours in seconds
const MAX_ARBITRATORS: u32 = 5;

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
pub struct DisputeRegistry;

#[contractimpl]
impl DisputeRegistry {
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        filing_fee: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FilingFee, &filing_fee);
        env.storage().instance().set(&DataKey::TotalDisputes, &0u64);
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// File a dispute. Claimant pays non-refundable 0.5 Pi filing fee.
    pub fn file_dispute(
        env: Env,
        claimant: Address,
        defendant: Address,
        evidence_hash: String,
        fee_token: Address,
    ) -> Result<u64, Error> {
        claimant.require_auth();
        Self::bump_instance(&env);

        if claimant == defendant {
            return Err(Error::SelfDispute);
        }

        let filing_fee: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FilingFee)
            .ok_or(Error::NotInitialized)?;
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;

        let token = TokenClient::new(&env, &fee_token);
        if token.balance(&claimant) < filing_fee {
            return Err(Error::InsufficientFunds);
        }
        // Filing fee goes to treasury (non-refundable; returned on win by backend)
        token.transfer(&claimant, &treasury, &filing_fee);

        let total: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDisputes)
            .unwrap_or(0);
        let dispute_id = total + 1;

        let now = env.ledger().timestamp();
        let dispute = DisputeData {
            id: dispute_id,
            claimant,
            defendant,
            evidence_hash,
            status: DisputeStatus::Filed,
            arbitrators: Vec::new(&env),
            votes: Vec::new(&env),
            filed_at: now,
            voting_deadline: now + VOTING_WINDOW,
            filing_fee_token: fee_token,
            filing_fee_paid: filing_fee,
        };

        let key = DataKey::Dispute(dispute_id);
        env.storage().persistent().set(&key, &dispute);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        env.storage().instance().set(&DataKey::TotalDisputes, &dispute_id);
        Ok(dispute_id)
    }

    /// Assign arbitrators to a dispute. Admin only (selected from sentinel pool).
    pub fn assign_arbitrators(
        env: Env,
        dispute_id: u64,
        arbitrators: Vec<Address>,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        if arbitrators.len() > MAX_ARBITRATORS {
            return Err(Error::TooManyArbitrators);
        }

        let key = DataKey::Dispute(dispute_id);
        let mut dispute: DisputeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::DisputeNotFound)?;

        if dispute.status != DisputeStatus::Filed {
            return Err(Error::InvalidState);
        }

        dispute.arbitrators = arbitrators;
        dispute.status = DisputeStatus::Voting;
        env.storage().persistent().set(&key, &dispute);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Arbitrator casts a vote. Must be within 72-hour window.
    pub fn cast_vote(
        env: Env,
        arbitrator: Address,
        dispute_id: u64,
        vote: VoteChoice,
    ) -> Result<(), Error> {
        arbitrator.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Dispute(dispute_id);
        let mut dispute: DisputeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::DisputeNotFound)?;

        if dispute.status != DisputeStatus::Voting {
            return Err(Error::InvalidState);
        }

        let now = env.ledger().timestamp();
        if now > dispute.voting_deadline {
            return Err(Error::VotingExpired);
        }

        // Verify arbitrator is assigned
        let is_assigned = dispute
            .arbitrators
            .iter()
            .any(|a| a == arbitrator);
        if !is_assigned {
            return Err(Error::Unauthorized);
        }

        // Prevent double voting
        let already_voted = dispute
            .votes
            .iter()
            .any(|v| v.arbitrator == arbitrator);
        if already_voted {
            return Err(Error::AlreadyVoted);
        }

        dispute.votes.push_back(ArbitratorVote {
            arbitrator,
            vote,
            voted_at: now,
        });

        env.storage().persistent().set(&key, &dispute);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Finalize a dispute after voting deadline. Anyone can call.
    pub fn finalize_dispute(env: Env, dispute_id: u64) -> Result<DisputeStatus, Error> {
        Self::bump_instance(&env);

        let key = DataKey::Dispute(dispute_id);
        let mut dispute: DisputeData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::DisputeNotFound)?;

        if dispute.status != DisputeStatus::Voting {
            return Err(Error::InvalidState);
        }

        let now = env.ledger().timestamp();
        if now <= dispute.voting_deadline {
            return Err(Error::VotingStillOpen);
        }

        // Tally votes
        let mut convict_count: u32 = 0;
        let mut exonerate_count: u32 = 0;

        for v in dispute.votes.iter() {
            match v.vote {
                VoteChoice::Convict    => convict_count += 1,
                VoteChoice::Exonerate  => exonerate_count += 1,
                VoteChoice::Abstain    => {}
            }
        }

        // Majority vote determines outcome (ties → exonerated)
        let outcome = if convict_count > exonerate_count {
            DisputeStatus::FinalizedConvicted
        } else {
            DisputeStatus::FinalizedExonerated
        };

        dispute.status = outcome.clone();
        env.storage().persistent().set(&key, &dispute);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        // NOTE: Backend handles cross-contract calls to vouch_escrow::slash and
        // passport_sbt::add_red_flag after reading this finalized status.
        // This avoids cross-contract re-entrancy risks in the conviction path.

        Ok(outcome)
    }

    /// Read a dispute by ID.
    pub fn get_dispute(env: Env, dispute_id: u64) -> Result<DisputeData, Error> {
        Self::bump_instance(&env);
        let key = DataKey::Dispute(dispute_id);
        let dispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::DisputeNotFound)?;
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(dispute)
    }

    pub fn total_disputes(env: Env) -> u64 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::TotalDisputes)
            .unwrap_or(0)
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token, Address, Env, vec, String};

    #[test]
    fn test_file_dispute_and_finalize_exonerated() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let claimant = Address::generate(&env);
        let defendant = Address::generate(&env);
        let arb1 = Address::generate(&env);
        let arb2 = Address::generate(&env);
        let arb3 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_c = {
            let a = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(&env, &a.address())
        };
        token_c.mint(&claimant, &1_000_000);

        let cid = env.register(DisputeRegistry, ());
        let client = DisputeRegistryClient::new(&env, &cid);
        client.initialize(&admin, &treasury, &500_000);

        let dispute_id = client.file_dispute(
            &claimant, &defendant,
            &String::from_str(&env, "sha256:abc123"),
            &token_c.address,
        );
        assert_eq!(dispute_id, 1);
        assert_eq!(client.total_disputes(), 1);

        let arbs = vec![&env, arb1.clone(), arb2.clone(), arb3.clone()];
        client.assign_arbitrators(&1, &arbs);

        let dispute = client.get_dispute(&1);
        assert_eq!(dispute.status, DisputeStatus::Voting);

        // Advance past 72h voting deadline using set_timestamp
        env.ledger().set_timestamp(dispute.voting_deadline + 1);

        // 0 votes -> tied -> exonerated
        let outcome = client.finalize_dispute(&1);
        assert_eq!(outcome, DisputeStatus::FinalizedExonerated);
    }

    #[test]
    fn test_conviction_with_majority_votes() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let claimant = Address::generate(&env);
        let defendant = Address::generate(&env);
        let arb1 = Address::generate(&env);
        let arb2 = Address::generate(&env);
        let arb3 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_c = {
            let a = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(&env, &a.address())
        };
        token_c.mint(&claimant, &1_000_000);

        let cid = env.register(DisputeRegistry, ());
        let client = DisputeRegistryClient::new(&env, &cid);
        client.initialize(&admin, &treasury, &500_000);

        client.file_dispute(
            &claimant, &defendant,
            &String::from_str(&env, "sha256:evidence"),
            &token_c.address,
        );

        let arbs = vec![&env, arb1.clone(), arb2.clone(), arb3.clone()];
        client.assign_arbitrators(&1, &arbs);

        // 3 CONVICT votes
        client.cast_vote(&arb1, &1, &VoteChoice::Convict);
        client.cast_vote(&arb2, &1, &VoteChoice::Convict);
        client.cast_vote(&arb3, &1, &VoteChoice::Convict);

        let dispute = client.get_dispute(&1);
        env.ledger().set_timestamp(dispute.voting_deadline + 1);

        let outcome = client.finalize_dispute(&1);
        assert_eq!(outcome, DisputeStatus::FinalizedConvicted);
    }

    #[test]
    fn test_self_dispute_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_c = {
            let a = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(&env, &a.address())
        };
        token_c.mint(&user, &1_000_000);

        let cid = env.register(DisputeRegistry, ());
        let client = DisputeRegistryClient::new(&env, &cid);
        client.initialize(&admin, &treasury, &500_000);

        let result = client.try_file_dispute(
            &user, &user,
            &String::from_str(&env, "sha256:x"),
            &token_c.address,
        );
        assert!(result.is_err());
    }
}
