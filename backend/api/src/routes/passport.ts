import { Router, Request, Response } from 'express';
import { piAuthMiddleware } from '../middleware/auth';
import { query, queryOne } from '../db/client';
import { CONTRACTS, invokeContract } from '../stellar/contracts';
import { approveMintPayment, assertValidPassportMintPayment, completePayment, getPayment } from '../services/payment';
import { Address } from '@stellar/stellar-sdk';
import { z } from 'zod';

export const passportRouter = Router();

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


// GET /api/passport/:wallet
// Public endpoint: read a passport by wallet address
passportRouter.get('/:wallet', async (req: Request, res: Response) => {
    const walletAddress = req.params.wallet;

    if (!walletAddress || walletAddress.length < 50) {
        res.status(400).json({ error: 'Invalid wallet address' });
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
             FROM passports WHERE wallet_address = $1`,
            [walletAddress]
        );

        if (!passport) {
            res.status(404).json({ error: 'Passport not found' });
            return;
        }

        const [redFlags, social, vouchStats, disputeStats, receivedVouches, givenVouches, disputes, merchant] = await Promise.all([
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
                [walletAddress]
            ),
            query<{ id: string; platform: string; attested_at: string }>(
                `SELECT id, platform, attested_at
                 FROM social_attestations
                 WHERE wallet_address = $1 AND active = TRUE
                 ORDER BY attested_at DESC`,
                [walletAddress]
            ),
            queryOne<{ received: string; given: string; total_received_stake: string; total_given_stake: string }>(
                `SELECT
                    (SELECT COUNT(*) FROM vouch_events WHERE vouchee_wallet = $1 AND status = 'active') as received,
                    (SELECT COUNT(*) FROM vouch_events WHERE voucher_wallet = $1 AND status = 'active') as given,
                    (SELECT COALESCE(SUM(net_amount_pi), 0) FROM vouch_events WHERE vouchee_wallet = $1 AND status = 'active') as total_received_stake,
                    (SELECT COALESCE(SUM(net_amount_pi), 0) FROM vouch_events WHERE voucher_wallet = $1 AND status = 'active') as total_given_stake`,
                [walletAddress]
            ),
            queryOne<{ filed: string; opened_against: string; resolved: string }>(
                `SELECT
                    (SELECT COUNT(*) FROM disputes WHERE claimant_wallet = $1) as filed,
                    (SELECT COUNT(*) FROM disputes WHERE defendant_wallet = $1) as opened_against,
                    (SELECT COUNT(*) FROM disputes WHERE (claimant_wallet = $1 OR defendant_wallet = $1) AND status IN ('convicted', 'exonerated')) as resolved`,
                [walletAddress]
            ),
            query<{ id: string; voucher_wallet: string; net_amount_pi: string; staked_at: string }>(
                `SELECT id, voucher_wallet, net_amount_pi, staked_at
                 FROM vouch_events
                 WHERE vouchee_wallet = $1 AND status = 'active'
                 ORDER BY staked_at DESC
                 LIMIT 8`,
                [walletAddress]
            ),
            query<{ id: string; vouchee_wallet: string; net_amount_pi: string; staked_at: string }>(
                `SELECT id, vouchee_wallet, net_amount_pi, staked_at
                 FROM vouch_events
                 WHERE voucher_wallet = $1 AND status = 'active'
                 ORDER BY staked_at DESC
                 LIMIT 8`,
                [walletAddress]
            ),
            query<{ id: string; claimant_wallet: string; defendant_wallet: string; status: string; filed_at: string }>(
                `SELECT id, claimant_wallet, defendant_wallet, status, filed_at
                 FROM disputes
                 WHERE claimant_wallet = $1 OR defendant_wallet = $1
                 ORDER BY filed_at DESC
                 LIMIT 8`,
                [walletAddress]
            ),
            queryOne<{
                display_name: string | null;
                category: string | null;
                description: string | null;
                location: string | null;
                status: string;
                suspension_count: number;
                registered_at: string;
                completed_count: string;
                disputed_count: string;
                total_count: string;
            }>(
                `SELECT m.display_name, m.category, m.description, m.location, m.status,
                        m.suspension_count, m.registered_at,
                        COALESCE(t.completed_count, 0) as completed_count,
                        COALESCE(t.disputed_count, 0) as disputed_count,
                        COALESCE(t.total_count, 0) as total_count
                 FROM merchants m
                 LEFT JOIN (
                    SELECT seller_wallet,
                           COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
                           COUNT(*) FILTER (WHERE status IN ('disputed', 'filed')) as disputed_count,
                           COUNT(*) as total_count
                    FROM trades
                    GROUP BY seller_wallet
                 ) t ON t.seller_wallet = m.wallet_address
                 WHERE m.wallet_address = $1
                 LIMIT 1`,
                [walletAddress]
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
// Step 2 of Pi payment: approve the mint payment
const ApproveMintSchema = z.object({
    paymentId: z.string().min(10),
});

passportRouter.post('/approve-mint', piAuthMiddleware, async (req: Request, res: Response) => {
    const parse = ApproveMintSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json({ error: parse.error.flatten() });
        return;
    }

    const { paymentId } = parse.data;
    const piUser = req.piUser!;

    try {
        const payment = await getPayment(paymentId);
        assertValidPassportMintPayment(payment, piUser.uid);

        const existing = await findPassportByIdentity(payment.from_address, piUser.uid);
        if (existing) {
            res.status(409).json({ error: 'Passport already minted for this wallet or user.' });
            return;
        }

        await approveMintPayment(paymentId, piUser.uid);
        res.json({ approved: true, message: 'Payment approved. Awaiting blockchain confirmation.' });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Approval failed';
        res.status(422).json({ error: message });
    }
});

// POST /api/passport/complete-mint
// Step 3: after user signs tx on Pi Browser, complete the payment and record passport
const CompleteMintSchema = z.object({
    paymentId: z.string().min(10),
    txId: z.string().min(10),
});

passportRouter.post('/complete-mint', piAuthMiddleware, async (req: Request, res: Response) => {
    const parse = CompleteMintSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json({ error: parse.error.flatten() });
        return;
    }

    const { paymentId, txId } = parse.data;
    const piUser = req.piUser!;

    try {
        const payment = await getPayment(paymentId);
        assertValidPassportMintPayment(payment, piUser.uid);

        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed on ledger' });
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

            try {
                await invokeContract({
                    contractId: CONTRACTS.passportSbt,
                    method: 'mint',
                    args: [
                        new Address(payment.from_address).toScVal()
                    ]
                });
            } catch (contractErr) {
                console.error('Contract passport mint failed:', contractErr);
            }
        }

        res.json({
            success: true,
            wallet: payment.from_address,
            score: existing?.score ?? 50,
            tier: existing?.tier ?? 'bronze',
            message: existing ? 'Passport already active.' : 'PiTrust Passport minted! Score engine will update your score within 4 hours.',
        });
    } catch (err) {
        console.error('Complete mint error:', err);
        res.status(500).json({ error: 'Failed to complete passport mint' });
    }
});







