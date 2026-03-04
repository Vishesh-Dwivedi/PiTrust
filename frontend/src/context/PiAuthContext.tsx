/**
 * PiAuthContext — wraps window.Pi SDK authentication.
 * 
 * Pi SDK Reference (from official docs):
 *   Pi.init({ version: "2.0", sandbox: true })
 *   Pi.authenticate(scopes: string[], onIncompletePaymentFound: Function) => Promise<AuthResult>
 *   
 *   AuthResult = { accessToken: string, user: { uid, username } }
 *   scopes: ['payments'] is the standard scope for apps that handle payments
 *   onIncompletePaymentFound: callback that receives a payment object for any incomplete payment
 */
import {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
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

export function PiAuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<PiUser | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sdkReady, setSdkReady] = useState(false);
    const [isDevMode, setIsDevMode] = useState(false);

    // ── Wait for the Pi SDK ──────────────────────────────────────────────────
    useEffect(() => {
        // If explicitly in dev mode, skip SDK entirely
        if (EXPLICIT_DEV_MODE) {
            console.log('[PiAuth] VITE_DEV_MODE=true — entering dev mode');
            setIsDevMode(true);
            setUser(DEV_USER);
            setAccessToken('mock_token_dev');
            setLoading(false);
            return;
        }

        // Check if SDK is already available (fast path)
        if (window.Pi) {
            console.log('[PiAuth] SDK already available on window.Pi');
            setSdkReady(true);
            return;
        }

        // Listen for the custom event from index.html's onload handler
        const handleSdkReady = () => {
            console.log('[PiAuth] Received pi-sdk-ready event');
            setSdkReady(true);
        };
        window.addEventListener('pi-sdk-ready', handleSdkReady);

        // Also poll for it — some Pi Browser versions may not fire events properly
        const pollInterval = setInterval(() => {
            if (window.Pi) {
                console.log('[PiAuth] SDK detected via polling');
                setSdkReady(true);
                clearInterval(pollInterval);
            }
        }, 200);

        // Timeout: if SDK doesn't load, enter dev mode (not in Pi Browser)
        const timeout = setTimeout(() => {
            if (!window.Pi) {
                console.warn(`[PiAuth] Pi SDK did not load within ${SDK_TIMEOUT_MS}ms — not in Pi Browser`);
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

    // ── Authenticate once SDK is ready ───────────────────────────────────────
    const authenticate = useCallback(async () => {
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
            // Pi SDK authenticate:
            //   scopes: ['payments'] — request payment permission
            //   onIncompletePaymentFound: required callback for handling incomplete payments
            const onIncompletePaymentFound = (payment: any) => {
                console.log('[PiAuth] Incomplete payment found:', payment);
                // For now, just log it. In production, you'd complete or cancel it.
            };

            const result: PiAuthResult = await sdk.authenticate(
                ['payments'],
                onIncompletePaymentFound
            );

            console.log('[PiAuth] Authentication successful:', result.user.username);
            setUser(result.user);
            setAccessToken(result.accessToken);
        } catch (err: any) {
            console.error('[PiAuth] Authentication failed:', err);
            setError(err?.message || 'Authentication failed. Please try again.');
        } finally {
            setLoading(false);
        }
    }, [isDevMode]);

    const logout = useCallback(() => {
        setUser(null);
        setAccessToken(null);
    }, []);

    // Auto-authenticate when SDK becomes ready
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
