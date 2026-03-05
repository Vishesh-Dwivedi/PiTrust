/**
 * usePiPayment — wraps Pi SDK createPayment with state management.
 * Only simulates payments in explicit dev mode (VITE_DEV_MODE=true).
 * In Pi Sandbox / production, always uses the real Pi SDK.
 */
import { useState, useCallback } from 'react';
import type { PiPaymentData, PiPaymentCallbacks } from '../utils/piTypes';

const EXPLICIT_DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

type PaymentState = 'idle' | 'awaiting_approval' | 'processing' | 'completed' | 'cancelled' | 'error';

export function usePiPayment(accessToken?: string) {
    const [state, setState] = useState<PaymentState>('idle');
    const [txId, setTxId] = useState<string | null>(null);
    const [paymentId, setPaymentId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const pay = useCallback(async (
        data: PiPaymentData,
        onApproved?: (id: string) => Promise<void>,
        onCompleted?: (id: string, txid: string) => Promise<void>
    ) => {
        setState('awaiting_approval');
        setError(null);

        const sdk = window.Pi;

        // ── Only simulate in EXPLICIT dev mode ────────────────────────────────
        if (!sdk) {
            if (EXPLICIT_DEV_MODE) {
                console.warn('[PiPayment] VITE_DEV_MODE — simulating payment');
                const mockId = `mock_pay_${Date.now()}`;
                setState('processing');
                if (onApproved) await onApproved(mockId);
                setTxId('mock_tx_abcdef123456');
                setState('completed');
                if (onCompleted) await onCompleted(mockId, 'mock_tx_abcdef123456');
                return;
            }
            // Not dev mode and no SDK — real error
            setState('error');
            setError('Pi Browser is required to make payments. Please open this app in the Pi Browser.');
            return;
        }

        // ── Production: use real Pi SDK ───────────────────────────────────────
        const paymentType = data.metadata?.type as string;
        let approveRoute = '/api/payments/approve';
        let completeRoute = '/api/payments/complete';

        if (paymentType === 'vouch_stake') {
            approveRoute = '/api/vouch/approve';
            completeRoute = '/api/vouch/complete';
        } else if (paymentType === 'dispute_filing') {
            approveRoute = '/api/dispute/file';
            completeRoute = '/api/dispute/complete';
        } else if (paymentType === 'passport_mint') {
            approveRoute = '/api/passport/approve-mint';
            completeRoute = '/api/passport/complete-mint';
        }

        const callbacks: PiPaymentCallbacks = {
            onReadyForServerApproval: async (pid) => {
                setPaymentId(pid);
                setState('processing');
                try {
                    const bodyPayload: any = { paymentId: pid };
                    if (paymentType === 'vouch_stake') {
                        bodyPayload.targetWallet = data.metadata?.target;
                    } else if (paymentType === 'dispute_filing') {
                        bodyPayload.defendant_wallet = data.metadata?.target;
                        bodyPayload.evidence_hash = data.metadata?.evidence;
                    }

                    const res = await fetch(approveRoute, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${accessToken || ''}`
                        },
                        body: JSON.stringify(bodyPayload),
                    });
                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({}));
                        throw new Error(errData.error || `Server approval failed (${res.status})`);
                    }
                    if (onApproved) await onApproved(pid);
                } catch (e) {
                    console.error('[PiPayment] Approval error:', e);
                    setError(e instanceof Error ? e.message : 'Server approval failed');
                    setState('error');
                    throw e; // Let Pi SDK know approval failed
                }
            },
            onReadyForServerCompletion: async (pid, txid) => {
                setTxId(txid);
                try {
                    const bodyPayload: any = { paymentId: pid, txId: txid };
                    if (paymentType === 'vouch_stake') {
                        bodyPayload.targetWallet = data.metadata?.target;
                    } else if (paymentType === 'dispute_filing') {
                        bodyPayload.defendant_wallet = data.metadata?.target;
                        bodyPayload.evidence_hash = data.metadata?.evidence;
                    }

                    const res = await fetch(completeRoute, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${accessToken || ''}`
                        },
                        body: JSON.stringify(bodyPayload),
                    });
                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({}));
                        throw new Error(errData.error || `Server completion failed (${res.status})`);
                    }
                    setState('completed');
                    if (onCompleted) await onCompleted(pid, txid);
                } catch (e) {
                    console.error('[PiPayment] Completion error:', e);
                    setError(e instanceof Error ? e.message : 'Server completion failed');
                    setState('error');
                    throw e; // Let Pi SDK know completion failed
                }
            },
            onCancel: () => {
                setState('cancelled');
                setPaymentId(null);
            },
            onError: (err) => {
                setState('error');
                setError(err.message);
            },
        };

        sdk.createPayment(data, callbacks);
    }, [accessToken]);

    const reset = useCallback(() => {
        setState('idle');
        setTxId(null);
        setPaymentId(null);
        setError(null);
    }, []);

    return { state, txId, paymentId, error, pay, reset };
}
