/**
 * Pi Platform payment service.
 * Handles the 3-step Pi payment lifecycle:
 *  1. create_payment (frontend → Pi SDK)
 *  2. Approve (backend /approve endpoint — this file)
 *  3. complete_payment (backend /complete endpoint)
 *
 * Reference: https://developers.minepi.com/doc/pi-network-developer-guide
 */

import axios from 'axios';
import { query } from '../db/client';

const PI_API_BASE = process.env.PI_API_BASE || 'https://api.minepi.com';
const PI_API_KEY = process.env.PI_API_KEY || '';

export interface PiPayment {
    identifier: string;
    user_uid: string;
    amount: number;
    memo: string;
    metadata: Record<string, unknown>;
    from_address: string;
    to_address: string;
    transaction: {
        txid: string;
        verified: boolean;
        _link: string;
    } | null;
    status: {
        developer_approved: boolean;
        transaction_verified: boolean;
        developer_completed: boolean;
        cancelled: boolean;
        user_cancelled: boolean;
    };
}

const piHeaders = () => ({
    Authorization: `Key ${PI_API_KEY}`,
    'Content-Type': 'application/json',
});

/**
 * Approve a payment. Called when our backend confirms it's legitimate.
 * This unlocks the user's Pi SDK to prompt the user to sign the transaction.
 */
export async function approvePayment(paymentId: string): Promise<PiPayment> {
    const response = await axios.post<PiPayment>(
        `${PI_API_BASE}/v2/payments/${paymentId}/approve`,
        {},
        { headers: piHeaders(), timeout: 10_000 }
    );
    return response.data;
}

/**
 * Complete a payment. Called after verifying the txid on the Stellar ledger.
 * This releases the Pi from escrow to the app's wallet.
 */
export async function completePayment(
    paymentId: string,
    txId: string
): Promise<PiPayment> {
    const response = await axios.post<PiPayment>(
        `${PI_API_BASE}/v2/payments/${paymentId}/complete`,
        { txid: txId },
        { headers: piHeaders(), timeout: 10_000 }
    );
    return response.data;
}

/**
 * Get a payment by ID.
 */
export async function getPayment(paymentId: string): Promise<PiPayment> {
    const response = await axios.get<PiPayment>(
        `${PI_API_BASE}/v2/payments/${paymentId}`,
        { headers: piHeaders(), timeout: 5_000 }
    );
    return response.data;
}

/**
 * Validate and approve a passport mint payment.
 * Expected amount: 1 Pi, memo: 'pitrust_mint'
 */
export async function approveMintPayment(
    paymentId: string,
    userUid: string
): Promise<PiPayment> {
    const payment = await getPayment(paymentId);

    if (payment.user_uid !== userUid) {
        throw new Error('Payment user_uid mismatch');
    }
    if (payment.amount < 1) {
        throw new Error(`Insufficient mint payment: ${payment.amount} Pi`);
    }
    if (payment.memo !== 'pitrust_mint') {
        throw new Error(`Invalid payment memo: ${payment.memo}`);
    }
    if (payment.status.cancelled || payment.status.user_cancelled) {
        throw new Error('Payment was cancelled');
    }

    return approvePayment(paymentId);
}

/**
 * Look for any incomplete payments on startup (incomplete payment recovery flow).
 */
export async function getIncompletePayments(): Promise<PiPayment[]> {
    try {
        const response = await axios.get<{ data: PiPayment[] }>(
            `${PI_API_BASE}/v2/payments/incomplete_server_payments`,
            { headers: piHeaders(), timeout: 10_000 }
        );
        return response.data.data ?? [];
    } catch (err) {
        console.error('Failed to fetch incomplete payments:', err);
        return [];
    }
}
