/**
 * Vercel Serverless Function — PiTrust API Gateway
 * 
 * This single function handles ALL /api/* routes by wrapping the
 * existing Express app. Vercel routes /api/[...path] to this file.
 * 
 * Architecture:
 *   Vercel Frontend (SPA) ─── /api/* ──→ This serverless function
 *                                         └── Express app (same routes as backend/api/src)
 *                                              └── Supabase PostgreSQL
 *                                              └── Pi API (https://api.minepi.com)
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { Pool } from 'pg';
import axios from 'axios';
import { z } from 'zod';

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5, // Serverless: keep pool small
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false },
});

async function query<T extends object>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await pool.query<T>(text, params);
    return result.rows;
}

async function queryOne<T extends object>(text: string, params?: unknown[]): Promise<T | null> {
    const result = await pool.query<T>(text, params);
    return result.rows[0] ?? null;
}

// ── Pi API helpers ────────────────────────────────────────────────────────────
const PI_API_BASE = process.env.PI_API_BASE || 'https://api.minepi.com';
const PI_API_KEY = process.env.PI_API_KEY || '';

const piHeaders = () => ({
    Authorization: `Key ${PI_API_KEY}`,
    'Content-Type': 'application/json',
});

async function approvePayment(paymentId: string) {
    const response = await axios.post(
        `${PI_API_BASE}/v2/payments/${paymentId}/approve`,
        {},
        { headers: piHeaders(), timeout: 10_000 }
    );
    return response.data;
}

async function completePayment(paymentId: string, txId: string) {
    const response = await axios.post(
        `${PI_API_BASE}/v2/payments/${paymentId}/complete`,
        { txid: txId },
        { headers: piHeaders(), timeout: 10_000 }
    );
    return response.data;
}

async function getPayment(paymentId: string) {
    const response = await axios.get(
        `${PI_API_BASE}/v2/payments/${paymentId}`,
        { headers: piHeaders(), timeout: 5_000 }
    );
    return response.data;
}

// ── Pi Auth Middleware ─────────────────────────────────────────────────────────
interface PiUser {
    uid: string;
    username: string;
    wallet_address?: string;
}

declare global {
    namespace Express {
        interface Request {
            piUser?: PiUser;
        }
    }
}

async function piAuthMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing Pi token' });
        return;
    }

    const token = authHeader.substring(7);
    try {
        const response = await axios.get<PiUser>(`${PI_API_BASE}/v2/me`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
        });
        const piUser = response.data;
        if (!piUser.uid) {
            res.status(401).json({ error: 'Invalid Pi token: no uid' });
            return;
        }
        req.piUser = piUser;
        next();
    } catch (err: unknown) {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
            res.status(401).json({ error: 'Pi token expired or invalid' });
            return;
        }
        console.error('Pi auth error:', err);
        res.status(502).json({ error: 'Pi auth service unavailable' });
    }
}

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
    origin: [
        'https://sandbox.minepi.com',
        'https://trustpi.space',
        'https://www.trustpi.space',
        'http://localhost:3001',
        'http://localhost:3000',
    ],
    credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
});
app.use(globalLimiter);

const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Rate limit exceeded' },
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: 'error', message: 'DB unavailable' });
    }
});

// ── Auth Routes ───────────────────────────────────────────────────────────────
const SignInSchema = z.object({ accessToken: z.string().min(10) });

app.post('/api/auth/pi-signin', async (req, res) => {
    const parse = SignInSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json({ error: parse.error.flatten() });
        return;
    }
    try {
        const response = await axios.get(`${PI_API_BASE}/v2/me`, {
            headers: { Authorization: `Bearer ${parse.data.accessToken}` },
            timeout: 5000,
        });
        const piUser = response.data;
        const passport = await queryOne<{ score: number; tier: string; wallet_address: string }>(
            'SELECT score, tier, wallet_address FROM passports WHERE pi_uid = $1',
            [piUser.uid]
        );
        res.json({
            pi_uid: piUser.uid,
            username: piUser.username,
            has_passport: !!passport,
            passport: passport ?? null,
        });
    } catch {
        res.status(401).json({ error: 'Invalid Pi token' });
    }
});

// ── Passport Routes ───────────────────────────────────────────────────────────

// GET /api/passport/:walletOrUid — look up passport by wallet address OR pi_uid
app.get('/api/passport/:walletOrUid', async (req, res) => {
    const identifier = req.params.walletOrUid;
    if (!identifier || identifier.length < 3) {
        res.status(400).json({ error: 'Invalid identifier' });
        return;
    }

    try {
        // Try wallet address first, then pi_uid
        let passport = await queryOne<{
            wallet_address: string;
            pi_uid: string;
            score: number;
            tier: string;
            score_frozen: boolean;
            completed_trades: number;
            disputed_trades: number;
            minted_at: string;
            last_score_update: string;
        }>(
            `SELECT wallet_address, pi_uid, score, tier, score_frozen,
              completed_trades, disputed_trades, minted_at, last_score_update
         FROM passports WHERE wallet_address = $1 OR pi_uid = $1
         LIMIT 1`,
            [identifier]
        );

        if (!passport) {
            res.status(404).json({ error: 'Passport not found' });
            return;
        }

        const red_flags = await query<{
            flag_type: string;
            score_impact: number;
            issued_at: string;
        }>(
            `SELECT flag_type, score_impact, issued_at FROM red_flags
         WHERE wallet_address = $1 ORDER BY issued_at DESC LIMIT 10`,
            [passport.wallet_address]
        );

        const social = await query<{ platform: string; attested_at: string }>(
            `SELECT platform, attested_at FROM social_attestations
         WHERE wallet_address = $1 AND active = TRUE`,
            [passport.wallet_address]
        );

        // Count vouches
        const vouchStats = await queryOne<{ received: string; given: string }>(
            `SELECT 
              (SELECT COUNT(*) FROM vouch_events WHERE vouchee_wallet = $1 AND status = 'active') as received,
              (SELECT COUNT(*) FROM vouch_events WHERE voucher_wallet = $1 AND status = 'active') as given`,
            [passport.wallet_address]
        );

        res.json({
            ...passport,
            red_flags,
            verified_social: social,
            vouches_received: parseInt(vouchStats?.received || '0'),
            vouches_given: parseInt(vouchStats?.given || '0'),
            // Pillar breakdown (estimated from data)
            pillar_on_chain: Math.min(400, Math.round(passport.score * 0.4)),
            pillar_vouch: Math.min(300, Math.round(passport.score * 0.3)),
            pillar_social: Math.min(300, Math.round(passport.score * 0.3)),
        });
    } catch (err) {
        console.error('GET /passport error:', err);
        res.status(500).json({ error: 'Failed to fetch passport' });
    }
});

// POST /api/passport/approve-mint
const ApproveMintSchema = z.object({ paymentId: z.string().min(10) });

app.post('/api/passport/approve-mint', piAuthMiddleware, async (req, res) => {
    const parse = ApproveMintSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: parse.error.flatten() }); return; }

    const { paymentId } = parse.data;
    const piUser = req.piUser!;

    try {
        const existing = await queryOne('SELECT id FROM passports WHERE pi_uid = $1', [piUser.uid]);
        if (existing) { res.status(409).json({ error: 'Passport already minted' }); return; }

        // Validate payment
        const payment = await getPayment(paymentId);
        if (payment.user_uid !== piUser.uid) throw new Error('Payment user mismatch');
        if (payment.amount < 1) throw new Error(`Insufficient: ${payment.amount} Pi`);
        if (payment.status.cancelled || payment.status.user_cancelled) throw new Error('Payment cancelled');

        await approvePayment(paymentId);
        res.json({ approved: true, message: 'Payment approved. Awaiting blockchain confirmation.' });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Approval failed';
        res.status(422).json({ error: message });
    }
});

// POST /api/passport/complete-mint
const CompleteMintSchema = z.object({
    paymentId: z.string().min(10),
    txId: z.string().min(10),
});

app.post('/api/passport/complete-mint', piAuthMiddleware, async (req, res) => {
    const parse = CompleteMintSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: parse.error.flatten() }); return; }

    const { paymentId, txId } = parse.data;
    const piUser = req.piUser!;

    try {
        const payment = await getPayment(paymentId);
        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed' });
            return;
        }
        await completePayment(paymentId, txId);

        await query(
            `INSERT INTO passports (wallet_address, pi_uid, minted_at, score, tier)
         VALUES ($1, $2, NOW(), 50, 'bronze')
         ON CONFLICT (wallet_address) DO NOTHING`,
            [payment.from_address, piUser.uid]
        );

        res.json({
            success: true,
            wallet: payment.from_address,
            score: 50,
            tier: 'bronze',
            message: '🎉 PiTrust Passport minted!',
        });
    } catch (err) {
        console.error('Complete mint error:', err);
        res.status(500).json({ error: 'Failed to complete mint' });
    }
});

// ── Vouch Routes ──────────────────────────────────────────────────────────────

app.get('/api/vouch/:wallet', async (req, res) => {
    const { wallet } = req.params;
    try {
        const vouches = await query<{
            voucher_wallet: string;
            net_amount_pi: string;
            staked_at: string;
            status: string;
        }>(
            `SELECT voucher_wallet, net_amount_pi, staked_at, status
         FROM vouch_events WHERE vouchee_wallet = $1 ORDER BY staked_at DESC`,
            [wallet]
        );
        const total_stake = vouches
            .filter(v => v.status === 'active')
            .reduce((sum, v) => sum + parseFloat(v.net_amount_pi), 0);
        res.json({ vouches, total_active_stake_pi: total_stake.toFixed(7) });
    } catch (err) {
        console.error('GET /vouch error:', err);
        res.json({ vouches: [], total_active_stake_pi: '0' });
    }
});

app.post('/api/vouch/approve', piAuthMiddleware, async (req, res) => {
    const { paymentId, targetWallet } = req.body;
    if (!paymentId || !targetWallet) {
        res.status(400).json({ error: 'Missing paymentId or targetWallet' });
        return;
    }
    const piUser = req.piUser!;
    const voucher = await queryOne<{ wallet_address: string }>(
        'SELECT wallet_address FROM passports WHERE pi_uid = $1', [piUser.uid]
    );
    if (!voucher) { res.status(403).json({ error: 'No passport. Mint one first.' }); return; }

    try {
        await approvePayment(paymentId);
        res.json({ approved: true });
    } catch (err: any) {
        res.status(422).json({ error: err.message || 'Payment approval failed' });
    }
});

app.post('/api/vouch/complete', piAuthMiddleware, async (req, res) => {
    const { paymentId, txId, targetWallet } = req.body;
    if (!paymentId || !txId || !targetWallet) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    try {
        const payment = await getPayment(paymentId);
        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed' });
            return;
        }
        await completePayment(paymentId, txId);

        await query(
            `INSERT INTO vouch_events (voucher_wallet, vouchee_wallet, amount_pi, net_amount_pi, status, staked_at)
             VALUES ($1, $2, $3, $4, 'active', NOW())`,
            [payment.from_address, targetWallet, payment.amount, payment.amount * 0.98]
        );
        res.json({ success: true, message: 'Vouch recorded.' });
    } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to complete vouch' });
    }
});

// ── Dispute Routes ────────────────────────────────────────────────────────────

app.get('/api/dispute', async (_req, res) => {
    try {
        const disputes = await query<{
            dispute_id: string;
            claimant_wallet: string;
            defendant_wallet: string;
            status: string;
            filed_at: string;
            voting_deadline: string;
        }>(
            `SELECT id as dispute_id, claimant_wallet, defendant_wallet, status, filed_at, voting_deadline
         FROM disputes ORDER BY filed_at DESC LIMIT 50`
        );
        res.json(disputes);
    } catch (err) {
        console.error('GET /dispute error:', err);
        res.json([]);
    }
});

app.get('/api/dispute/:id', async (req, res) => {
    const dispute = await queryOne<{
        dispute_id: string;
        claimant_wallet: string;
        defendant_wallet: string;
        status: string;
        filed_at: string;
        voting_deadline: string;
    }>(
        'SELECT id as dispute_id, claimant_wallet, defendant_wallet, status, filed_at, voting_deadline FROM disputes WHERE id = $1',
        [req.params.id]
    );
    if (!dispute) { res.status(404).json({ error: 'Dispute not found' }); return; }
    res.json(dispute);
});

app.post('/api/dispute/file', piAuthMiddleware, writeLimiter, async (req, res) => {
    const { defendant_wallet, evidence_hash, paymentId } = req.body;
    if (!defendant_wallet || !evidence_hash || !paymentId) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    const piUser = req.piUser!;
    const claimant = await queryOne<{ wallet_address: string }>(
        'SELECT wallet_address FROM passports WHERE pi_uid = $1', [piUser.uid]
    );
    if (!claimant) { res.status(403).json({ error: 'No passport. Mint one first.' }); return; }

    try {
        await approvePayment(paymentId);
        res.json({ status: 'payment_approved', message: 'Complete payment to file dispute.' });
    } catch (err: any) {
        res.status(422).json({ error: err.message || 'Payment approval failed' });
    }
});

app.post('/api/dispute/complete', piAuthMiddleware, writeLimiter, async (req, res) => {
    const { paymentId, txId, defendant_wallet, evidence_hash } = req.body;
    if (!paymentId || !txId || !defendant_wallet || !evidence_hash) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    try {
        const payment = await getPayment(paymentId);
        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed' });
            return;
        }
        await completePayment(paymentId, txId);

        await query(
            `INSERT INTO disputes (claimant_wallet, defendant_wallet, status, filed_at, voting_deadline, evidence_hash)
             VALUES ($1, $2, 'filed', NOW(), NOW() + INTERVAL '3 days', $3)`,
            [payment.from_address, defendant_wallet, evidence_hash]
        );
        res.json({ success: true, message: 'Dispute filed.' });
    } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to file dispute' });
    }
});

// ── Score Route ───────────────────────────────────────────────────────────────
app.get('/api/score/:wallet', async (req, res) => {
    const passport = await queryOne<{ score: number; tier: string; last_score_update: string }>(
        'SELECT score, tier, last_score_update FROM passports WHERE wallet_address = $1',
        [req.params.wallet]
    );
    res.json(passport ?? { score: 0, tier: 'unverified', last_score_update: null });
});

// ── Merchant Route ────────────────────────────────────────────────────────────
app.get('/api/merchant', async (req, res) => {
    const page = parseInt(req.query.page as string || '1');
    const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);
    const offset = (page - 1) * limit;
    const merchants = await query<{
        wallet_address: string;
        display_name: string;
        category: string;
        registered_at: string;
    }>(
        `SELECT wallet_address, display_name, category, registered_at
     FROM merchants WHERE status = 'active' ORDER BY registered_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    res.json({ merchants, page, limit });
});

// ── Trade Route ───────────────────────────────────────────────────────────────
app.get('/api/trade/:id', async (req, res) => {
    const trade = await queryOne<{
        trade_id: number;
        buyer_wallet: string;
        seller_wallet: string;
        amount_pi: string;
        status: string;
        created_at: string;
    }>(
        'SELECT trade_id, buyer_wallet, seller_wallet, amount_pi, status, created_at FROM trades WHERE id = $1',
        [req.params.id]
    );
    if (!trade) { res.status(404).json({ error: 'Trade not found' }); return; }
    res.json(trade);
});

// ── 404 Catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

export default app;
