/**
 * Vercel Serverless Function PiTrust API Gateway
 *
 * This single function handles ALL /api/* routes by wrapping the
 * existing Express app. Vercel routes /api/[...path] to this file.
 *
 * Architecture:
 * Vercel Frontend (SPA) /api/* This serverless function
 * Express app (same routes as backend/api/src)
 * Supabase PostgreSQL
 * Pi API (https://api.minepi.com)
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { Pool } from 'pg';
import axios from 'axios';
import { z } from 'zod';
import * as StellarSdk from 'stellar-sdk';

// Database
// Supabase pooler uses self-signed certs ssl.rejectUnauthorized must be false.
// Do NOT append sslmode=require to the URL it overrides rejectUnauthorized.
const dbUrl = process.env.DATABASE_URL || '';

const pool = new Pool({
    connectionString: dbUrl || undefined,
    max: 3,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
    ssl: dbUrl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
    console.error('[DB] Pool error:', err.message);
});

async function query<T extends object>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await pool.query<T>(text, params);
    return result.rows;
}

async function queryOne<T extends object>(text: string, params?: unknown[]): Promise<T | null> {
    const result = await pool.query<T>(text, params);
    return result.rows[0] ?? null;
}

// Pi API helpers
const PI_API_BASE = process.env.PI_API_BASE || 'https://api.minepi.com';
const PI_API_KEY = process.env.PI_API_KEY || '';

const piHeaders = () => ({
    Authorization: `Key ${PI_API_KEY}`,
    'Content-Type': 'application/json',
});

// Pi App Wallet Configuration
const PI_APP_WALLET_ADDRESS = process.env.PI_APP_WALLET_ADDRESS || '';
const PI_APP_WALLET_PRIVATE_SEED = process.env.PI_APP_WALLET_PRIVATE_SEED || '';

// Connect to the Pi Horizon Node
// Use the Testnet API for development
const horizonServer = new StellarSdk.Horizon.Server('https://api.testnet.minepi.com');

/**
 * Orchestrates an automated App-to-User (A2U) payout.
 */
async function sendPiToUser(targetUserUid: string, targetWalletFormat: string, amount: number, memo: string) {
    if (!PI_APP_WALLET_PRIVATE_SEED) {
        throw new Error('Server wallet seed missing. Cannot process A2U payouts.');
    }

    try {
        // 1. Create a Payment Intent via Pi API
        const paymentData = {
            amount: amount,
            memo: memo,
            metadata: { type: 'automated_payout' },
            uid: targetUserUid
        };

        const piIntentRes = await axios.post(`${PI_API_BASE}/v2/payments`, paymentData, { headers: piHeaders() });
        const paymentId = piIntentRes.data.identifier;

        // 2. Load our App Wallet Keypair using the Secret Seed
        const appKeypair = StellarSdk.Keypair.fromSecret(PI_APP_WALLET_PRIVATE_SEED);
        const sourceAccount = await horizonServer.loadAccount(appKeypair.publicKey());

        // 3. Construct the Blockchain Transaction
        // Pi Testnet passphrase
        const networkPassphrase = process.env.PI_NETWORK_PASSPHRASE || 'Pi Testnet';

        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase,
        })
            .addOperation(StellarSdk.Operation.payment({
                destination: targetWalletFormat,
                asset: StellarSdk.Asset.native(),
                amount: amount.toString(),
            }))
            .addMemo(StellarSdk.Memo.text(paymentId)) // Important: tie Tx to Pi Payment ID
            .setTimeout(180)
            .build();

        // 4. Sign & Submit to the Blockchain
        tx.sign(appKeypair);
        const submitRes = await horizonServer.submitTransaction(tx);
        const txId = submitRes.hash;

        // 5. Tell Pi API the payment is completely verified
        await completePayment(paymentId, txId);

        return { success: true, txId, paymentId };
    } catch (error: any) {
        console.error('[A2U Payout] Failed:', error?.response?.data || error.message);
        throw error;
    }
}

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

const PASSPORT_MINT_PRICE_PI = 1;
const PASSPORT_MINT_MEMOS = new Set(['PiTrust Passport Mint', 'pitrust_mint']);

function assertValidPassportMintPayment(
    payment: Awaited<ReturnType<typeof getPayment>>,
    expectedUserUid?: string
) {
    if (expectedUserUid && payment.user_uid !== expectedUserUid) {
        throw new Error('Payment user mismatch');
    }
    if (Math.abs(Number(payment.amount) - PASSPORT_MINT_PRICE_PI) > 0.0000001) {
        throw new Error(`Invalid mint amount: ${payment.amount} Pi`);
    }
    if (!PASSPORT_MINT_MEMOS.has(String(payment.memo || ''))) {
        throw new Error(`Invalid payment memo: ${payment.memo}`);
    }
    if (payment.metadata?.type !== 'passport_mint') {
        throw new Error('Invalid payment type');
    }
    if (!payment.from_address) {
        throw new Error('Payment wallet missing');
    }
    if (payment.status.cancelled || payment.status.user_cancelled) {
        throw new Error('Payment cancelled');
    }
}

async function findPassportByIdentity(walletAddress: string, piUid: string) {
    return queryOne<{
        id: string;
        wallet_address: string;
        pi_uid: string;
        score: number;
        tier: string;
    }>(
        `SELECT id, wallet_address, pi_uid, score, tier
         FROM passports
         WHERE wallet_address = $1 OR pi_uid = $2
         LIMIT 1`,
        [walletAddress, piUid]
    );
}
// Pi Auth Middleware
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

// Auth Route
const authRouter = express.Router();
authRouter.get('/me', piAuthMiddleware, (req, res) => {
    // Return the verified user object from the Pi Platform API
    res.json(req.piUser);
});

// Express App
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

// Mount the Auth Router
app.use('/api/auth', authRouter);

// Health Route
app.get('/api/health', async (_req, res) => {
    const masked = dbUrl
        ? dbUrl.replace(/\/\/[^@]+@/, '//***:***@').replace(/\?.+/, '?...')
        : '(not set)';
    try {
        const result = await pool.query('SELECT NOW() as now');
        res.json({
            status: 'ok',
            db: 'connected',
            db_time: result.rows[0]?.now,
            db_url_masked: masked,
            timestamp: new Date().toISOString(),
        });
    } catch (err: any) {
        res.status(503).json({
            status: 'error',
            message: 'DB unavailable',
            detail: err?.message || 'Unknown',
            db_url_masked: masked,
        });
    }
});

// Auth Routes
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

// Passport Routes

// POST /api/payments/incomplete (Unauthenticated used by PiAuthContext onIncompletePaymentFound)
app.post('/api/payments/incomplete', async (req, res) => {
    const { paymentId, txId } = req.body;
    if (!paymentId) {
        res.status(400).json({ error: 'Missing paymentId' });
        return;
    }

    try {
        const payment = await getPayment(paymentId);
        const resolvedTxId = txId || payment.transaction?.txid || '';

        if (!payment.status.developer_approved) {
            await approvePayment(paymentId);
        }

        if (resolvedTxId && payment.status.transaction_verified && !payment.status.developer_completed) {
            await completePayment(paymentId, resolvedTxId);
        }

        const pType = payment.metadata?.type;
        if (pType === 'passport_mint' && payment.status.transaction_verified) {
            assertValidPassportMintPayment(payment, payment.user_uid);
            const existingPassport = await findPassportByIdentity(payment.from_address, payment.user_uid);
            if (!existingPassport) {
                await query(
                    `INSERT INTO passports (wallet_address, pi_uid, minted_at, score, tier)
                     VALUES ($1, $2, NOW(), 50, 'bronze')`,
                    [payment.from_address, payment.user_uid]
                );
            }
        } else if (resolvedTxId && pType === 'vouch_stake' && payment.status.transaction_verified) {
            const targetWallet = payment.metadata?.target;
            if (targetWallet) {
                await query(
                    `INSERT INTO vouch_events (voucher_wallet, vouchee_wallet, amount_pi, net_amount_pi, status, staked_at)
                     VALUES ($1, $2, $3, $4, 'active', NOW())`,
                    [payment.from_address, targetWallet, payment.amount, payment.amount * 0.98]
                );
            }
        } else if (resolvedTxId && pType === 'dispute_filing' && payment.status.transaction_verified) {
            const targetWallet = payment.metadata?.target;
            const evidence = payment.metadata?.evidence;
            if (targetWallet && evidence) {
                await query(
                    `INSERT INTO disputes (claimant_wallet, defendant_wallet, status, filed_at, voting_deadline, evidence_hash)
                     VALUES ($1, $2, 'filed', NOW(), NOW() + INTERVAL '3 days', $3)`,
                    [payment.from_address, targetWallet, evidence]
                );
            }
        }

        res.json({ success: true, message: 'Incomplete payment processed' });
    } catch (err: any) {
        console.error('Incomplete payment error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to process incomplete payment' });
    }
});

app.get('/api/passport/:walletOrUid', async (req, res) => {
    const identifier = req.params.walletOrUid;
    if (!identifier || identifier.length < 3) {
        res.status(400).json({ error: 'Invalid identifier' });
        return;
    }

    try {
        const passport = await queryOne<{
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
             FROM passports
             WHERE wallet_address = $1 OR pi_uid = $1
             LIMIT 1`,
            [identifier]
        );

        if (!passport) {
            res.status(404).json({ error: 'Passport not found' });
            return;
        }

        const [redFlags, social, vouchStats, disputeStats, receivedVouches, givenVouches, disputes] = await Promise.all([
            query<{
                id: string;
                flag_type: string;
                score_impact: number;
                issued_at: string;
            }>(
                `SELECT id, flag_type, score_impact, issued_at
                 FROM red_flags
                 WHERE wallet_address = $1
                 ORDER BY issued_at DESC
                 LIMIT 10`,
                [passport.wallet_address]
            ),
            query<{ id: string; platform: string; attested_at: string }>(
                `SELECT id, platform, attested_at
                 FROM social_attestations
                 WHERE wallet_address = $1 AND active = TRUE
                 ORDER BY attested_at DESC`,
                [passport.wallet_address]
            ),
            queryOne<{ received: string; given: string; total_received_stake: string; total_given_stake: string }>(
                `SELECT
                    (SELECT COUNT(*) FROM vouch_events WHERE vouchee_wallet = $1 AND status = 'active') as received,
                    (SELECT COUNT(*) FROM vouch_events WHERE voucher_wallet = $1 AND status = 'active') as given,
                    (SELECT COALESCE(SUM(net_amount_pi), 0) FROM vouch_events WHERE vouchee_wallet = $1 AND status = 'active') as total_received_stake,
                    (SELECT COALESCE(SUM(net_amount_pi), 0) FROM vouch_events WHERE voucher_wallet = $1 AND status = 'active') as total_given_stake`,
                [passport.wallet_address]
            ),
            queryOne<{ filed: string; opened_against: string; resolved: string }>(
                `SELECT
                    (SELECT COUNT(*) FROM disputes WHERE claimant_wallet = $1) as filed,
                    (SELECT COUNT(*) FROM disputes WHERE defendant_wallet = $1) as opened_against,
                    (SELECT COUNT(*) FROM disputes WHERE (claimant_wallet = $1 OR defendant_wallet = $1) AND status IN ('convicted', 'exonerated')) as resolved`,
                [passport.wallet_address]
            ),
            query<{ id: string; voucher_wallet: string; net_amount_pi: string; staked_at: string }>(
                `SELECT id, voucher_wallet, net_amount_pi, staked_at
                 FROM vouch_events
                 WHERE vouchee_wallet = $1 AND status = 'active'
                 ORDER BY staked_at DESC
                 LIMIT 8`,
                [passport.wallet_address]
            ),
            query<{ id: string; vouchee_wallet: string; net_amount_pi: string; staked_at: string }>(
                `SELECT id, vouchee_wallet, net_amount_pi, staked_at
                 FROM vouch_events
                 WHERE voucher_wallet = $1 AND status = 'active'
                 ORDER BY staked_at DESC
                 LIMIT 8`,
                [passport.wallet_address]
            ),
            query<{ id: string; claimant_wallet: string; defendant_wallet: string; status: string; filed_at: string }>(
                `SELECT id, claimant_wallet, defendant_wallet, status, filed_at
                 FROM disputes
                 WHERE claimant_wallet = $1 OR defendant_wallet = $1
                 ORDER BY filed_at DESC
                 LIMIT 8`,
                [passport.wallet_address]
            )
        ]);

        const vouchesReceived = parseInt(vouchStats?.received || '0', 10);
        const vouchesGiven = parseInt(vouchStats?.given || '0', 10);
        const socialVerifiedCount = social.length;
        const redFlagCount = redFlags.length;
        const disputesFiled = parseInt(disputeStats?.filed || '0', 10);
        const disputesOpenedAgainst = parseInt(disputeStats?.opened_against || '0', 10);
        const disputesResolved = parseInt(disputeStats?.resolved || '0', 10);
        const completedTrades = passport.completed_trades ?? 0;
        const disputedTrades = passport.disputed_trades ?? 0;

        const pillarOnChain = Math.max(
            0,
            Math.min(
                400,
                Math.round(
                    completedTrades * 25 +
                    Math.min(120, disputesResolved * 18) +
                    (passport.minted_at ? 80 : 0) -
                    Math.min(180, disputedTrades * 30)
                )
            )
        );
        const pillarVouch = Math.max(
            0,
            Math.min(
                300,
                Math.round(
                    Math.min(180, vouchesReceived * 30) +
                    Math.min(90, Number(vouchStats?.total_received_stake || 0) * 12) +
                    Math.min(30, vouchesGiven * 6)
                )
            )
        );
        const pillarSocial = Math.max(
            0,
            Math.min(
                300,
                Math.round(
                    Math.min(180, socialVerifiedCount * 60) +
                    Math.min(60, disputesFiled * 10)
                )
            )
        );
        const penalties = redFlags.reduce((total, flag) => total + Math.abs(Number(flag.score_impact || 0)), 0);

        let headline = 'Early-stage passport';
        let subline = 'Minted and visible, but still building meaningful trust signals.';
        if (redFlagCount > 0 || passport.score < 100) {
            headline = 'Trust needs recovery';
            subline = 'Active warnings are weighing on this passport.';
        } else if (passport.score >= 900) {
            headline = 'Network sentinel status';
            subline = 'Exceptional reputation backed by strong history.';
        } else if (passport.score >= 700) {
            headline = 'High-confidence counterparty';
            subline = 'This passport shows durable, above-average trust signals.';
        } else if (passport.score >= 500) {
            headline = 'Trusted for regular commerce';
            subline = 'Balanced reputation across on-chain, social, and vouch signals.';
        } else if (passport.score >= 250) {
            headline = 'Trust is still forming';
            subline = 'Recent activity is positive, but the history is still thin.';
        }

        const history = [
            passport.minted_at
                ? {
                    id: `minted-${passport.wallet_address}`,
                    type: 'passport_minted',
                    occurred_at: passport.minted_at,
                    title: 'Passport minted',
                    detail: 'Trust Passport activated for this wallet.',
                    impact: 'positive',
                }
                : null,
            ...receivedVouches.map((item) => ({
                id: `vouch-received-${item.id}`,
                type: 'vouch_received',
                occurred_at: item.staked_at,
                title: 'Stake-backed vouch received',
                detail: `${item.voucher_wallet} vouched with ${item.net_amount_pi} Pi net stake.`,
                impact: 'positive',
            })),
            ...givenVouches.map((item) => ({
                id: `vouch-given-${item.id}`,
                type: 'vouch_given',
                occurred_at: item.staked_at,
                title: 'Trust extended to another pioneer',
                detail: `Vouched for ${item.vouchee_wallet} with ${item.net_amount_pi} Pi net stake.`,
                impact: 'neutral',
            })),
            ...disputes.map((item) => {
                const filedByPassport = item.claimant_wallet === passport.wallet_address;
                return {
                    id: `dispute-${item.id}`,
                    type: filedByPassport ? 'dispute_filed' : 'dispute_opened_against',
                    occurred_at: item.filed_at,
                    title: filedByPassport ? 'Dispute filed' : 'Dispute opened against passport',
                    detail: filedByPassport
                        ? `Filed against ${item.defendant_wallet}. Current status: ${item.status}.`
                        : `Opened by ${item.claimant_wallet}. Current status: ${item.status}.`,
                    impact: item.status === 'convicted' ? 'warning' : 'neutral',
                };
            }),
            ...redFlags.map((item) => ({
                id: `flag-${item.id}`,
                type: 'red_flag_issued',
                occurred_at: item.issued_at,
                title: 'Red flag issued',
                detail: `${item.flag_type} (-${Math.abs(Number(item.score_impact || 0))} score impact).`,
                impact: 'warning',
            })),
            ...social.map((item) => ({
                id: `social-${item.id}`,
                type: 'social_verified',
                occurred_at: item.attested_at,
                title: `${item.platform} linked`,
                detail: `${item.platform} attestation is active on this passport.`,
                impact: 'positive',
            }))
        ]
            .filter((event): event is NonNullable<typeof event> => Boolean(event))
            .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
            .slice(0, 20);

        res.json({
            ...passport,
            minted: true,
            red_flags: redFlags,
            verified_social: social,
            vouches_received: vouchesReceived,
            vouches_given: vouchesGiven,
            pillar_on_chain: pillarOnChain,
            pillar_vouch: pillarVouch,
            pillar_social: pillarSocial,
            trust_summary: {
                headline,
                subline,
                score: passport.score,
                tier: passport.tier,
                score_frozen: passport.score_frozen,
                last_score_update: passport.last_score_update,
            },
            score_breakdown: {
                on_chain: pillarOnChain,
                vouch: pillarVouch,
                social: pillarSocial,
                penalties,
                total: passport.score,
            },
            verification_flags: {
                pi_authenticated: true,
                wallet_bound: true,
                social_verified_count: socialVerifiedCount,
                has_active_red_flags: redFlagCount > 0,
            },
            stats: {
                completed_trades: completedTrades,
                disputed_trades: disputedTrades,
                disputes_filed: disputesFiled,
                disputes_opened_against: disputesOpenedAgainst,
                disputes_resolved: disputesResolved,
                vouches_received: vouchesReceived,
                vouches_given: vouchesGiven,
                red_flags: redFlagCount,
                social_verified: socialVerifiedCount,
                total_received_stake_pi: Number(vouchStats?.total_received_stake || 0),
                total_given_stake_pi: Number(vouchStats?.total_given_stake || 0),
            },
            history,
            history_count: history.length,
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
        const payment = await getPayment(paymentId);
        assertValidPassportMintPayment(payment, piUser.uid);

        const existing = await findPassportByIdentity(payment.from_address, piUser.uid);
        if (existing) { res.status(409).json({ error: 'Passport already minted for this wallet or user.' }); return; }

        if (!payment.status.developer_approved) {
            await approvePayment(paymentId);
        }
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
        assertValidPassportMintPayment(payment, piUser.uid);

        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed' });
            return;
        }
        if (payment.transaction?.txid && payment.transaction.txid !== txId) {
            res.status(422).json({ error: 'Transaction hash mismatch' });
            return;
        }

        const existing = await findPassportByIdentity(payment.from_address, piUser.uid);
        if (existing && (existing.wallet_address !== payment.from_address || existing.pi_uid !== piUser.uid)) {
            res.status(409).json({ error: 'Passport already exists for a different identity.' });
            return;
        }

        if (!payment.status.developer_completed) {
            await completePayment(paymentId, txId);
        }

        if (!existing) {
            await query(
                "INSERT INTO passports (wallet_address, pi_uid, minted_at, score, tier) VALUES ($1, $2, NOW(), 50, 'bronze')",
                [payment.from_address, piUser.uid]
            );
        }

        res.json({
            success: true,
            wallet: payment.from_address,
            score: existing?.score ?? 50,
            tier: existing?.tier ?? 'bronze',
            message: existing ? 'Passport already active.' : 'PiTrust Passport minted!',
        });
    } catch (err) {
        console.error('Complete mint error:', err);
        res.status(500).json({ error: 'Failed to complete mint' });
    }
});

// Vouch Routes

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

// Dispute Routes

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

// Score Engine (ported from Python FastAPI score_engine/main.py)
// Score = (On-chain 30%) + (Vouch Network 30%) + (Social 20%) + (Governance 20%), scaled to 01000

function scoreTradeCompletion(completed: number, disputed: number): number {
    const total = completed + disputed;
    if (total === 0) return 5; // Neutral
    return Math.round((completed / total) * 10 * 100) / 100;
}

function scoreVouchStake(totalStakePi: number): number {
    if (totalStakePi <= 0) return 0;
    return Math.min(20, Math.log(totalStakePi + 1) / Math.log(51) * 20);
}

function scoreVouchCount(uniqueVouchers: number): number {
    return Math.min(10, uniqueVouchers);
}

function scoreSocialPlatforms(platformCount: number): number {
    return Math.min(16, platformCount * 4);
}

function scoreToTier(score: number): string {
    if (score < 100) return 'unverified';
    if (score < 300) return 'bronze';
    if (score < 500) return 'silver';
    if (score < 700) return 'gold';
    if (score < 900) return 'platinum';
    return 'sentinel';
}

async function calculateScore(walletAddress: string): Promise<{ score: number; tier: string; pillar_on_chain: number; pillar_vouch: number; pillar_social: number }> {
    const row = await queryOne<{
        completed_trades: number;
        disputed_trades: number;
        vouch_count: string;
        vouch_stake: string;
        social_count: string;
        scam_flags: string;
        gov_votes: string;
    }>(`
        SELECT p.completed_trades, p.disputed_trades,
            (SELECT COUNT(*) FROM vouch_events WHERE vouchee_wallet = p.wallet_address AND status = 'active') as vouch_count,
            (SELECT COALESCE(SUM(net_amount_pi), 0) FROM vouch_events WHERE vouchee_wallet = p.wallet_address AND status = 'active') as vouch_stake,
            (SELECT COUNT(*) FROM social_attestations WHERE wallet_address = p.wallet_address AND active = TRUE) as social_count,
            (SELECT COUNT(*) FROM red_flags WHERE wallet_address = p.wallet_address AND flag_type ILIKE '%scam%') as scam_flags,
            (SELECT COUNT(*) FROM dispute_votes WHERE arbitrator = p.wallet_address) as gov_votes
        FROM passports p WHERE p.wallet_address = $1
    `, [walletAddress]);

    if (!row) return { score: 0, tier: 'unverified', pillar_on_chain: 0, pillar_vouch: 0, pillar_social: 0 };

    // 1. SCAM PENALTY: Zero tolerance
    if (parseInt(row.scam_flags || '0') > 0) {
        return { score: 0, tier: 'blacklisted', pillar_on_chain: 0, pillar_vouch: 0, pillar_social: 0 };
    }

    // On-chain component (max 30 raw pts)
    const tradePts = scoreTradeCompletion(row.completed_trades || 0, row.disputed_trades || 0);
    const onchainRaw = Math.min(30, tradePts + 5 + (row.completed_trades > 5 ? 5 : 0));

    // Vouch Network component (max 30 raw pts)
    const vouchStakePts = scoreVouchStake(parseFloat(row.vouch_stake || '0'));
    const vouchCountPts = scoreVouchCount(parseInt(row.vouch_count || '0'));
    const vouchRaw = Math.min(30, vouchStakePts + vouchCountPts);

    // Social attestation & Identity component (max 20 raw pts)
    const socialPts = scoreSocialPlatforms(parseInt(row.social_count || '0'));
    const socialRaw = Math.min(20, socialPts + 5); // +5 baseline for Pi Network verified auth

    // Governance & Platform Engagement (max 20 raw pts)
    const govPts = Math.min(15, parseInt(row.gov_votes || '0') * 3);
    const activityPts = 5; // Placeholder for active users
    const govRaw = Math.min(20, govPts + activityPts);

    // Final score: raw (0-100) scaled (0-1000)
    const rawTotal = onchainRaw + vouchRaw + socialRaw + govRaw;
    const finalScore = Math.min(1000, Math.max(0, Math.round(rawTotal * 10)));
    const tier = scoreToTier(finalScore);

    // Pillar breakdown scaled to display values
    const pillar_on_chain = Math.round(onchainRaw / 30 * 300);
    const pillar_vouch = Math.round(vouchRaw / 30 * 300);
    const pillar_social = Math.round((socialRaw + govRaw) / 40 * 400); // Merged Social+Gov for UI simplicity

    return { score: finalScore, tier, pillar_on_chain, pillar_vouch, pillar_social };
}

// Score Route
app.get('/api/score/:wallet', async (req, res) => {
    try {
        const result = await calculateScore(req.params.wallet);
        // Update the score in the database
        await query(
            'UPDATE passports SET score = $1, tier = $2, last_score_update = NOW() WHERE wallet_address = $3',
            [result.score, result.tier, req.params.wallet]
        );
        res.json({ wallet: req.params.wallet, ...result, last_score_update: new Date().toISOString() });
    } catch (err) {
        console.error('Score calculation error:', err);
        // Fallback to stored score
        const passport = await queryOne<{ score: number; tier: string; last_score_update: string }>(
            'SELECT score, tier, last_score_update FROM passports WHERE wallet_address = $1',
            [req.params.wallet]
        );
        res.json(passport ?? { score: 0, tier: 'unverified', last_score_update: null });
    }
});

// Quests Route (Gamification)
app.post('/api/quests/complete', piAuthMiddleware, writeLimiter, async (req, res) => {
    const { questId, platform } = req.body;
    const piUser = req.piUser!;

    try {
        const passport = await queryOne<{ wallet_address: string }>('SELECT wallet_address FROM passports WHERE pi_uid = $1', [piUser.uid]);
        if (!passport) {
            res.status(403).json({ error: 'Mint Passport to claim quests' });
            return;
        }

        if (questId === 'social_link' && platform) {
            // Mock social connect -> Insert real record
            await query(`
                INSERT INTO social_attestations (wallet_address, platform, platform_uid, credential_hash)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (wallet_address, platform, active) DO NOTHING
            `, [passport.wallet_address, platform, `u_${Date.now()}`, `hash_${Date.now()}`]);

            res.json({ success: true, reward: 50, message: `${platform} connected! Trust score will update.` });
            return;
        }
        res.status(400).json({ error: 'Unknown quest' });
    } catch (err: any) {
        res.status(500).json({ error: 'Quest completion failed' });
    }
});

// Security Headers Middleware
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    // Disable caching for api responses
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    next();
});

// Root / Health / Validation
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));
app.get('/api', (req, res) => res.json({ message: 'PiTrust API v1 Running on Vercel' }));

// Bulletproof fallback for Pi Developer validation bot
app.get('/validation-key.txt', (req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    res.send('4bcb87b8aa6d5f864e36edcefa323ef25130ad02432f0b1607e47bcd2fa65846b3a622367c321571252c91fa4bf175c4271618e73a3cb24e48ea3ddebedb2e00');
});

// Merchant Route
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

// Trade Route
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

// 404 Catch-all
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Global Error Handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

export default app;



