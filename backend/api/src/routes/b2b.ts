import { Router, Request, Response } from 'express';
import { b2bApiKeyMiddleware } from '../middleware/auth';
import { queryOne, query } from '../db/client';

/**
 * B2B API — versioned under /v1/
 * Allows third-party Pi apps to query trust scores and verify merchants.
 * Requires X-API-Key header. Rate-limited by tier.
 */
export const b2bRouter = Router();

b2bRouter.use(b2bApiKeyMiddleware);

// ── GET /v1/trust-score/:wallet ───────────────────────────────────────────────
b2bRouter.get('/trust-score/:wallet', async (req: Request, res: Response) => {
    const { wallet } = req.params;

    try {
        const passport = await queryOne<{
            wallet_address: string;
            score: number;
            tier: string;
            score_frozen: boolean;
            completed_trades: number;
            disputed_trades: number;
            last_score_update: string;
        }>(
            `SELECT wallet_address, score, tier, score_frozen,
              completed_trades, disputed_trades, last_score_update
       FROM passports WHERE wallet_address = $1`,
            [wallet]
        );

        if (!passport) {
            res.status(404).json({ error: 'No passport found for this wallet', score: 0, tier: 'unverified' });
            return;
        }

        const redFlagCount = await queryOne<{ count: string }>(
            `SELECT COUNT(*) as count FROM red_flags WHERE wallet_address = $1`,
            [wallet]
        );

        const socialCount = await queryOne<{ count: string }>(
            `SELECT COUNT(*) as count FROM social_attestations
       WHERE wallet_address = $1 AND active = TRUE`,
            [wallet]
        );

        res.json({
            wallet_address: passport.wallet_address,
            score: passport.score,
            tier: passport.tier,
            score_frozen: passport.score_frozen,
            red_flag_count: parseInt(redFlagCount?.count ?? '0'),
            verified_social_platforms: parseInt(socialCount?.count ?? '0'),
            completed_trades: passport.completed_trades,
            disputed_trades: passport.disputed_trades,
            last_updated: passport.last_score_update,
            data_freshness_hours: 4,
        });
    } catch (err) {
        console.error('[B2B] trust-score error:', err);
        res.status(500).json({ error: 'Query failed' });
    }
});

// ── GET /v1/verify-merchant/:wallet ──────────────────────────────────────────
b2bRouter.get('/verify-merchant/:wallet', async (req: Request, res: Response) => {
    const { wallet } = req.params;

    try {
        const merchant = await queryOne<{
            display_name: string;
            category: string;
            status: string;
            completed_trades: number;
            registered_at: string;
        }>(
            `SELECT m.display_name, m.category, m.status,   
              t.completed_count, m.registered_at
       FROM merchants m
       LEFT JOIN (
         SELECT seller_wallet, COUNT(*) as completed_count
         FROM trades WHERE status = 'completed' GROUP BY seller_wallet
       ) t ON t.seller_wallet = m.wallet_address
       WHERE m.wallet_address = $1`,
            [wallet]
        );

        if (!merchant) {
            res.json({ verified: false, merchant: null });
            return;
        }

        res.json({
            verified: merchant.status === 'active',
            merchant: {
                display_name: merchant.display_name,
                category: merchant.category,
                status: merchant.status,
                registered_at: merchant.registered_at,
                completed_trades: merchant.completed_trades ?? 0,
                badge: merchant.status === 'active' ? 'pitrust_verified' : null,
            },
        });
    } catch (err) {
        console.error('[B2B] verify-merchant error:', err);
        res.status(500).json({ error: 'Query failed' });
    }
});

// ── GET /v1/batch-scores ──────────────────────────────────────────────────────
// Batch score lookup for up to 20 wallets at once
b2bRouter.post('/batch-scores', async (req: Request, res: Response) => {
    const { wallets } = req.body;

    if (!Array.isArray(wallets) || wallets.length === 0 || wallets.length > 20) {
        res.status(400).json({ error: 'Provide 1-20 wallet addresses in the "wallets" array' });
        return;
    }

    try {
        const placeholders = wallets.map((_: string, i: number) => `$${i + 1}`).join(',');
        const results = await query<{
            wallet_address: string;
            score: number;
            tier: string;
            score_frozen: boolean;
        }>(
            `SELECT wallet_address, score, tier, score_frozen 
       FROM passports WHERE wallet_address IN (${placeholders})`,
            wallets
        );

        // Ensure all requested wallets are present in response (with defaults for missing)
        const scoreMap = new Map(results.map((r) => [r.wallet_address, r]));
        const response = wallets.map((w: string) => {
            const r = scoreMap.get(w);
            return r ?? { wallet_address: w, score: 0, tier: 'unverified', score_frozen: false };
        });

        res.json({ scores: response });
    } catch (err) {
        console.error('[B2B] batch-scores error:', err);
        res.status(500).json({ error: 'Batch query failed' });
    }
});

// Placeholder routers for other route files
export const authRouter = Router();
authRouter.post('/callback', (_req, res) => res.json({ status: 'ok' }));

export const vouchRouter = Router();
vouchRouter.get('/', (_req, res) => res.json({ vouches: [] }));

export const disputeRouter = Router();
disputeRouter.get('/', (_req, res) => res.json({ disputes: [] }));

export const scoreRouter = Router();
scoreRouter.get('/:wallet', async (req, res) => {
    const passport = await queryOne<{ score: number; tier: string }>(
        'SELECT score, tier FROM passports WHERE wallet_address = $1',
        [req.params.wallet]
    );
    res.json(passport ?? { score: 0, tier: 'unverified' });
});

export const merchantRouter = Router();
merchantRouter.get('/', (_req, res) => res.json({ merchants: [] }));

export const tradeRouter = Router();
tradeRouter.get('/', (_req, res) => res.json({ trades: [] }));
