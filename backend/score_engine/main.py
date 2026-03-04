"""
PiTrust Score Engine — FastAPI
Calculates PiScore for each pioneer every 4 hours.

Score = (On-chain Activity 35%) + (Vouch Network 40%) + (Off-chain Social 25%)

On-chain (35 pts cap):
  - Wallet age: 0–10 pts (1pt per 6 months, max 10)
  - Transaction volume: 0–10 pts (logarithmic scale)
  - Trade completion rate: 0–10 pts (completed/total trades)
  - Account balance stability: 0–5 pts

Vouch Network (40 pts cap):
  - Total active stake: 0–20 pts (logarithmic, max 50 Pi staked by others)
  - Number of unique vouchers: 0–10 pts (capped at 20 vouchers)
  - Vouch chain depth: 0–10 pts (vouched by high-score pioneers)

Off-chain Social (25 pts cap):
  - Verified platforms: 0–16 pts (4 per platform, max 4 platforms)
  - Platform age/follower quality: 0–9 pts (oracle computed)

Final score scaled to 0–1000.
"""

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
import asyncpg
import httpx
import os
import asyncio
import math
import logging
from datetime import datetime, timedelta
from typing import Optional
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pitrust-score-engine")

app = FastAPI(title="PiTrust Score Engine", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001"],
    allow_methods=["GET", "POST"],
)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://pitrust:pitrust_dev@localhost:5432/pitrust_testnet")
HORIZON_URL = os.getenv("STELLAR_TESTNET_HORIZON", "https://horizon-testnet.stellar.org")
INTERNAL_SECRET = os.getenv("SCORE_ENGINE_SECRET", "pitrust-internal-secret")

# ── Stellar Horizon client ────────────────────────────────────────────────────

async def fetch_account_data(wallet: str) -> dict:
    """Fetch wallet data from Stellar Horizon."""
    async with httpx.AsyncClient(timeout=10) as client:
        # Account info
        try:
            acc_resp = await client.get(f"{HORIZON_URL}/accounts/{wallet}")
            acc_data = acc_resp.json() if acc_resp.status_code == 200 else {}
        except Exception:
            acc_data = {}

        # Transaction count
        try:
            tx_resp = await client.get(
                f"{HORIZON_URL}/accounts/{wallet}/transactions",
                params={"limit": 200, "order": "asc"}
            )
            tx_data = tx_resp.json() if tx_resp.status_code == 200 else {}
        except Exception:
            tx_data = {}

        return {
            "account": acc_data,
            "transactions": tx_data.get("_embedded", {}).get("records", []),
        }


# ── Scoring Components ────────────────────────────────────────────────────────

def score_wallet_age(created_at_epoch: Optional[int]) -> float:
    """0–10 pts based on wallet age. 1 pt per 6 months, max 10."""
    if not created_at_epoch:
        return 0.0
    now = datetime.utcnow().timestamp()
    age_months = (now - created_at_epoch) / (60 * 60 * 24 * 30)
    return min(10.0, age_months / 6)


def score_tx_volume(tx_count: int) -> float:
    """0–10 pts, log scale. 100+ txns = 10 pts."""
    if tx_count <= 0:
        return 0.0
    return min(10.0, math.log10(tx_count + 1) * 10 / 2)


def score_trade_completion(completed: int, disputed: int) -> float:
    """0–10 pts. Based on trade completion rate."""
    total = completed + disputed
    if total == 0:
        return 5.0  # No history — neutral
    completion_rate = completed / total
    return round(completion_rate * 10, 2)


def score_vouch_stake(total_stake_pi: float) -> float:
    """0–20 pts for total Pi staked by vouchers. Log scale, max at 50 Pi."""
    if total_stake_pi <= 0:
        return 0.0
    return min(20.0, math.log(total_stake_pi + 1) / math.log(51) * 20)


def score_vouch_count(unique_vouchers: int) -> float:
    """0–10 pts. 1 pt per voucher, max 10 vouchers count."""
    return min(10.0, float(unique_vouchers))


def score_vouch_quality(avg_voucher_score: float) -> float:
    """0–10 pts based on average PiScore of vouchers."""
    return min(10.0, (avg_voucher_score / 1000) * 10)


def score_social_platforms(platform_count: int) -> float:
    """0–16 pts. 4 pts per verified platform, max 4 platforms."""
    return min(16.0, platform_count * 4.0)


# ── Main Score Calculator ─────────────────────────────────────────────────────

async def calculate_score(wallet: str, db_pool: asyncpg.Pool) -> int:
    """Full score calculation for a wallet. Returns 0–1000."""

    # Fetch from DB
    row = await db_pool.fetchrow(
        """SELECT p.wallet_address, p.completed_trades, p.disputed_trades,
                  w.genesis_timestamp, w.pi_balance, w.lifetime_volume, w.tx_count,
                  w.weekly_active_months,
                  (SELECT COUNT(*) FROM vouch_events WHERE vouchee_wallet = p.wallet_address AND status = 'active') as vouch_count,
                  (SELECT COALESCE(SUM(net_amount_pi), 0) FROM vouch_events WHERE vouchee_wallet = p.wallet_address AND status = 'active') as vouch_stake,
                  (SELECT COUNT(*) FROM social_attestations WHERE wallet_address = p.wallet_address AND active = TRUE) as social_count
           FROM passports p
           LEFT JOIN wallet_cache w ON w.wallet_address = p.wallet_address
           WHERE p.wallet_address = $1""",
        wallet
    )

    if not row:
        return 0

    # ── On-chain component (35 pts) ───────────────────────────────────────────
    wallet_age_pts = score_wallet_age(row["genesis_timestamp"])
    tx_vol_pts = score_tx_volume(row["tx_count"] or 0)
    trade_pts = score_trade_completion(
        row["completed_trades"] or 0,
        row["disputed_trades"] or 0
    )
    balance_pts = min(5.0, float(row["pi_balance"] or 0) / 100)  # 1pt per 20 Pi, max 5

    onchain_raw = wallet_age_pts + tx_vol_pts + trade_pts + balance_pts
    onchain_score = min(35.0, onchain_raw)

    # ── Vouch Network component (40 pts) ──────────────────────────────────────
    vouch_stake_pts = score_vouch_stake(float(row["vouch_stake"] or 0))
    vouch_count_pts = score_vouch_count(int(row["vouch_count"] or 0))
    # Vouch quality: average score of vouchers (simplified — use median of voucher scores later)
    vouch_quality_pts = 5.0  # Placeholder: score engine v2 uses actual voucher scores

    vouch_score = min(40.0, vouch_stake_pts + vouch_count_pts + vouch_quality_pts)

    # ── Social attestation component (25 pts) ─────────────────────────────────
    social_pts = score_social_platforms(int(row["social_count"] or 0))
    social_age_pts = min(9.0, 3.0)  # Simplified: full implementation uses OAuth profile age

    social_score = min(25.0, social_pts + social_age_pts)

    # ── Final score ───────────────────────────────────────────────────────────
    raw_total = onchain_score + vouch_score + social_score  # Max: 100
    final_score = round(raw_total * 10)  # Scale to 0–1000
    return min(1000, max(0, final_score))


# ── API Endpoints ─────────────────────────────────────────────────────────────

db_pool: Optional[asyncpg.Pool] = None

@app.on_event("startup")
async def startup():
    global db_pool
    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=5, max_size=20)
    logger.info("Score engine DB pool created")


@app.on_event("shutdown")
async def shutdown():
    if db_pool:
        await db_pool.close()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "pitrust-score-engine"}


@app.get("/score/{wallet}")
async def get_wallet_score(wallet: str):
    """Calculate and return score for a specific wallet (on-demand)."""
    if not db_pool:
        raise HTTPException(503, "DB not ready")
    score = await calculate_score(wallet, db_pool)
    return {"wallet": wallet, "score": score}


class BatchRequest(BaseModel):
    wallets: list[str]


@app.post("/score/batch")
async def batch_score(req: BatchRequest):
    """Calculate scores for up to 50 wallets in parallel."""
    if not db_pool:
        raise HTTPException(503, "DB not ready")
    if len(req.wallets) > 50:
        raise HTTPException(400, "Max 50 wallets per batch")

    tasks = [calculate_score(w, db_pool) for w in req.wallets]
    scores = await asyncio.gather(*tasks, return_exceptions=True)

    results = []
    for wallet, score in zip(req.wallets, scores):
        results.append({
            "wallet": wallet,
            "score": score if isinstance(score, int) else 0,
            "error": str(score) if isinstance(score, Exception) else None,
        })
    return {"results": results}


@app.post("/cron/refresh-all")
async def refresh_all_scores(x_internal_secret: str = Header(...)):
    """
    Cron endpoint: refresh scores for all passports every 4 hours.
    Protected by internal secret header.
    """
    if x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(403, "Forbidden")
    if not db_pool:
        raise HTTPException(503, "DB not ready")

    wallets = await db_pool.fetch("SELECT wallet_address FROM passports WHERE score_frozen = FALSE")
    logger.info(f"Refreshing scores for {len(wallets)} wallets")

    updated = 0
    errors = 0
    for row in wallets:
        try:
            wallet = row["wallet_address"]
            score = await calculate_score(wallet, db_pool)
            tier = score_to_tier(score)
            await db_pool.execute(
                """UPDATE passports SET score = $1, tier = $2, last_score_update = NOW()
                   WHERE wallet_address = $3""",
                score, tier, wallet
            )
            updated += 1
        except Exception as e:
            logger.error(f"Score update failed for {row['wallet_address']}: {e}")
            errors += 1

    logger.info(f"Score refresh complete. Updated: {updated}, Errors: {errors}")
    return {"updated": updated, "errors": errors}


def score_to_tier(score: int) -> str:
    if score < 100:
        return "unverified"
    elif score < 300:
        return "bronze"
    elif score < 500:
        return "silver"
    elif score < 700:
        return "gold"
    elif score < 900:
        return "platinum"
    else:
        return "sentinel"


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("SCORE_ENGINE_PORT", "8001")))
