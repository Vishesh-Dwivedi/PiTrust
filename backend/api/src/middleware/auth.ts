import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { queryOne } from '../db/client';

const PI_API_BASE = process.env.PI_API_BASE || 'https://api.minepi.com';

export interface PiUser {
    uid: string;
    username: string;
    wallet_address?: string;
    credentials?: {
        scopes: string[];
    };
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            piUser?: PiUser;
        }
    }
}

/**
 * Verify the Pi Network access token via /v2/me endpoint.
 * Attaches the verified PiUser to req.piUser.
 */
export async function piAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing Pi token' });
        return;
    }

    const token = authHeader.substring(7);

    try {
        const response = await axios.get<PiUser>(`${PI_API_BASE}/v2/me`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
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
        if (axios.isAxiosError(err)) {
            if (err.response?.status === 401) {
                res.status(401).json({ error: 'Pi token expired or invalid' });
                return;
            }
        }
        console.error('Pi auth error:', err);
        res.status(502).json({ error: 'Pi auth service unavailable' });
    }
}

/**
 * Optional auth — does not fail the request if no token present.
 * Useful for public endpoints that enhance with user context.
 */
export async function optionalPiAuth(
    req: Request,
    _res: Response,
    next: NextFunction
): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        next();
        return;
    }

    const token = authHeader.substring(7);
    try {
        const response = await axios.get<PiUser>(`${PI_API_BASE}/v2/me`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 3000,
        });
        req.piUser = response.data;
    } catch {
        // Silent fail — public endpoint
    }
    next();
}

/**
 * B2B API key authentication. Validates against api_keys table.
 */
export async function b2bApiKeyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
        res.status(401).json({ error: 'Missing X-API-Key header' });
        return;
    }

    // Prefix check (fast path before DB)
    if (!apiKey.startsWith('pit_')) {
        res.status(401).json({ error: 'Invalid API key format' });
        return;
    }

    try {
        const keyRecord = await queryOne<{
            id: string;
            developer_uid: string;
            tier: string;
            monthly_limit: number;
            calls_this_month: number;
            active: boolean;
        }>(
            `SELECT id, developer_uid, tier, monthly_limit, calls_this_month, active
       FROM api_keys WHERE api_key = $1`,
            [apiKey]
        );

        if (!keyRecord || !keyRecord.active) {
            res.status(401).json({ error: 'Invalid or inactive API key' });
            return;
        }

        if (keyRecord.calls_this_month >= keyRecord.monthly_limit) {
            res.status(429).json({
                error: 'Monthly API quota exceeded',
                limit: keyRecord.monthly_limit,
                used: keyRecord.calls_this_month,
            });
            return;
        }

        // Increment call counter (async — don't await to preserve latency)
        queryOne(
            `UPDATE api_keys SET calls_this_month = calls_this_month + 1, 
       total_calls = total_calls + 1, last_used_at = NOW()
       WHERE id = $1`,
            [keyRecord.id]
        ).catch(console.error);

        (req as Request & { apiKeyRecord?: typeof keyRecord }).apiKeyRecord = keyRecord;
        next();
    } catch (err) {
        console.error('B2B auth error:', err);
        res.status(500).json({ error: 'Auth check failed' });
    }
}
