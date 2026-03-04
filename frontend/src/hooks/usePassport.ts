/**
 * usePassport — fetches / mocks passport data for the authenticated user.
 *
 * Flow:
 *  - While user is null (auth still resolving) → loading = false, passport = null
 *  - Once user arrives → immediately set mock (dev) or fetch from API (Pi Browser)
 *  - Loading is only true during an actual API fetch; dev mock is synchronous
 */
import { useState, useEffect, useCallback } from 'react';
import { usePiAuth } from '../context/PiAuthContext';
import type { Tier } from '../utils/helpers';
import { scoreToTier } from '../utils/helpers';

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
}

export interface RedFlag {
    id: string;
    flag_type: string;
    score_impact: number;
    issued_at: string;
}

export function usePassport() {
    const { user, accessToken } = usePiAuth();
    const [passport, setPassport] = useState<PassportData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchPassport = useCallback(async () => {
        if (!user) return; // auth not resolved yet — do nothing

        // ── Dev mode: window.Pi not available ─────────────────────────────────────
        if (!window.Pi) {
            // Synchronous — no loading flash needed
            setPassport({
                wallet_address: user.wallet_address || user.uid,
                pi_uid: user.uid,
                minted: false,
                score: 320,
                tier: 'silver',
                score_frozen: false,
                pillar_on_chain: 180,
                pillar_vouch: 95,
                pillar_social: 45,
                red_flags: [],
                vouches_received: 3,
                vouches_given: 2,
            });
            return;
        }

        // ── Production: hit the API ────────────────────────────────────────────────
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/passport/${user.wallet_address || user.uid}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (res.ok) {
                const data = await res.json();
                setPassport({ ...data, tier: scoreToTier(data.score) });
            } else if (res.status === 404) {
                setPassport({
                    wallet_address: user.wallet_address || user.uid,
                    pi_uid: user.uid,
                    minted: false,
                    score: 50,
                    tier: 'bronze',
                    score_frozen: false,
                    pillar_on_chain: 30,
                    pillar_vouch: 0,
                    pillar_social: 20,
                    red_flags: [],
                    vouches_received: 0,
                    vouches_given: 0,
                });
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load passport');
        } finally {
            setLoading(false);
        }
    }, [user, accessToken]);

    useEffect(() => {
        fetchPassport();
    }, [fetchPassport]);

    return { passport, loading, error, refetch: fetchPassport };
}
