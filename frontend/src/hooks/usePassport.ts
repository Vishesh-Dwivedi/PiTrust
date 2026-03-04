/**
 * usePassport — fetches passport data for the authenticated user.
 *
 * IMPORTANT: On Vercel (static SPA deployment), /api/* routes return HTML (index.html)
 * because the backend is not deployed on Vercel. We must check Content-Type
 * before parsing JSON to avoid "not valid JSON" errors.
 * 
 * Flow:
 *  1. Wait for user auth to resolve
 *  2. Try to fetch from the real API
 *  3. If API returns HTML or is unreachable → show unminted state (not mock data)
 *  4. Only use mock data when VITE_DEV_MODE=true
 */
import { useState, useEffect, useCallback } from 'react';
import { usePiAuth } from '../context/PiAuthContext';
import type { Tier } from '../utils/helpers';
import { scoreToTier } from '../utils/helpers';

const EXPLICIT_DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

export interface PassportData {
    wallet_address: string;
    pi_uid: string;
    minted: boolean;
    score: number;
    tier: Tier;
    score_frozen: boolean;
    pillar_on_chain: number;
    pillar_vouch: number;
    pillar_social: number;
    red_flags: RedFlag[];
    vouches_received: number;
    vouches_given: number;
    minted_at?: string;
}

export interface RedFlag {
    id: string;
    flag_type: string;
    score_impact: number;
    issued_at: string;
}

const DEV_MOCK_PASSPORT: PassportData = {
    wallet_address: 'GDEV1234MOCK5678ABCD',
    pi_uid: 'dev_uid_001',
    minted: true,
    score: 320,
    tier: 'silver',
    score_frozen: false,
    pillar_on_chain: 180,
    pillar_vouch: 95,
    pillar_social: 45,
    red_flags: [],
    vouches_received: 3,
    vouches_given: 2,
    minted_at: new Date().toISOString(),
};

/**
 * Safely parse a response as JSON. Returns null if the response
 * is HTML or otherwise not valid JSON (common on Vercel SPA deployments
 * where /api/* routes return index.html).
 */
async function safeJsonParse(res: Response): Promise<any | null> {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        console.warn('[usePassport] Response is not JSON (Content-Type:', contentType, ')');
        return null;
    }
    try {
        return await res.json();
    } catch {
        console.warn('[usePassport] Failed to parse response as JSON');
        return null;
    }
}

export function usePassport() {
    const { user, accessToken, isDevMode } = usePiAuth();
    const [passport, setPassport] = useState<PassportData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchPassport = useCallback(async () => {
        if (!user) {
            setLoading(false);
            return;
        }

        // ── Explicit Dev mode (VITE_DEV_MODE=true) — use mock data ────────────
        if (EXPLICIT_DEV_MODE && isDevMode) {
            setPassport({
                ...DEV_MOCK_PASSPORT,
                wallet_address: user.wallet_address || user.uid,
                pi_uid: user.uid,
            });
            setLoading(false);
            return;
        }

        // ── Production / Sandbox: try the real API ────────────────────────────
        setLoading(true);
        setError(null);
        try {
            const walletOrUid = user.wallet_address || user.uid;
            const res = await fetch(`/api/passport/${walletOrUid}`, {
                headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
            });

            // Check if we got actual JSON back
            const data = await safeJsonParse(res);

            if (data === null) {
                // API returned HTML or non-JSON → backend not available
                // Show unminted passport so user can still see the UI
                console.warn('[usePassport] Backend API not available — showing unminted state');
                setPassport({
                    wallet_address: walletOrUid,
                    pi_uid: user.uid,
                    minted: false,
                    score: 0,
                    tier: 'bronze',
                    score_frozen: false,
                    pillar_on_chain: 0,
                    pillar_vouch: 0,
                    pillar_social: 0,
                    red_flags: [],
                    vouches_received: 0,
                    vouches_given: 0,
                });
                return;
            }

            if (res.ok) {
                setPassport({
                    wallet_address: data.wallet_address || walletOrUid,
                    pi_uid: data.pi_uid || user.uid,
                    minted: true,
                    score: data.score ?? 50,
                    tier: scoreToTier(data.score ?? 50),
                    score_frozen: data.score_frozen ?? false,
                    pillar_on_chain: data.pillar_on_chain ?? 30,
                    pillar_vouch: data.pillar_vouch ?? 0,
                    pillar_social: data.pillar_social ?? 20,
                    red_flags: data.red_flags ?? [],
                    vouches_received: data.vouches_received ?? 0,
                    vouches_given: data.vouches_given ?? 0,
                    minted_at: data.minted_at,
                });
            } else if (res.status === 404) {
                // User hasn't minted yet
                setPassport({
                    wallet_address: walletOrUid,
                    pi_uid: user.uid,
                    minted: false,
                    score: 0,
                    tier: 'bronze',
                    score_frozen: false,
                    pillar_on_chain: 0,
                    pillar_vouch: 0,
                    pillar_social: 0,
                    red_flags: [],
                    vouches_received: 0,
                    vouches_given: 0,
                });
            } else {
                throw new Error(`API error: HTTP ${res.status}`);
            }
        } catch (err) {
            console.error('[usePassport] Fetch failed:', err);
            // Network error or fetch failure — show unminted state, don't crash
            setPassport({
                wallet_address: user.wallet_address || user.uid,
                pi_uid: user.uid,
                minted: false,
                score: 0,
                tier: 'bronze',
                score_frozen: false,
                pillar_on_chain: 0,
                pillar_vouch: 0,
                pillar_social: 0,
                red_flags: [],
                vouches_received: 0,
                vouches_given: 0,
            });
        } finally {
            setLoading(false);
        }
    }, [user, accessToken, isDevMode]);

    useEffect(() => {
        fetchPassport();
    }, [fetchPassport]);

    return { passport, loading, error, refetch: fetchPassport };
}
