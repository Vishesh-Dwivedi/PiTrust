/**
 * PiAuthContext — wraps window.Pi SDK authentication.
 * Waits for the Pi SDK to load (via the 'pi-sdk-ready' event dispatched from index.html)
 * before attempting authentication. Falls back to dev mode ONLY when explicitly
 * running in local dev (VITE_DEV_MODE=true) or after SDK load timeout.
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
import { handleIncompletePayment } from '../utils/helpers';

const DEV_USER: PiUser = {
    uid: 'dev_uid_001',
    username: 'pioneer_dev',
    wallet_address: 'GDEV1234MOCK5678ABCD',
};

const EXPLICIT_DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';
const SDK_TIMEOUT_MS = 5000; // Wait up to 5s for Pi SDK to load

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

    // ── Wait for the Pi SDK to become available ──────────────────────────────
    useEffect(() => {
        // If SDK is already loaded (script loaded before React mounted)
        if (window.Pi && (window as any).__PI_SDK_READY__) {
            console.log('[PiAuth] SDK already available');
            setSdkReady(true);
            return;
        }

        // If explicitly in dev mode, skip waiting
        if (EXPLICIT_DEV_MODE) {
            console.log('[PiAuth] VITE_DEV_MODE=true — entering dev mode');
            setIsDevMode(true);
            setUser(DEV_USER);
            setAccessToken('mock_token_dev');
            setLoading(false);
            return;
        }

        // Listen for the custom event from index.html
        const handleSdkReady = () => {
            console.log('[PiAuth] Received pi-sdk-ready event');
            setSdkReady(true);
        };
        window.addEventListener('pi-sdk-ready', handleSdkReady);

        // Timeout fallback — if SDK doesn't load after 5s, enter dev mode
        const timeout = setTimeout(() => {
            if (!window.Pi) {
                console.warn('[PiAuth] Pi SDK did not load within 5s — falling back to dev mode');
                setIsDevMode(true);
                setUser(DEV_USER);
                setAccessToken('mock_token_dev');
                setLoading(false);
            }
        }, SDK_TIMEOUT_MS);

        return () => {
            window.removeEventListener('pi-sdk-ready', handleSdkReady);
            clearTimeout(timeout);
        };
    }, []);

    // ── Authenticate once SDK is ready ───────────────────────────────────────
    const authenticate = useCallback(async () => {
        if (!window.Pi) {
            if (EXPLICIT_DEV_MODE) {
                setUser(DEV_USER);
                setAccessToken('mock_token_dev');
                setLoading(false);
                return;
            }
            setError('Pi Browser is required. Please open this app inside the Pi Browser.');
            setLoading(false);
            return;
        }

        const sdk = window.Pi;
        setLoading(true);
        setError(null);
        try {
            const result: PiAuthResult = await sdk.authenticate(
                ['username', 'payments', 'wallet_address'],
                handleIncompletePayment
            );
            console.log('[PiAuth] Authentication successful:', result.user.username);
            setUser(result.user);
            setAccessToken(result.accessToken);
        } catch (err) {
            console.error('[PiAuth] Authentication failed:', err);
            setError(err instanceof Error ? err.message : 'Authentication failed');
        } finally {
            setLoading(false);
        }
    }, []);

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
