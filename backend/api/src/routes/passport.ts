import { Router, Request, Response } from 'express';
import { piAuthMiddleware } from '../middleware/auth';
import { query, queryOne } from '../db/client';
import { CONTRACTS, invokeContract, isPassportMinted } from '../stellar/contracts';
import { approveMintPayment, completePayment, getPayment } from '../services/payment';
import { Address } from '@stellar/stellar-sdk';
import { z } from 'zod';

export const passportRouter = Router();

// ── GET /api/passport/:wallet ─────────────────────────────────────────────────
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
            score: number;
            tier: string;
            score_frozen: boolean;
            completed_trades: number;
            disputed_trades: number;
            minted_at: string;
            last_score_update: string;
        }>(
            `SELECT wallet_address, score, tier, score_frozen,
              completed_trades, disputed_trades, minted_at, last_score_update
       FROM passports WHERE wallet_address = $1`,
            [walletAddress]
        );

        if (!passport) {
            res.status(404).json({ error: 'Passport not found' });
            return;
        }

        // Attach red flags
        const red_flags = await query<{
            flag_type: string;
            score_impact: number;
            issued_at: string;
        }>(
            `SELECT flag_type, score_impact, issued_at FROM red_flags
       WHERE wallet_address = $1 ORDER BY issued_at DESC LIMIT 10`,
            [walletAddress]
        );

        // Attach active social attestations
        const social = await query<{ platform: string; attested_at: string }>(
            `SELECT platform, attested_at FROM social_attestations
       WHERE wallet_address = $1 AND active = TRUE`,
            [walletAddress]
        );

        res.json({
            ...passport,
            red_flags,
            verified_social: social,
        });
    } catch (err) {
        console.error('GET /passport error:', err);
        res.status(500).json({ error: 'Failed to fetch passport' });
    }
});

// ── POST /api/passport/approve-mint ──────────────────────────────────────────
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
        // Check if passport already minted
        const existing = await queryOne(
            'SELECT id FROM passports WHERE pi_uid = $1',
            [piUser.uid]
        );
        if (existing) {
            res.status(409).json({ error: 'Passport already minted for this Pioneer' });
            return;
        }

        await approveMintPayment(paymentId, piUser.uid);
        res.json({ approved: true, message: 'Payment approved. Awaiting blockchain confirmation.' });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Approval failed';
        res.status(422).json({ error: message });
    }
});

// ── POST /api/passport/complete-mint ─────────────────────────────────────────
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
        // Verify payment
        const payment = await getPayment(paymentId);
        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed on ledger' });
            return;
        }

        await completePayment(paymentId, txId);

        // Record passport in DB
        await query(
            `INSERT INTO passports (wallet_address, pi_uid, minted_at, score, tier)
       VALUES ($1, $2, NOW(), 50, 'bronze')
       ON CONFLICT (wallet_address) DO NOTHING`,
            [payment.from_address, piUser.uid]
        );

        // Invoke Soroban contract to mint
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

        res.json({
            success: true,
            wallet: payment.from_address,
            score: 50,
            tier: 'bronze',
            message: '🎉 PiTrust Passport minted! Score engine will update your score within 4 hours.',
        });
    } catch (err) {
        console.error('Complete mint error:', err);
        res.status(500).json({ error: 'Failed to complete passport mint' });
    }
});
