//! # PiTrust — Governance Registry Contract
//!
//! DAO-lite governance for Sentinel-tier pioneers.
//! Proposal → 7-day Voting → Quorum check → 24h timelock → Execute.
//! Governable parameters: mint fee, vouch commission, slash %, trade fee, etc.
//!
//! Prevents PiTrust team from unilaterally controlling economic parameters
//! as the protocol matures toward full decentralization.

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
    Proposal(u64),
    Param(String),          // Governable protocol parameters
    TotalProposals,
    Admin,
    Treasury,
    ProposalFee,            // 2 Pi
    VotingPeriod,           // 7 days
    ExecutionDelay,         // 24h timelock
    QuorumMinVotes,         // minimum 5 votes
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum ProposalStatus {
    Active,         // Voting open
    Passed,         // Quorum met, awaiting execution delay
    Rejected,       // Quorum not met or majority rejected
    Executed,       // Successfully applied
    Cancelled,      // Admin cancelled (emergency)
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum VoteChoice {
    For,
    Against,
    Abstain,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalVote {
    pub voter: Address,
    pub choice: VoteChoice,
    pub voted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalData {
    pub id: u64,
    pub proposer: Address,
    pub param_key: String,          // e.g. "MINT_FEE"
    pub current_value: i128,
    pub proposed_value: i128,
    pub rationale_hash: String,     // SHA256 of proposal document
    pub status: ProposalStatus,
    pub votes: Vec<ProposalVote>,   // bounded: max 110 (all sentinels + 10 extra)
    pub for_count: u32,
    pub against_count: u32,
    pub created_at: u64,
    pub voting_ends_at: u64,
    pub executable_after: u64,      // voting_ends_at + 24h timelock
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized      = 1,
    Unauthorized        = 2,
    ProposalNotFound    = 3,
    VotingClosed        = 4,
    VotingStillOpen     = 5,
    AlreadyVoted        = 6,
    ExecutionDelayActive = 7,
    QuorumNotMet        = 8,
    AlreadyExecuted     = 9,
    InvalidState        = 10,
    InsufficientFunds   = 11,
    ParamNotFound       = 12,
}

// ── Protocol Parameter Defaults ───────────────────────────────────────────────
// These are stored in governance_registry as the canonical source of truth.
// Other contracts read params via cross-call or backend relay.

pub const PARAM_MINT_FEE: &str          = "MINT_FEE";           // 1_000_000
pub const PARAM_VOUCH_COMMISSION: &str  = "VOUCH_COMMISSION_BPS"; // 200
pub const PARAM_SLASH_BURN_PCT: &str    = "SLASH_BURN_PCT";      // 80
pub const PARAM_TRADE_FEE: &str         = "TRADE_FEE_BPS";       // 100
pub const PARAM_RECOVERY_LOCK: &str     = "RECOVERY_LOCK_PI";    // 50_000_000
pub const PARAM_MIN_VOUCH: &str         = "MIN_VOUCH_STAKE";     // 100_000

const LEDGER_TTL: u32 = 535_000;
const VOTING_PERIOD: u64 = 604_800;    // 7 days
const EXECUTION_DELAY: u64 = 86_400;   // 24 hours
const PROPOSAL_FEE: i128 = 2_000_000;  // 2 Pi
const QUORUM_MIN_VOTES: u32 = 5;

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
pub struct GovernanceRegistry;

#[contractimpl]
impl GovernanceRegistry {
    /// Initialize with default protocol parameters.
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
        env.storage().instance().set(&DataKey::TotalProposals, &0u64);
        env.storage().instance().set(&DataKey::ProposalFee, &PROPOSAL_FEE);
        env.storage().instance().set(&DataKey::VotingPeriod, &VOTING_PERIOD);
        env.storage().instance().set(&DataKey::ExecutionDelay, &EXECUTION_DELAY);
        env.storage().instance().set(&DataKey::QuorumMinVotes, &QUORUM_MIN_VOTES);

        // Set default protocol parameters
        Self::set_param_internal(&env, String::from_str(&env, PARAM_MINT_FEE), 1_000_000);
        Self::set_param_internal(&env, String::from_str(&env, PARAM_VOUCH_COMMISSION), 200);
        Self::set_param_internal(&env, String::from_str(&env, PARAM_SLASH_BURN_PCT), 80);
        Self::set_param_internal(&env, String::from_str(&env, PARAM_TRADE_FEE), 100);
        Self::set_param_internal(&env, String::from_str(&env, PARAM_RECOVERY_LOCK), 50_000_000);
        Self::set_param_internal(&env, String::from_str(&env, PARAM_MIN_VOUCH), 100_000);

        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Create a governance proposal. Proposer must be Sentinel tier.
    /// Backend validates score ≥ 900 before calling. 2 Pi proposal fee.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        param_key: String,
        proposed_value: i128,
        rationale_hash: String,
        fee_token: Address,
    ) -> Result<u64, Error> {
        proposer.require_auth();
        Self::bump_instance(&env);

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;
        let fee: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalFee)
            .unwrap_or(PROPOSAL_FEE);

        let token_client = TokenClient::new(&env, &fee_token);
        if token_client.balance(&proposer) < fee {
            return Err(Error::InsufficientFunds);
        }
        token_client.transfer(&proposer, &treasury, &fee);

        // Read current param value
        let current_value = env
            .storage()
            .persistent()
            .get(&DataKey::Param(param_key.clone()))
            .unwrap_or(0i128);

        let total: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalProposals)
            .unwrap_or(0);
        let proposal_id = total + 1;

        let now = env.ledger().timestamp();
        let voting_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(VOTING_PERIOD);
        let exec_delay: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ExecutionDelay)
            .unwrap_or(EXECUTION_DELAY);

        let proposal = ProposalData {
            id: proposal_id,
            proposer,
            param_key,
            current_value,
            proposed_value,
            rationale_hash,
            status: ProposalStatus::Active,
            votes: Vec::new(&env),
            for_count: 0,
            against_count: 0,
            created_at: now,
            voting_ends_at: now + voting_period,
            executable_after: now + voting_period + exec_delay,
        };

        let key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        env.storage().instance().set(&DataKey::TotalProposals, &proposal_id);
        Ok(proposal_id)
    }

    /// Cast a vote on a proposal. Voter must be a Sentinel (backend-validated).
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        choice: VoteChoice,
    ) -> Result<(), Error> {
        voter.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Proposal(proposal_id);
        let mut proposal: ProposalData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(Error::InvalidState);
        }
        let now = env.ledger().timestamp();
        if now > proposal.voting_ends_at {
            return Err(Error::VotingClosed);
        }

        // Prevent double voting
        if proposal.votes.iter().any(|v| v.voter == voter) {
            return Err(Error::AlreadyVoted);
        }

        match choice {
            VoteChoice::For     => proposal.for_count += 1,
            VoteChoice::Against => proposal.against_count += 1,
            VoteChoice::Abstain => {}
        }

        proposal.votes.push_back(ProposalVote {
            voter,
            choice,
            voted_at: now,
        });

        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Finalize voting state after voting period ends. Anyone can call.
    pub fn finalize_vote(env: Env, proposal_id: u64) -> Result<ProposalStatus, Error> {
        Self::bump_instance(&env);

        let key = DataKey::Proposal(proposal_id);
        let mut proposal: ProposalData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() <= proposal.voting_ends_at {
            return Err(Error::VotingStillOpen);
        }

        let quorum: u32 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumMinVotes)
            .unwrap_or(QUORUM_MIN_VOTES);

        let total_decisive = proposal.for_count + proposal.against_count;
        if total_decisive < quorum {
            proposal.status = ProposalStatus::Rejected;
        } else if proposal.for_count > proposal.against_count {
            proposal.status = ProposalStatus::Passed;
        } else {
            proposal.status = ProposalStatus::Rejected;
        }

        let result = proposal.status.clone();
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(result)
    }

    /// Execute a passed proposal after the 24h timelock. Anyone can call.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), Error> {
        Self::bump_instance(&env);

        let key = DataKey::Proposal(proposal_id);
        let mut proposal: ProposalData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Passed {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() < proposal.executable_after {
            return Err(Error::ExecutionDelayActive);
        }

        // Apply the parameter change
        Self::set_param_internal(&env, proposal.param_key.clone(), proposal.proposed_value);

        proposal.status = ProposalStatus::Executed;
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Admin emergency cancel (e.g. malicious proposal detected before execution).
    pub fn cancel_proposal(env: Env, proposal_id: u64) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Proposal(proposal_id);
        let mut proposal: ProposalData = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Executed {
            return Err(Error::AlreadyExecuted);
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Read a current protocol parameter value.
    pub fn get_param(env: Env, key: String) -> Result<i128, Error> {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Param(key))
            .ok_or(Error::ParamNotFound)
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<ProposalData, Error> {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)
    }

    pub fn total_proposals(env: Env) -> u64 {
        Self::bump_instance(&env);
        env.storage().instance().get(&DataKey::TotalProposals).unwrap_or(0)
    }

    // ── Internal ───────────────────────────────────────────────────────────

    fn set_param_internal(env: &Env, key: String, value: i128) {
        env.storage().persistent().set(&DataKey::Param(key), &value);
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
    fn test_default_params_set_on_init() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let cid = env.register(GovernanceRegistry, ());
        let client = GovernanceRegistryClient::new(&env, &cid);
        client.initialize(&admin, &treasury);

        assert_eq!(client.get_param(&String::from_str(&env, PARAM_MINT_FEE)), 1_000_000);
        assert_eq!(client.get_param(&String::from_str(&env, PARAM_RECOVERY_LOCK)), 50_000_000);
        assert_eq!(client.get_param(&String::from_str(&env, PARAM_TRADE_FEE)), 100);
    }

    #[test]
    fn test_proposal_vote_and_execute() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);
        let voter3 = Address::generate(&env);
        let voter4 = Address::generate(&env);
        let voter5 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_c = {
            let a = env.register_stellar_asset_contract_v2(token_admin.clone());
            token::StellarAssetClient::new(&env, &a.address())
        };
        token_c.mint(&proposer, &5_000_000);

        let cid = env.register(GovernanceRegistry, ());
        let client = GovernanceRegistryClient::new(&env, &cid);
        client.initialize(&admin, &treasury);

        let proposal_id = client.create_proposal(
            &proposer,
            &String::from_str(&env, PARAM_MINT_FEE),
            &2_000_000, // propose new mint fee: 2 Pi
            &String::from_str(&env, "sha256:rationale"),
            &token_c.address,
        );
        assert_eq!(proposal_id, 1);

        // Cast 5 FOR votes (meets quorum)
        for voter in [&voter1, &voter2, &voter3, &voter4, &voter5] {
            client.vote(voter, &1, &VoteChoice::For);
        }

        // Advance past voting period + timelock
        env.ledger().with_mut(|l| {
            l.timestamp += VOTING_PERIOD + EXECUTION_DELAY + 1;
        });

        let status = client.finalize_vote(&1);
        assert_eq!(status, ProposalStatus::Passed);

        client.execute_proposal(&1);

        // Verify parameter was updated
        assert_eq!(client.get_param(&String::from_str(&env, PARAM_MINT_FEE)), 2_000_000);
    }
}
