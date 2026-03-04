-- PiTrust PostgreSQL Schema
-- Run once: psql -U pitrust -d pitrust_testnet -f schema.sql

-- ── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Passports ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passports (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address    VARCHAR(64) UNIQUE NOT NULL,
    pi_uid            VARCHAR(64) UNIQUE NOT NULL,
    minted_at         TIMESTAMPTZ DEFAULT NOW(),
    contract_id       VARCHAR(100),         -- on-chain SBT contract address
    score             INTEGER     DEFAULT 50 CHECK (score >= 0 AND score <= 1000),
    tier              VARCHAR(20) DEFAULT 'bronze',
    score_frozen      BOOLEAN     DEFAULT FALSE,
    completed_trades  INTEGER     DEFAULT 0,
    disputed_trades   INTEGER     DEFAULT 0,
    last_score_update TIMESTAMPTZ DEFAULT NOW(),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_passports_wallet ON passports(wallet_address);
CREATE INDEX IF NOT EXISTS idx_passports_score ON passports(score DESC);
CREATE INDEX IF NOT EXISTS idx_passports_tier ON passports(tier);

-- ── Red Flags ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS red_flags (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(64) NOT NULL REFERENCES passports(wallet_address),
    flag_type      VARCHAR(50) NOT NULL,  -- ScamConviction, GhostTrade, VouchCollusion
    score_impact   INTEGER     NOT NULL,
    dispute_id     UUID,                  -- references disputes.id if from dispute
    rebuttal       TEXT,                  -- pioneer's written rebuttal
    issued_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_red_flags_wallet ON red_flags(wallet_address);

-- ── Vouch Events ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vouch_events (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    vouch_id        BIGINT      UNIQUE,          -- on-chain vouch ID
    voucher_wallet  VARCHAR(64) NOT NULL,
    vouchee_wallet  VARCHAR(64) NOT NULL,
    amount_pi       DECIMAL(18,7) NOT NULL,
    net_amount_pi   DECIMAL(18,7) NOT NULL,      -- after 2% commission
    tx_hash         VARCHAR(100),
    token_address   VARCHAR(64),
    staked_at       TIMESTAMPTZ DEFAULT NOW(),
    status          VARCHAR(20) DEFAULT 'active', -- active, withdrawn, slashed
    slash_tx_hash   VARCHAR(100),
    CONSTRAINT no_self_vouch CHECK (voucher_wallet != vouchee_wallet)
);

CREATE INDEX IF NOT EXISTS idx_vouch_vouchee ON vouch_events(vouchee_wallet);
CREATE INDEX IF NOT EXISTS idx_vouch_voucher ON vouch_events(voucher_wallet);
CREATE INDEX IF NOT EXISTS idx_vouch_status ON vouch_events(status);

-- ── Disputes ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id       BIGINT      UNIQUE,          -- on-chain dispute ID
    claimant_wallet  VARCHAR(64) NOT NULL,
    defendant_wallet VARCHAR(64) NOT NULL,
    evidence_hash    VARCHAR(100) NOT NULL,       -- IPFS or SHA256
    status           VARCHAR(30) DEFAULT 'filed', -- filed, voting, convicted, exonerated
    filing_fee_pi    DECIMAL(18,7),
    filing_fee_tx    VARCHAR(100),
    trade_id         UUID,                        -- linked trade if from trade_escrow
    filed_at         TIMESTAMPTZ DEFAULT NOW(),
    voting_deadline  TIMESTAMPTZ,
    finalized_at     TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_defendant ON disputes(defendant_wallet);
CREATE INDEX IF NOT EXISTS idx_disputes_claimant ON disputes(claimant_wallet);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- ── Arbitrator Votes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dispute_votes (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id    UUID        NOT NULL REFERENCES disputes(id),
    arbitrator    VARCHAR(64) NOT NULL,
    vote_choice   VARCHAR(20) NOT NULL,           -- Convict, Exonerate, Abstain
    voted_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (dispute_id, arbitrator)
);

-- ── Merchants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merchants (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address    VARCHAR(64) UNIQUE NOT NULL REFERENCES passports(wallet_address),
    metadata_hash     VARCHAR(100) NOT NULL,      -- SHA256 of merchant metadata
    -- Off-chain metadata fields (denormalized for query performance)
    display_name      VARCHAR(100),
    category          VARCHAR(50),
    description       TEXT,
    location          VARCHAR(100),
    status            VARCHAR(20) DEFAULT 'active', -- active, suspended, revoked
    suspension_count  INTEGER DEFAULT 0,
    registration_fee_tx VARCHAR(100),
    registered_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants(status);
CREATE INDEX IF NOT EXISTS idx_merchants_category ON merchants(category);

-- ── Trades ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id            BIGINT      UNIQUE,        -- on-chain trade ID
    buyer_wallet        VARCHAR(64) NOT NULL,
    seller_wallet       VARCHAR(64) NOT NULL,
    amount_pi           DECIMAL(18,7) NOT NULL,
    platform_fee_pi     DECIMAL(18,7),
    token_address       VARCHAR(64),
    description_hash    VARCHAR(100),
    min_seller_score    INTEGER DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'created',
    dispute_id          UUID REFERENCES disputes(id),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    seller_accepted_at  TIMESTAMPTZ,
    delivery_marked_at  TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_buyer ON trades(buyer_wallet);
CREATE INDEX IF NOT EXISTS idx_trades_seller ON trades(seller_wallet);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- ── Social Attestations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS social_attestations (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(64) NOT NULL REFERENCES passports(wallet_address),
    platform       VARCHAR(20) NOT NULL,   -- Twitter, LinkedIn, GitHub, Telegram
    platform_uid   VARCHAR(100) NOT NULL,
    credential_hash VARCHAR(100) NOT NULL, -- SHA256 of (uid + wallet + timestamp)
    active         BOOLEAN DEFAULT TRUE,
    attested_at    TIMESTAMPTZ DEFAULT NOW(),
    revoked_at     TIMESTAMPTZ,
    UNIQUE (wallet_address, platform, active)
);

CREATE INDEX IF NOT EXISTS idx_social_wallet ON social_attestations(wallet_address);

-- ── API Keys (B2B) ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_uid     VARCHAR(64) NOT NULL,
    developer_wallet  VARCHAR(64),
    api_key           VARCHAR(80) UNIQUE NOT NULL,
    key_hash          VARCHAR(100) NOT NULL,          -- bcrypt hash — never store raw
    tier              VARCHAR(20) DEFAULT 'starter',  -- starter, growth, scale, enterprise
    monthly_limit     INTEGER DEFAULT 10000,
    calls_this_month  INTEGER DEFAULT 0,
    total_calls       BIGINT DEFAULT 0,
    pi_balance        DECIMAL(18,7) DEFAULT 0,        -- prepaid Pi credits
    active            BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    last_used_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_dev ON api_keys(developer_uid);

-- ── Governance Proposals (off-chain mirror) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_proposals (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id       BIGINT      UNIQUE,
    proposer_wallet   VARCHAR(64) NOT NULL,
    param_key         VARCHAR(50) NOT NULL,
    current_value     BIGINT,
    proposed_value    BIGINT NOT NULL,
    rationale_hash    VARCHAR(100),
    rationale_text    TEXT,                           -- off-chain full text
    status            VARCHAR(20) DEFAULT 'active',
    for_count         INTEGER DEFAULT 0,
    against_count     INTEGER DEFAULT 0,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    voting_ends_at    TIMESTAMPTZ,
    executed_at       TIMESTAMPTZ
);

-- ── Sentinels ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinels (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address      VARCHAR(64) UNIQUE NOT NULL REFERENCES passports(wallet_address),
    bond_amount_pi      DECIMAL(18,7) DEFAULT 50,
    status              VARCHAR(20) DEFAULT 'active', -- active, withdrawn, slashed
    disputes_arbitrated INTEGER DEFAULT 0,
    total_earned_pi     DECIMAL(18,7) DEFAULT 0,
    joined_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Misc: Wallet Cache (chain indexer writes) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_cache (
    wallet_address      VARCHAR(64) PRIMARY KEY,
    genesis_timestamp   BIGINT,                        -- account creation (Unix)
    pi_balance          DECIMAL(18,7),
    lifetime_volume     DECIMAL(18,7),
    tx_count            INTEGER,
    weekly_active_months INTEGER DEFAULT 0,
    last_indexed_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Updated at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER passports_updated_at BEFORE UPDATE ON passports
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER merchants_updated_at BEFORE UPDATE ON merchants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trades_updated_at BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER sentinels_updated_at BEFORE UPDATE ON sentinels
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
