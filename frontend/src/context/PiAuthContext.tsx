/**
 * PiAuthContext wraps the window.Pi SDK authentication flow.
 */
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from 'react';
import type { PiUser, PiAuthResult } from '../utils/piTypes';

const DEV_USER: PiUser = {
    uid: 'dev_uid_001',
    username: 'pioneer_dev',
    wallet_address: 'GDEV1234MOCK5678ABCD',
};

const EXPLICIT_DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';
const SDK_TIMEOUT_MS = 4000;
const PUBLIC_ROUTE_PREFIXES = ['/trust/'];

interface PiAuthState {
    user: PiUser | null;
    accessToken: string | null;
    loading: boolean;
    error: string | null;
    sdkReady: boolean;
    isDevMode: boolean;
    authenticate: () => Promise<void>;
    logout: () => void;
}

const PiAuthContext = createContext<PiAuthState | null>(null);

function isPublicTrustRoute() {
    if (typeof window === 'undefined') return false;
    return PUBLIC_ROUTE_PREFIXES.some((prefix) => window.location.pathname.startsWith(prefix));
}

export function PiAuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<PiUser | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sdkReady, setSdkReady] = useState(false);
    const [isDevMode, setIsDevMode] = useState(false);

    useEffect(() => {
        if (isPublicTrustRoute()) {
            setLoading(false);
            setError(null);
            setSdkReady(false);
            return;
        }

        if (EXPLICIT_DEV_MODE) {
            console.log('[PiAuth] VITE_DEV_MODE=true - entering dev mode');
            setIsDevMode(true);
            setUser(DEV_USER);
            setAccessToken('mock_token_dev');
            setLoading(false);
            return;
        }

        if (window.Pi) {
            console.log('[PiAuth] SDK already available on window.Pi');
            setSdkReady(true);
            return;
        }

        const handleSdkReady = () => {
            console.log('[PiAuth] Received pi-sdk-ready event');
            setSdkReady(true);
        };
        window.addEventListener('pi-sdk-ready', handleSdkReady);

        const pollInterval = setInterval(() => {
            if (window.Pi) {
                console.log('[PiAuth] SDK detected via polling');
                setSdkReady(true);
                clearInterval(pollInterval);
            }
        }, 200);

        const timeout = setTimeout(() => {
            if (!window.Pi) {
                console.warn(`[PiAuth] Pi SDK did not load within ${SDK_TIMEOUT_MS}ms`);
                setIsDevMode(true);
                setUser(DEV_USER);
                setAccessToken('mock_token_dev');
                setLoading(false);
                clearInterval(pollInterval);
            }
        }, SDK_TIMEOUT_MS);

        return () => {
            window.removeEventListener('pi-sdk-ready', handleSdkReady);
            clearTimeout(timeout);
            clearInterval(pollInterval);
        };
    }, []);

    const authenticate = useCallback(async () => {
        if (isPublicTrustRoute()) {
            setLoading(false);
            return;
        }

        const sdk = window.Pi;
        if (!sdk) {
            if (EXPLICIT_DEV_MODE || isDevMode) {
                setUser(DEV_USER);
                setAccessToken('mock_token_dev');
                setLoading(false);
                return;
            }
            setError('Pi Browser is required. Open this app inside the Pi Browser.');
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const onIncompletePaymentFound = async (payment: any) => {
                console.log('[PiAuth] Incomplete payment found:', payment?.identifier);
                try {
                    if (!payment?.status?.developer_completed) {
                        await fetch('/api/payments/incomplete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                paymentId: payment.identifier,
                                txId: payment?.transaction?.txid || '',
                            }),
                        });
                        console.log('[PiAuth] Processed incomplete payment:', payment.identifier);
                    } else {
                        console.log('[PiAuth] Skipping incomplete payment (no txid):', payment?.identifier);
                    }
                } catch (err) {
                    console.error('[PiAuth] Error handling incomplete payment:', err);
                }
            };

            const authResult = await sdk.authenticate(
                ['username', 'payments'],
                onIncompletePaymentFound
            ) as PiAuthResult;

            if (!authResult?.user?.uid && !authResult?.accessToken) {
                console.warn('[PiAuth] authenticate() returned invalid result:', authResult);
                setUser(null);
                setLoading(false);
                return;
            }

            let safeUser: PiUser = {
                uid: authResult.user?.uid || 'unknown',
                username: authResult.user?.username || 'pioneer',
                wallet_address: authResult.user?.wallet_address,
            };

            try {
                const verifyRes = await fetch('/api/auth/me', {
                    headers: { Authorization: `Bearer ${authResult.accessToken}` },
                });
                if (verifyRes.ok) {
                    const verified = await verifyRes.json();
                    if (verified.username) safeUser.username = verified.username;
                    if (verified.uid) safeUser.uid = verified.uid;
                    if (verified.wallet_address) safeUser.wallet_address = verified.wallet_address;
                    console.log('[PiAuth] Fetched verified Pi profile:', safeUser.username);
                } else {
                    const text = await verifyRes.text();
                    console.warn('[PiAuth] Backend auth verification failed:', verifyRes.status, text);
                    throw new Error(`Backend verification rejected token: ${verifyRes.status} - ${text}`);
                }
            } catch (err: any) {
                console.error('[PiAuth] Failed to fetch verified user profile', err);
                throw new Error(`Auth verification failed: ${err.message}`);
            }

            console.log('[PiAuth] Authentication successful:', safeUser.username);
            setUser(safeUser);
            setAccessToken(authResult.accessToken);
        } catch (err: any) {
            console.error('[PiAuth] Authentication failed:', err);
            setError(err?.message || String(err) || 'Authentication failed. Please try again.');
        } finally {
            setLoading(false);
        }
    }, [isDevMode]);

    const logout = useCallback(() => {
        setUser(null);
        setAccessToken(null);
    }, []);

    useEffect(() => {
        if (sdkReady && !isDevMode) {
            authenticate();
        }
    }, [sdkReady, isDevMode, authenticate]);

    return (
        <PiAuthContext.Provider value={{ user, accessToken, loading, error, sdkReady, isDevMode, authenticate, logout }}>
            {children}
        </PiAuthContext.Provider>
    );
}

export function usePiAuth(): PiAuthState {
    const ctx = useContext(PiAuthContext);
    if (!ctx) throw new Error('usePiAuth must be used inside PiAuthProvider');
    return ctx;
}
