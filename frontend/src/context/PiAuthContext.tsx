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

        // Timeout: if SDK doesn't load, enter dev mode (only if NOT in Pi Browser)
        const timeout = setTimeout(() => {
            if (!window.Pi) {
                if (navigator.userAgent.includes('PiBrowser')) {
                    console.log('[PiAuth] In Pi Browser, continuing to wait for SDK...');
                    return;
                }

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
            // CRITICAL: onIncompletePaymentFound MUST process the payment.
            // If it just logs and does nothing, Pi.authenticate() HANGS FOREVER.
            // The SDK calls this callback for any incomplete server payment
            // and waits for it to resolve before resolving authenticate().
            const onIncompletePaymentFound = async (payment: any) => {
                console.log('[PiAuth] Incomplete payment found:', payment?.identifier);
                try {
                    if (payment?.transaction?.txid && !payment?.status?.developer_completed) {
                        // Has a blockchain txid but wasn't completed — try to complete it
                        await fetch('/api/passport/complete-mint', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                paymentId: payment.identifier,
                                txId: payment.transaction.txid,
                            }),
                        });
                        console.log('[PiAuth] Completed incomplete payment:', payment.identifier);
                    } else {
                        // No txid = user never signed it. Just log and move on.
                        console.log('[PiAuth] Skipping incomplete payment (no txid):', payment?.identifier);
                    }
                } catch (err) {
                    console.error('[PiAuth] Error handling incomplete payment:', err);
                }
                // Callback MUST return/resolve for authenticate() to continue
            };

            // Race authenticate() against a timeout.
            // Pi.authenticate() hangs forever outside Pi Browser even though
            // window.Pi exists (the SDK script loads in any browser).
            const AUTH_TIMEOUT = 10000; // Increased to 10s for slow connections
            const authPromise = sdk.authenticate(
                ['payments'],
                onIncompletePaymentFound
            );
            const timeoutPromise = new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), AUTH_TIMEOUT)
            );

            const result = await Promise.race([authPromise, timeoutPromise]);

            if (result === null) {
                console.warn('[PiAuth] authenticate() timed out — showing app without auth');
                setUser(null);
                setLoading(false);
                return;
            }

            const authResult = result as PiAuthResult;
            // Validate the auth result — Pi Sandbox can return partial data
            if (!authResult?.user?.uid && !authResult?.accessToken) {
                console.warn('[PiAuth] authenticate() returned invalid result:', authResult);
                setUser(null);
                setLoading(false);
                return;
            }

            // Base fallback using unverified SDK data
            let safeUser: PiUser = {
                uid: authResult.user?.uid || 'unknown',
                username: authResult.user?.username || 'pioneer',
                wallet_address: authResult.user?.wallet_address,
            };

            // Fetch verified user from backend Pi API
            try {
                const verifyRes = await fetch('/api/auth/me', {
                    headers: { 'Authorization': `Bearer ${authResult.accessToken}` }
                });
                if (verifyRes.ok) {
                    const verified = await verifyRes.json();
                    if (verified.username) safeUser.username = verified.username;
                    if (verified.uid) safeUser.uid = verified.uid; // Update to verified uid!
                    if (verified.wallet_address) safeUser.wallet_address = verified.wallet_address;
                    console.log('[PiAuth] Fetched verified Pi profile:', safeUser.username);
                } else {
                    console.warn('[PiAuth] Backend auth verification failed:', verifyRes.status);
                    throw new Error('Backend verification rejected token');
                }
            } catch (err) {
                console.error('[PiAuth] Failed to fetch verified user profile', err);
                throw new Error('Authentication verification failed.');
            }

            console.log('[PiAuth] Authentication successful:', safeUser.username);
            setUser(safeUser);
            setAccessToken(authResult.accessToken);
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
