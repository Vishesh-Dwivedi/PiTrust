/**
 * usePiPayment wraps Pi SDK createPayment with state management.
 * Only simulates payments in explicit dev mode (VITE_DEV_MODE=true).
 * In Pi Sandbox / production, it always uses the real Pi SDK.
 */
import { useState, useCallback } from 'react';
import type { PiPaymentData, PiPaymentCallbacks } from '../utils/piTypes';

const EXPLICIT_DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

type PaymentState = 'idle' | 'awaiting_approval' | 'processing' | 'completed' | 'cancelled' | 'error';

type MerchantRegistrationMetadata = {
    type: 'merchant_registration';
    display_name: string;
    category: string;
    description?: string;
    location?: string;
};

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

        if (!sdk) {
            if (EXPLICIT_DEV_MODE) {
                console.warn('[PiPayment] VITE_DEV_MODE - simulating payment');
                const mockId = `mock_pay_${Date.now()}`;
                setState('processing');
                if (onApproved) await onApproved(mockId);
                setTxId('mock_tx_abcdef123456');
                setState('completed');
                if (onCompleted) await onCompleted(mockId, 'mock_tx_abcdef123456');
                return;
            }
            setState('error');
            setError('Pi Browser is required to make payments. Please open this app in the Pi Browser.');
            return;
        }

        const paymentType = data.metadata?.type as string;

        // Vercel 301 Edge Redirects destroy POST payloads. Force www subdomain for API calls if accessed via apex domain.
        const isBareDomain = window.location.origin === 'https://trustpi.space';
        const baseUrl = isBareDomain ? 'https://www.trustpi.space' : window.location.origin;

        let approveRoute = `${baseUrl}/api/payments/approve`;
        let completeRoute = `${baseUrl}/api/payments/complete`;

        if (paymentType === 'vouch_stake') {
            approveRoute = `${baseUrl}/api/vouch/approve`;
            completeRoute = `${baseUrl}/api/vouch/complete`;
        } else if (paymentType === 'dispute_filing') {
            approveRoute = `${baseUrl}/api/dispute/file`;
            completeRoute = `${baseUrl}/api/dispute/complete`;
        } else if (paymentType === 'passport_mint') {
            approveRoute = `${baseUrl}/api/passport/approve-mint`;
            completeRoute = `${baseUrl}/api/passport/complete-mint`;
        } else if (paymentType === 'merchant_registration') {
            approveRoute = `${baseUrl}/api/merchant/approve-register`;
            completeRoute = `${baseUrl}/api/merchant/complete-register`;
        }

        const callbacks: PiPaymentCallbacks = {
            onReadyForServerApproval: async (pid) => {
                setPaymentId(pid);
                setState('processing');
                try {
                    const bodyPayload: Record<string, unknown> = { paymentId: pid };
                    if (paymentType === 'vouch_stake') {
                        bodyPayload.targetWallet = data.metadata?.target;
                    } else if (paymentType === 'dispute_filing') {
                        bodyPayload.defendant_wallet = data.metadata?.target;
                        bodyPayload.evidence_hash = data.metadata?.evidence;
                    } else if (paymentType === 'merchant_registration') {
                        const merchantData = data.metadata as MerchantRegistrationMetadata;
                        bodyPayload.display_name = merchantData.display_name;
                        bodyPayload.category = merchantData.category;
                        bodyPayload.description = merchantData.description || '';
                        bodyPayload.location = merchantData.location || '';
                    }

                    const res = await fetch(approveRoute, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${accessToken || ''}`,
                        },
                        body: JSON.stringify(bodyPayload),
                    });
                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({}));
                        throw new Error(errData.error || `Server approval failed (${res.status})`);
                    }
                    if (onApproved) await onApproved(pid);
                } catch (e: any) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.error('[PiPayment] Approval error:', e);
                    alert(`[PiPayment Debug] Backend failed to approve: ${msg}`);
                    setError(msg);
                    setState('error');
                    throw e;
                }
            },
            onReadyForServerCompletion: async (pid, txid) => {
                setTxId(txid);
                try {
                    const bodyPayload: Record<string, unknown> = { paymentId: pid, txId: txid };
                    if (paymentType === 'vouch_stake') {
                        bodyPayload.targetWallet = data.metadata?.target;
                    } else if (paymentType === 'dispute_filing') {
                        bodyPayload.defendant_wallet = data.metadata?.target;
                        bodyPayload.evidence_hash = data.metadata?.evidence;
                    } else if (paymentType === 'merchant_registration') {
                        const merchantData = data.metadata as MerchantRegistrationMetadata;
                        bodyPayload.display_name = merchantData.display_name;
                        bodyPayload.category = merchantData.category;
                        bodyPayload.description = merchantData.description || '';
                        bodyPayload.location = merchantData.location || '';
                    }

                    const res = await fetch(completeRoute, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${accessToken || ''}`,
                        },
                        body: JSON.stringify(bodyPayload),
                    });
                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({}));
                        throw new Error(errData.error || `Server completion failed (${res.status})`);
                    }
                    setState('completed');
                    if (onCompleted) await onCompleted(pid, txid);
                } catch (e: any) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.error('[PiPayment] Completion error:', e);
                    alert(`[PiPayment Debug] Backend failed to complete: ${msg}`);
                    setError(msg);
                    setState('error');
                    throw e;
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
