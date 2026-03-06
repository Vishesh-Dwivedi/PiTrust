/**
 * usePassport fetches passport data for the authenticated user.
 *
 * Shared normalization helpers are exported so public passport pages can
 * consume the same API shape without booting Pi auth.
 */
import { useState, useEffect, useCallback } from 'react';
import { usePiAuth } from '../context/PiAuthContext';
import type { Tier } from '../utils/helpers';
import { scoreToTier } from '../utils/helpers';

const EXPLICIT_DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

export interface RedFlag {
    id: string;
    flag_type: string;
    score_impact: number;
    issued_at: string;
}

export interface SocialAttestation {
    id: string;
    platform: string;
    attested_at: string;
}

export interface PassportHistoryEvent {
    id: string;
    type: string;
    occurred_at: string;
    title: string;
    detail: string;
    impact?: 'positive' | 'neutral' | 'warning';
}

export interface TrustSummary {
    headline: string;
    subline: string;
    score: number;
    tier: Tier;
    score_frozen: boolean;
    last_score_update?: string;
}

export interface ScoreBreakdown {
    on_chain: number;
    vouch: number;
    social: number;
    penalties: number;
    total: number;
}

export interface VerificationFlags {
    pi_authenticated: boolean;
    wallet_bound: boolean;
    social_verified_count: number;
    has_active_red_flags: boolean;
}

export interface PassportStats {
    completed_trades: number;
    disputed_trades: number;
    disputes_filed: number;
    disputes_opened_against: number;
    disputes_resolved: number;
    vouches_received: number;
    vouches_given: number;
    red_flags: number;
    social_verified: number;
    total_received_stake_pi: number;
    total_given_stake_pi: number;
}

export interface MerchantProfile {
    display_name: string;
    category: string;
    description?: string | null;
    location?: string | null;
    status: string;
    suspension_count: number;
    registered_at: string;
    completed_trades: number;
    disputed_trades: number;
    total_trades: number;
    badge: string | null;
    verification_headline: string;
    verification_copy: string;
}

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
    verified_social: SocialAttestation[];
    vouches_received: number;
    vouches_given: number;
    minted_at?: string;
    last_score_update?: string;
    trust_summary: TrustSummary;
    score_breakdown: ScoreBreakdown;
    verification_flags: VerificationFlags;
    merchant_profile: MerchantProfile | null;
    stats: PassportStats;
    history: PassportHistoryEvent[];
    history_count: number;
}

interface FetchPassportOptions {
    accessToken?: string | null;
    piUid?: string;
    fallbackToUnminted?: boolean;
    piAuthenticatedFallback?: boolean;
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
    verified_social: [
        { id: 'social-dev-x', platform: 'X', attested_at: new Date().toISOString() },
    ],
    vouches_received: 3,
    vouches_given: 2,
    minted_at: new Date().toISOString(),
    last_score_update: new Date().toISOString(),
    trust_summary: {
        headline: 'Trusted for regular commerce',
        subline: 'Balanced reputation across on-chain, social, and vouch signals.',
        score: 320,
        tier: 'silver',
        score_frozen: false,
        last_score_update: new Date().toISOString(),
    },
    score_breakdown: {
        on_chain: 180,
        vouch: 95,
        social: 45,
        penalties: 0,
        total: 320,
    },
    verification_flags: {
        pi_authenticated: true,
        wallet_bound: true,
        social_verified_count: 1,
        has_active_red_flags: false,
    },
    merchant_profile: null,
    stats: {
        completed_trades: 4,
        disputed_trades: 0,
        disputes_filed: 0,
        disputes_opened_against: 0,
        disputes_resolved: 0,
        vouches_received: 3,
        vouches_given: 2,
        red_flags: 0,
        social_verified: 1,
        total_received_stake_pi: 8.5,
        total_given_stake_pi: 2,
    },
    history: [
        {
            id: 'minted-dev',
            type: 'passport_minted',
            occurred_at: new Date().toISOString(),
            title: 'Passport minted',
            detail: 'Trust Passport activated for this wallet.',
            impact: 'positive',
        },
    ],
    history_count: 1,
};

export async function safeJsonParse(res: Response): Promise<any | null> {
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

export function buildUnmintedPassport(
    walletOrUid: string,
    piUid: string,
    piAuthenticated = true
): PassportData {
    return {
        wallet_address: walletOrUid,
        pi_uid: piUid,
        minted: false,
        score: 0,
        tier: 'bronze',
        score_frozen: false,
        pillar_on_chain: 0,
        pillar_vouch: 0,
        pillar_social: 0,
        red_flags: [],
        verified_social: [],
        vouches_received: 0,
        vouches_given: 0,
        trust_summary: {
            headline: 'Mint your trust passport',
            subline: 'Unlock your public trust card, vouches, and dispute-ready identity.',
            score: 0,
            tier: 'bronze',
            score_frozen: false,
        },
        score_breakdown: {
            on_chain: 0,
            vouch: 0,
            social: 0,
            penalties: 0,
            total: 0,
        },
        verification_flags: {
            pi_authenticated: piAuthenticated,
            wallet_bound: !!walletOrUid,
            social_verified_count: 0,
            has_active_red_flags: false,
        },
        merchant_profile: null,
        stats: {
            completed_trades: 0,
            disputed_trades: 0,
            disputes_filed: 0,
            disputes_opened_against: 0,
            disputes_resolved: 0,
            vouches_received: 0,
            vouches_given: 0,
            red_flags: 0,
            social_verified: 0,
            total_received_stake_pi: 0,
            total_given_stake_pi: 0,
        },
        history: [],
        history_count: 0,
    };
}

export function normalizePassportData(
    data: any,
    walletOrUid: string,
    piUid: string,
    piAuthenticatedFallback = true
): PassportData {
    const score = data.score ?? 0;
    const tier = scoreToTier(score);
    const pillarOnChain = data.pillar_on_chain ?? data.score_breakdown?.on_chain ?? 0;
    const pillarVouch = data.pillar_vouch ?? data.score_breakdown?.vouch ?? 0;
    const pillarSocial = data.pillar_social ?? data.score_breakdown?.social ?? 0;
    const redFlags = data.red_flags ?? [];
    const verifiedSocial = data.verified_social ?? [];
    const vouchesReceived = data.vouches_received ?? data.stats?.vouches_received ?? 0;
    const vouchesGiven = data.vouches_given ?? data.stats?.vouches_given ?? 0;
    const merchantProfile = data.merchant_profile
        ? {
            display_name: data.merchant_profile.display_name || 'Pi Merchant',
            category: data.merchant_profile.category || 'General',
            description: data.merchant_profile.description ?? null,
            location: data.merchant_profile.location ?? null,
            status: data.merchant_profile.status || 'active',
            suspension_count: data.merchant_profile.suspension_count ?? 0,
            registered_at: data.merchant_profile.registered_at,
            completed_trades: data.merchant_profile.completed_trades ?? 0,
            disputed_trades: data.merchant_profile.disputed_trades ?? 0,
            total_trades: data.merchant_profile.total_trades ?? 0,
            badge: data.merchant_profile.badge ?? null,
            verification_headline: data.merchant_profile.verification_headline || 'Merchant profile registered',
            verification_copy: data.merchant_profile.verification_copy || 'Merchant metadata is attached to this passport.',
        }
        : null;

    return {
        wallet_address: data.wallet_address || walletOrUid,
        pi_uid: data.pi_uid || piUid,
        minted: data.minted ?? true,
        score,
        tier,
        score_frozen: data.score_frozen ?? false,
        pillar_on_chain: pillarOnChain,
        pillar_vouch: pillarVouch,
        pillar_social: pillarSocial,
        red_flags: redFlags,
        verified_social: verifiedSocial,
        vouches_received: vouchesReceived,
        vouches_given: vouchesGiven,
        minted_at: data.minted_at,
        last_score_update: data.last_score_update ?? data.trust_summary?.last_score_update,
        trust_summary: {
            headline: data.trust_summary?.headline || 'Passport active',
            subline: data.trust_summary?.subline || 'Trust signals are being collected for this passport.',
            score,
            tier,
            score_frozen: data.score_frozen ?? false,
            last_score_update: data.last_score_update ?? data.trust_summary?.last_score_update,
        },
        score_breakdown: {
            on_chain: pillarOnChain,
            vouch: pillarVouch,
            social: pillarSocial,
            penalties: data.score_breakdown?.penalties ?? 0,
            total: data.score_breakdown?.total ?? score,
        },
        verification_flags: {
            pi_authenticated: data.verification_flags?.pi_authenticated ?? piAuthenticatedFallback,
            wallet_bound: data.verification_flags?.wallet_bound ?? true,
            social_verified_count: data.verification_flags?.social_verified_count ?? verifiedSocial.length,
            has_active_red_flags: data.verification_flags?.has_active_red_flags ?? redFlags.length > 0,
        },
        merchant_profile: merchantProfile,
        stats: {
            completed_trades: data.stats?.completed_trades ?? data.completed_trades ?? 0,
            disputed_trades: data.stats?.disputed_trades ?? data.disputed_trades ?? 0,
            disputes_filed: data.stats?.disputes_filed ?? 0,
            disputes_opened_against: data.stats?.disputes_opened_against ?? 0,
            disputes_resolved: data.stats?.disputes_resolved ?? 0,
            vouches_received: vouchesReceived,
            vouches_given: vouchesGiven,
            red_flags: data.stats?.red_flags ?? redFlags.length,
            social_verified: data.stats?.social_verified ?? verifiedSocial.length,
            total_received_stake_pi: data.stats?.total_received_stake_pi ?? 0,
            total_given_stake_pi: data.stats?.total_given_stake_pi ?? 0,
        },
        history: data.history ?? [],
        history_count: data.history_count ?? (data.history?.length ?? 0),
    };
}

export async function fetchPassportRecord(
    walletOrUid: string,
    options: FetchPassportOptions = {}
): Promise<PassportData | null> {
    const {
        accessToken,
        piUid = walletOrUid,
        fallbackToUnminted = false,
        piAuthenticatedFallback = true,
    } = options;

    const res = await fetch(`/api/passport/${encodeURIComponent(walletOrUid)}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });

    const data = await safeJsonParse(res);
    if (data === null) {
        if (fallbackToUnminted) {
            console.warn('[usePassport] Backend API not available, showing unminted state');
            return buildUnmintedPassport(walletOrUid, piUid, piAuthenticatedFallback);
        }
        throw new Error('Passport API returned a non-JSON response');
    }

    if (res.ok) {
        return normalizePassportData(data, walletOrUid, piUid, piAuthenticatedFallback);
    }

    if (res.status === 404) {
        if (fallbackToUnminted) {
            return buildUnmintedPassport(walletOrUid, piUid, piAuthenticatedFallback);
        }
        return null;
    }

    const apiMessage = typeof data?.error === 'string' ? data.error : `API error: HTTP ${res.status}`;
    throw new Error(apiMessage);
}

export function usePassport() {
    const { user, accessToken, isDevMode } = usePiAuth();
    const [passport, setPassport] = useState<PassportData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchPassport = useCallback(async () => {
        if (!user) {
            setPassport(null);
            setLoading(false);
            return;
        }

        const walletOrUid = user.wallet_address || user.uid;

        if (EXPLICIT_DEV_MODE && isDevMode) {
            setPassport({
                ...DEV_MOCK_PASSPORT,
                wallet_address: walletOrUid,
                pi_uid: user.uid,
            });
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const nextPassport = await fetchPassportRecord(walletOrUid, {
                accessToken,
                piUid: user.uid,
                fallbackToUnminted: true,
                piAuthenticatedFallback: true,
            });
            setPassport(nextPassport);
        } catch (err) {
            console.error('[usePassport] Fetch failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to fetch passport');
            setPassport(buildUnmintedPassport(walletOrUid, user.uid));
        } finally {
            setLoading(false);
        }
    }, [user, accessToken, isDevMode]);

    useEffect(() => {
        fetchPassport();
    }, [fetchPassport]);

    return { passport, loading, error, refetch: fetchPassport };
}
