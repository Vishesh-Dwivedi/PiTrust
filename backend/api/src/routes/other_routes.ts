import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/client';
import { optionalPiAuth, piAuthMiddleware } from '../middleware/auth';
import { z } from 'zod';
import { CONTRACTS, invokeContract } from '../stellar/contracts';
import { nativeToScVal, Address } from '@stellar/stellar-sdk';
import { approvePayment, completePayment, getPayment } from '../services/payment';

export const vouchRouter = Router();

// GET /api/vouch/:wallet — get all vouches for a wallet
vouchRouter.get('/:wallet', async (req: Request, res: Response) => {
    const { wallet } = req.params;
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
});

// POST /api/vouch/approve
vouchRouter.post('/approve', piAuthMiddleware, async (req: Request, res: Response) => {
    const { paymentId, targetWallet } = req.body;
    if (!paymentId || !targetWallet) {
        res.status(400).json({ error: 'Missing paymentId or targetWallet' });
        return;
    }
    const piUser = req.piUser!;

    const voucher = await queryOne<{ wallet_address: string }>(
        'SELECT wallet_address FROM passports WHERE pi_uid = $1', [piUser.uid]
    );
    if (!voucher) {
        res.status(403).json({ error: 'No passport found. Mint one first.' });
        return;
    }

    try {
        await approvePayment(paymentId);
        res.json({ approved: true });
    } catch (err: any) {
        res.status(422).json({ error: err.message || 'Payment approval failed' });
    }
});

// POST /api/vouch/complete
vouchRouter.post('/complete', piAuthMiddleware, async (req: Request, res: Response) => {
    const { paymentId, txId, targetWallet } = req.body;
    if (!paymentId || !txId || !targetWallet) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    const piUser = req.piUser!;

    try {
        const payment = await getPayment(paymentId);
        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed on ledger' });
            return;
        }
        await completePayment(paymentId, txId);

        await query(
            `INSERT INTO vouch_events (voucher_wallet, vouchee_wallet, gross_amount_pi, net_amount_pi, status, staked_at)
             VALUES ($1, $2, $3, $4, 'active', NOW())`,
            [payment.from_address, targetWallet, payment.amount, payment.amount * 0.98]
        );

        try {
            await invokeContract({
                contractId: CONTRACTS.vouchEscrow,
                method: 'stake',
                args: [
                    new Address(payment.from_address).toScVal(),
                    new Address(targetWallet).toScVal(),
                    nativeToScVal(Math.floor(payment.amount * 0.98 * 10000000), { type: 'i128' })
                ]
            });
        } catch (contractErr) {
            console.error('Contract stake invocation failed:', contractErr);
        }

        res.json({ success: true, message: 'Vouch successfully recorded.' });
    } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to complete vouch' });
    }
});

export const disputeRouter = Router();

// GET /api/dispute — list active disputes
disputeRouter.get('/', async (req: Request, res: Response) => {
    const disputes = await query<{
        dispute_id: number;
        claimant_wallet: string;
        defendant_wallet: string;
        status: string;
        filed_at: string;
        voting_deadline: string;
        evidence_url: string;
    }>(
        'SELECT id as dispute_id, claimant_wallet, defendant_wallet, status, filed_at, voting_deadline, evidence_url FROM disputes ORDER BY filed_at DESC LIMIT 50'
    );
    res.json(disputes);
});

// GET /api/dispute/:id
disputeRouter.get('/:id', async (req: Request, res: Response) => {
    const dispute = await queryOne<{
        dispute_id: number;
        claimant_wallet: string;
        defendant_wallet: string;
        status: string;
        filed_at: string;
        voting_deadline: string;
    }>(
        'SELECT dispute_id, claimant_wallet, defendant_wallet, status, filed_at, voting_deadline FROM disputes WHERE id = $1',
        [req.params.id]
    );
    if (!dispute) { res.status(404).json({ error: 'Dispute not found' }); return; }
    res.json(dispute);
});

// POST /api/dispute/file — file a new dispute (Pi payment for filing fee)
disputeRouter.post('/file', piAuthMiddleware, async (req: Request, res: Response) => {
    const { defendant_wallet, evidence_hash, paymentId } = req.body;
    if (!defendant_wallet || !evidence_hash || !paymentId) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    const piUser = req.piUser!;

    try {
        const claimant = await queryOne<{ wallet_address: string }>(
            'SELECT wallet_address FROM passports WHERE pi_uid = $1', [piUser.uid]
        );
        if (!claimant) { res.status(403).json({ error: 'No passport found. Mint one first.' }); return; }

        await approvePayment(paymentId);
        res.json({ status: 'payment_approved', message: 'Complete payment in Pi Browser to file dispute.' });
    } catch (err: any) {
        res.status(422).json({ error: err.message || 'Payment approval failed' });
    }
});

// POST /api/dispute/complete
disputeRouter.post('/complete', piAuthMiddleware, async (req: Request, res: Response) => {
    const { paymentId, txId, defendant_wallet, evidence_hash } = req.body;
    if (!paymentId || !txId || !defendant_wallet || !evidence_hash) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    const piUser = req.piUser!;

    try {
        const payment = await getPayment(paymentId);
        if (!payment.status.transaction_verified) {
            res.status(422).json({ error: 'Transaction not yet confirmed on ledger' });
            return;
        }
        await completePayment(paymentId, txId);

        await query(
            `INSERT INTO disputes (claimant_wallet, defendant_wallet, status, filed_at, voting_deadline, evidence_url)
             VALUES ($1, $2, 'filed', NOW(), NOW() + INTERVAL '3 days', $3)`,
            [payment.from_address, defendant_wallet, evidence_hash]
        );

        try {
            await invokeContract({
                contractId: CONTRACTS.disputeRegistry,
                method: 'file_dispute',
                args: [
                    new Address(payment.from_address).toScVal(),
                    new Address(defendant_wallet).toScVal(),
                    nativeToScVal(evidence_hash, { type: 'string' })
                ]
            });
        } catch (contractErr) {
            console.error('Contract file_dispute failed:', contractErr);
        }

        res.json({ success: true, message: 'Dispute actively filed.' });
    } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to complete dispute' });
    }
});

export const scoreRouter = Router();

// GET /api/score/:wallet
scoreRouter.get('/:wallet', async (req: Request, res: Response) => {
    const passport = await queryOne<{ score: number; tier: string; last_score_update: string }>(
        'SELECT score, tier, last_score_update FROM passports WHERE wallet_address = $1',
        [req.params.wallet]
    );
    res.json(passport ?? { score: 0, tier: 'unverified', last_score_update: null });
});

export const merchantRouter = Router();

// GET /api/merchant — list active merchants (paginated)
merchantRouter.get('/', async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string || '1');
    const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);
    const offset = (page - 1) * limit;
    const { category } = req.query;

    let whereClause = "WHERE m.status = 'active'";
    const params: (string | number)[] = [limit, offset];
    if (category) {
        whereClause += ` AND m.category = $${params.length + 1}`;
        params.push(category as string);
    }

    const merchants = await query<{
        wallet_address: string;
        display_name: string;
        category: string;
        registered_at: string;
    }>(
        `SELECT wallet_address, display_name, category, registered_at
     FROM merchants ${whereClause} ORDER BY registered_at DESC LIMIT $1 OFFSET $2`,
        params
    );
    res.json({ merchants, page, limit });
});

export const tradeRouter = Router();

// GET /api/trade/:trade_id — get trade info
tradeRouter.get('/:id', async (req: Request, res: Response) => {
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
