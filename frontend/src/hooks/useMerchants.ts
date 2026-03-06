import { useCallback, useEffect, useState } from 'react';
import type { Tier } from '../utils/helpers';

export interface MerchantDirectoryEntry {
    wallet_address: string;
    display_name: string;
    category: string;
    description: string | null;
    location: string | null;
    registered_at: string;
    status: string;
    score: number;
    tier: Tier;
    score_frozen: boolean;
    completed_trades: number;
    disputed_trades: number;
    total_trades: number;
    active_red_flags: number;
    badge: string | null;
}

interface MerchantResponse {
    merchants: MerchantDirectoryEntry[];
    page: number;
    limit: number;
    category: string | null;
    search: string | null;
}

interface UseMerchantsOptions {
    page?: number;
    limit?: number;
    category?: string;
    search?: string;
}

export function useMerchants({ page = 1, limit = 12, category = '', search = '' }: UseMerchantsOptions) {
    const [merchants, setMerchants] = useState<MerchantDirectoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchMerchants = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });

            if (category.trim()) params.set('category', category.trim());
            if (search.trim()) params.set('search', search.trim());

            const res = await fetch(`/api/merchant?${params.toString()}`);
            const payload = await res.json().catch(() => null) as MerchantResponse | null;

            if (!res.ok || !payload) {
                throw new Error((payload as { error?: string } | null)?.error || 'Failed to load merchants');
            }

            setMerchants(payload.merchants.map((merchant) => ({
                ...merchant,
                score: Number(merchant.score || 0),
                completed_trades: Number(merchant.completed_trades || 0),
                disputed_trades: Number(merchant.disputed_trades || 0),
                total_trades: Number(merchant.total_trades || 0),
                active_red_flags: Number(merchant.active_red_flags || 0),
            })));
        } catch (err) {
            console.error('[useMerchants] Fetch failed:', err);
            setMerchants([]);
            setError(err instanceof Error ? err.message : 'Failed to load merchants');
        } finally {
            setLoading(false);
        }
    }, [category, limit, page, search]);

    useEffect(() => {
        fetchMerchants();
    }, [fetchMerchants]);

    return { merchants, loading, error, refetch: fetchMerchants };
}

