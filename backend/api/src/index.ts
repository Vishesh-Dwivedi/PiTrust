import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.NODE_ENV === 'testnet' ? '.env.testnet' : '.env' });

import { passportRouter } from './routes/passport';
import { vouchRouter, disputeRouter, scoreRouter, merchantRouter, tradeRouter } from './routes/other_routes';
import { b2bRouter } from './routes/b2b';
import { authRouter } from './routes/auth';
import { pool } from './db/client';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
    origin: [
        'https://sandbox.minepi.com',
        'https://app.pitrust.io',
        'http://localhost:3001',
        'http://localhost:3000',
    ],
    credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// ── Request logging ───────────────────────────────────────────────────────────
app.use(pinoHttp({ level: process.env.LOG_LEVEL || 'info' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Stricter limiter for write operations
const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Rate limit exceeded for write operations.' },
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/passport', passportRouter);
app.use('/api/vouch', writeLimiter, vouchRouter);
app.use('/api/dispute', writeLimiter, disputeRouter);
app.use('/api/score', scoreRouter);
app.use('/api/merchant', merchantRouter);
app.use('/api/trade', tradeRouter);
app.use('/v1', b2bRouter);      // B2B API — separate versioned namespace

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'ok',
            network: process.env.STELLAR_NETWORK || 'testnet',
            timestamp: new Date().toISOString(),
        });
    } catch {
        res.status(503).json({ status: 'error', message: 'DB unavailable' });
    }
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 PiTrust API running on http://localhost:${PORT}`);
    console.log(`📡 Network: ${process.env.STELLAR_NETWORK || 'testnet'}`);
});

export default app;
