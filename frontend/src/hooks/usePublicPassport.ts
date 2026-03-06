import { useCallback, useEffect, useState } from 'react';
import { fetchPassportRecord, type PassportData } from './usePassport';

export function usePublicPassport(walletOrUid?: string) {
    const [passport, setPassport] = useState<PassportData | null>(null);
    const [loading, setLoading] = useState(Boolean(walletOrUid));
    const [error, setError] = useState<string | null>(null);
    const [notFound, setNotFound] = useState(false);

    const fetchPassport = useCallback(async () => {
        if (!walletOrUid) {
            setPassport(null);
            setError('Missing passport identifier');
            setNotFound(false);
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);
        setNotFound(false);

        try {
            const nextPassport = await fetchPassportRecord(walletOrUid, {
                fallbackToUnminted: false,
                piAuthenticatedFallback: false,
            });

            if (!nextPassport) {
                setPassport(null);
                setNotFound(true);
                return;
            }

            setPassport(nextPassport);
        } catch (err) {
            console.error('[usePublicPassport] Fetch failed:', err);
            setPassport(null);
            setError(err instanceof Error ? err.message : 'Failed to fetch passport');
        } finally {
            setLoading(false);
        }
    }, [walletOrUid]);

    useEffect(() => {
        fetchPassport();
    }, [fetchPassport]);

    return { passport, loading, error, notFound, refetch: fetchPassport };
}
