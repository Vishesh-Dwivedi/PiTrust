import { Router, Request, Response } from 'express';
import { piAuthMiddleware } from '../middleware/auth';
import { query, queryOne } from '../db/client';
import { approvePayment, completePayment, getPayment } from '../services/payment';
import { z } from 'zod';

export const authRouter = Router();

/**
 * POST /api/auth/pi-signin
 * Called after frontend Pi.authenticate() succeeds.
 * Validates the access token, returns user info + passport status.
 */
const SignInSchema = z.object({
    accessToken: z.string().min(20),
});

authRouter.post('/pi-signin', async (req: Request, res: Response) => {
    const parse = SignInSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json({ error: parse.error.flatten() });
        return;
    }

    // Temporarily set the auth header so piAuthMiddleware can validate
    req.headers.authorization = `Bearer ${parse.data.accessToken}`;

    try {
        // Import the auth function directly to validate
        const { default: axios } = await import('axios');
        const PI_API_BASE = process.env.PI_API_BASE || 'https://api.minepi.com';
        const response = await axios.get(`${PI_API_BASE}/v2/me`, {
            headers: { Authorization: `Bearer ${parse.data.accessToken}` },
            timeout: 5000,
        });
        const piUser = response.data;

        // Check if passport exists
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
    } catch (err) {
        console.error('Pi sign-in error:', err);
        res.status(401).json({ error: 'Invalid Pi token' });
    }
});
