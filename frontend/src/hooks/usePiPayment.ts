/**
 * usePiPayment — wraps Pi SDK createPayment with state management
 */
import { useState, useCallback } from 'react';
import type { PiPaymentData, PiPaymentCallbacks } from '../utils/piTypes';

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
        if (!sdk) {
            // Dev mock: simulate successful payment
            console.warn('[PiPayment] Dev mode — simulating payment success');
            const mockId = `mock_pay_${Date.now()}`;
            setState('processing');
            if (onApproved) await onApproved(mockId);
            setTxId('mock_tx_abcdef123456');
            setState('completed');
            if (onCompleted) await onCompleted(mockId, 'mock_tx_abcdef123456');
            return;
        }

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
                    // Include any required body payload depending on the type
                    const bodyPayload: any = { paymentId: pid };
                    if (paymentType === 'vouch_stake') {
                        bodyPayload.targetWallet = data.metadata?.target;
                    } else if (paymentType === 'dispute_filing') {
                        bodyPayload.defendant_wallet = data.metadata?.target;
                        bodyPayload.evidence_hash = data.metadata?.evidence;
                    }

                    await fetch(approveRoute, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${accessToken || ''}`
                        },
                        body: JSON.stringify(bodyPayload),
                    });
                    if (onApproved) await onApproved(pid);
                } catch (e) {
                    setError('Server approval failed');
                    setState('error');
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

                    await fetch(completeRoute, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${accessToken || ''}`
                        },
                        body: JSON.stringify(bodyPayload),
                    });
                    setState('completed');
                    if (onCompleted) await onCompleted(pid, txid);
                } catch (e) {
                    setError('Server completion failed');
                    setState('error');
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
    }, []);

    const reset = useCallback(() => {
        setState('idle');
        setTxId(null);
        setPaymentId(null);
        setError(null);
    }, []);

    return { state, txId, paymentId, error, pay, reset };
}
