/**
 * PiAuthContext — wraps window.Pi SDK authentication.
 * In dev mode (no Pi Browser), provides a mock user immediately.
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

interface PiAuthState {
    user: PiUser | null;
    accessToken: string | null;
    loading: boolean;
    error: string | null;
    authenticate: () => Promise<void>;
    logout: () => void;
}

const PiAuthContext = createContext<PiAuthState | null>(null);

export function PiAuthProvider({ children }: { children: ReactNode }) {
    // Determine dynamically at render/mount time
    const initialDevMode = typeof window !== 'undefined' && !window.Pi;

    // In dev mode, pre-populate user so pages render immediately
    const [user, setUser] = useState<PiUser | null>(initialDevMode ? DEV_USER : null);
    const [accessToken, setAccessToken] = useState<string | null>(initialDevMode ? 'mock_token_dev' : null);
    // Loading is false in dev mode (user already set above), true in production
    const [loading, setLoading] = useState(!initialDevMode);
    const [error, setError] = useState<string | null>(null);

    const authenticate = useCallback(async () => {
        const isDev = !window.Pi;
        if (isDev) {
            // Already set in initial state — just ensure consistency
            setUser(DEV_USER);
            setAccessToken('mock_token_dev');
            setLoading(false);
            return;
        }

        const sdk = window.Pi!;
        setLoading(true);
        setError(null);
        try {
            const result: PiAuthResult = await sdk.authenticate(
                ['username', 'payments', 'wallet_address'],
                handleIncompletePayment
            );
            setUser(result.user);
            setAccessToken(result.accessToken);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Authentication failed');
        } finally {
            setLoading(false);
        }
    }, []);

    const logout = useCallback(() => {
        setUser(null);
        setAccessToken(null);
    }, []);

    // Auto-auth on mount
    useEffect(() => {
        const isDev = !window.Pi;
        if (!isDev) {
            authenticate();
        }
    }, [authenticate]);

    return (
        <PiAuthContext.Provider value={{ user, accessToken, loading, error, authenticate, logout }}>
            {children}
        </PiAuthContext.Provider>
    );
}

export function usePiAuth(): PiAuthState {
    const ctx = useContext(PiAuthContext);
    if (!ctx) throw new Error('usePiAuth must be used inside PiAuthProvider');
    return ctx;
}
