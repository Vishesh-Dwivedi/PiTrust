//! # PiTrust — Social Attestation Contract
//!
//! Anchors off-chain social credential verifications on-chain as tamper-proof hashes.
//! Backend OAuth-verifies Twitter/LinkedIn/GitHub, then writes a SHA256 hash of the
//! credential to this contract via the oracle admin keypair.
//!
//! Anyone can verify a pioneer's social credentials cryptographically without
//! trusting our backend — the hash proves the verification was done at a specific time.
//!
//! Hash formula: SHA256(platform_uid || wallet_address || attestation_epoch_timestamp)

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, Bytes, Vec,
};

// ── Data Types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Attestations(Address),    // Vec<AttestationRecord>
    Admin,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum SocialPlatform {
    Twitter,
    LinkedIn,
    GitHub,
    Telegram,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct AttestationRecord {
    pub platform: SocialPlatform,
    pub credential_hash: Bytes,   // SHA256(platform_uid || wallet || timestamp)
    pub attested_at: u64,
    pub active: bool,             // revoked = false but record preserved (immutable history)
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized      = 1,
    Unauthorized        = 2,
    PlatformNotFound    = 3,
    AlreadyAttested     = 4,
}

// ── Contract ──────────────────────────────────────────────────────────────────

const LEDGER_TTL: u32 = 535_000;
const MAX_ATTESTATIONS: u32 = 20; // Bounded: 4 platforms × 5 historical entries max

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
pub struct SocialAttestation;

#[contractimpl]
impl SocialAttestation {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Write a social attestation. Oracle admin only.
    /// If the platform already has an active attestation, it is revoked first (re-verify flow).
    pub fn attest_social(
        env: Env,
        pioneer: Address,
        platform: SocialPlatform,
        credential_hash: Bytes,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Attestations(pioneer.clone());
        let mut attestations: Vec<AttestationRecord> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));

        // Revoke any existing active attestation for this platform
        for i in 0..attestations.len() {
            let mut entry = attestations.get(i).unwrap();
            if entry.platform == platform && entry.active {
                entry.active = false;
                attestations.set(i, entry);
            }
        }

        // Prune to stay within bounded limit
        while attestations.len() >= MAX_ATTESTATIONS {
            // Remove oldest inactive
            let mut removed = false;
            for i in 0..attestations.len() {
                if !attestations.get(i).unwrap().active {
                    attestations.remove(i);
                    removed = true;
                    break;
                }
            }
            if !removed { break; }
        }

        let new_attestation = AttestationRecord {
            platform,
            credential_hash,
            attested_at: env.ledger().timestamp(),
            active: true,
        };
        attestations.push_back(new_attestation);

        env.storage().persistent().set(&key, &attestations);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Revoke a social attestation (e.g. OAuth token expired or user disconnected).
    pub fn revoke_attestation(
        env: Env,
        pioneer: Address,
        platform: SocialPlatform,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        Self::bump_instance(&env);

        let key = DataKey::Attestations(pioneer.clone());
        let mut attestations: Vec<AttestationRecord> = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PlatformNotFound)?;

        let mut found = false;
        for i in 0..attestations.len() {
            let mut entry = attestations.get(i).unwrap();
            if entry.platform == platform && entry.active {
                entry.active = false;
                attestations.set(i, entry);
                found = true;
                break;
            }
        }

        if !found {
            return Err(Error::PlatformNotFound);
        }

        env.storage().persistent().set(&key, &attestations);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Get all attestations for a pioneer (active and historical).
    pub fn get_attestations(env: Env, pioneer: Address) -> Vec<AttestationRecord> {
        Self::bump_instance(&env);
        let key = DataKey::Attestations(pioneer);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Check if a specific platform is currently verified (active attestation exists).
    pub fn verify_attestation(env: Env, pioneer: Address, platform: SocialPlatform) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::Attestations(pioneer);
        if let Some(attestations) =
            env.storage().persistent().get::<DataKey, Vec<AttestationRecord>>(&key)
        {
            for entry in attestations.iter() {
                if entry.platform == platform && entry.active {
                    return true;
                }
            }
        }
        false
    }

    /// Count active verified platforms for a pioneer (used in score engine).
    pub fn count_verified_platforms(env: Env, pioneer: Address) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::Attestations(pioneer);
        if let Some(attestations) =
            env.storage().persistent().get::<DataKey, Vec<AttestationRecord>>(&key)
        {
            attestations.iter().filter(|a| a.active).count() as u32
        } else {
            0
        }
    }

    pub fn rotate_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);
        Ok(())
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Bytes, Env};

    #[test]
    fn test_attest_and_verify() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let pioneer = Address::generate(&env);
        let hash = Bytes::from_slice(&env, &[0u8; 32]);

        let cid = env.register(SocialAttestation, ());
        let client = SocialAttestationClient::new(&env, &cid);
        client.initialize(&admin);

        client.attest_social(&pioneer, &SocialPlatform::Twitter, &hash);
        assert!(client.verify_attestation(&pioneer, &SocialPlatform::Twitter));
        assert!(!client.verify_attestation(&pioneer, &SocialPlatform::LinkedIn));
        assert_eq!(client.count_verified_platforms(&pioneer), 1);
    }

    #[test]
    fn test_revoke_attestation() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let pioneer = Address::generate(&env);
        let hash = Bytes::from_slice(&env, &[1u8; 32]);

        let cid = env.register(SocialAttestation, ());
        let client = SocialAttestationClient::new(&env, &cid);
        client.initialize(&admin);

        client.attest_social(&pioneer, &SocialPlatform::LinkedIn, &hash);
        assert!(client.verify_attestation(&pioneer, &SocialPlatform::LinkedIn));

        client.revoke_attestation(&pioneer, &SocialPlatform::LinkedIn);
        assert!(!client.verify_attestation(&pioneer, &SocialPlatform::LinkedIn));

        // Historical record is preserved (active = false, not deleted)
        let records = client.get_attestations(&pioneer);
        assert_eq!(records.len(), 1);
        assert!(!records.get(0).unwrap().active);
    }
}
