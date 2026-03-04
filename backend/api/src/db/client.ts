import { Pool } from 'pg';

const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'mainnet';

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://pitrust:pitrust_dev@localhost:5432/pitrust_testnet',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

export async function query<T extends object>(
    text: string,
    params?: unknown[]
): Promise<T[]> {
    const result = await pool.query<T>(text, params);
    return result.rows;
}

export async function queryOne<T extends object>(
    text: string,
    params?: unknown[]
): Promise<T | null> {
    const result = await pool.query<T>(text, params);
    return result.rows[0] ?? null;
}
