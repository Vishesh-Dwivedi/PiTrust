/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Pi Network SDK Type Definitions
 * window.Pi is injected by the Pi Browser SDK
 */

export interface PiUser {
    uid: string;
    username: string;
    wallet_address?: string;
    credentials?: {
        scopes: string[];
        valid_until: { timestamp: number; iso8601: string };
    };
}

export interface PiAuthResult {
    accessToken: string;
    user: PiUser;
}

export interface PiPaymentData {
    amount: number;
    memo: string;
    metadata: Record<string, unknown>;
}

export type PiPaymentStatus =
    | 'pending'
    | 'payment_approved'
    | 'payment_completed'
    | 'payment_cancelled'
    | 'developer_approved'
    | 'developer_completed';

export interface PiPayment {
    identifier: string;
    user_uid: string;
    amount: number;
    memo: string;
    metadata: Record<string, unknown>;
    status: { [K in PiPaymentStatus]?: boolean };
    transaction?: {
        txid: string;
        verified: boolean;
        _link: string;
    };
    created_at: string;
}

export interface PiPaymentCallbacks {
    onReadyForServerApproval: (paymentId: string) => void;
    onReadyForServerCompletion: (paymentId: string, txid: string) => void;
    onCancel: (paymentId: string) => void;
    onError: (error: Error, payment?: PiPayment) => void;
}

export interface PiSDK {
    init: (config: { version: string; sandbox: boolean }) => void;
    authenticate: (
        scopes: string[],
        onIncompletePaymentFound: (payment: PiPayment) => void
    ) => Promise<PiAuthResult>;
    createPayment: (
        paymentData: PiPaymentData,
        callbacks: PiPaymentCallbacks
    ) => void;
    openShareDialog: (title: string, message: string) => void;
}

declare global {
    interface Window {
        Pi: PiSDK;
    }
}
