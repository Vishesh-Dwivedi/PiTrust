/**
 * Vouch Page — search for pioneers, stake Pi, view incoming/outgoing vouches
 * Does NOT depend on usePassport — renders independently with its own mock vouches
 */
import { useState, useEffect } from 'react';
import { usePiAuth } from '../context/PiAuthContext';
import { usePiPayment } from '../hooks/usePiPayment';
import { BottomSheet } from '../components/layout/BottomSheet';
import { formatWallet } from '../utils/helpers';
import './Vouch.css';

interface Voucher {
    wallet: string;
    username: string;
    score: number;
    amountPi: number;
    stakedAt: string;
    active: boolean;
}

export function Vouch() {
    const { user, accessToken } = usePiAuth();
    const { state: payState, pay, reset: resetPay } = usePiPayment();
    const [search, setSearch] = useState('');
    const [vouches, setVouches] = useState<Voucher[]>([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    // Fetch Vouches
    useEffect(() => {
        if (!user) return;
        const fetchVouches = async () => {
            setLoading(true);
            setFetchError(null);
            try {
                const res = await fetch(`/api/vouch/${user.wallet_address || user.uid}`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                // Check if response is actually JSON (Vercel may return HTML)
                const contentType = res.headers.get('content-type') || '';
                if (!contentType.includes('application/json')) {
                    console.warn('[Vouch] API returned non-JSON (backend not available)');
                    setVouches([]);
                    return;
                }
                if (res.ok) {
                    const data = await res.json();
                    setVouches(data.vouches.map((v: any) => ({
                        wallet: v.voucher_wallet || 'Unknown',
                        username: v.voucher_wallet?.slice(0, 8) || 'pioneer',
                        score: 0,
                        amountPi: parseFloat(v.net_amount_pi),
                        stakedAt: v.staked_at,
                        active: v.status === 'active'
                    })));
                } else {
                    setVouches([]);
                }
            } catch (err) {
                console.error('Failed to fetch vouches', err);
                setFetchError('Could not load vouches. The server may be unavailable.');
            } finally {
                setLoading(false);
            }
        };
        fetchVouches();
    }, [user, accessToken]);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [selectedTarget, setSelectedTarget] = useState<string>('');
    const [stakeAmount, setStakeAmount] = useState(1);
    const [tab, setTab] = useState<'received' | 'given'>('received');

    const openVouchSheet = (username: string) => {
        setSelectedTarget(username);
        resetPay();
        setSheetOpen(true);
    };

    const handleStake = async () => {
        await pay(
            {
                amount: stakeAmount,
                memo: `PiTrust Vouch: @${selectedTarget}`,
                metadata: { type: 'vouch_stake', target: selectedTarget },
            },
            undefined,
            async () => { setSheetOpen(false); }
        );
    };

    const totalStaked = vouches.filter(v => v.active).reduce((s, v) => s + v.amountPi, 0);
    const receivedVouches = vouches.filter(v => v.active);
    const givenVouches: Voucher[] = []; // Not yet supported by generic `/api/vouch/:wallet` endpoint but structure remains

    return (
        <div className="vouch-page stagger">

            {/* Loading state */}
            {loading && (
                <div className="frost-card animate-fade-up" style={{ textAlign: 'center', padding: '48px 24px' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading vouches...</p>
                </div>
            )}

            {/* Error state */}
            {fetchError && (
                <div className="frost-card animate-fade-up" style={{ textAlign: 'center', padding: '32px 24px' }}>
                    <p style={{ color: 'var(--danger)', marginBottom: '8px' }}>⚠️ {fetchError}</p>
                    <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>Vouches will load when the backend is connected.</p>
                </div>
            )}

            {/* Header stats */}
            <div className="vouch-header animate-fade-up">
                <div className="vouch-stat frost-card">
                    <span className="vouch-stat__value">{receivedVouches.length}</span>
                    <span className="vouch-stat__label">Vouches In</span>
                </div>
                <div className="vouch-divider" />
                <div className="vouch-stat frost-card">
                    <span className="vouch-stat__value">π {totalStaked.toFixed(1)}</span>
                    <span className="vouch-stat__label">Total Staked</span>
                </div>
                <div className="vouch-divider" />
                <div className="vouch-stat frost-card">
                    <span className="vouch-stat__value">{givenVouches.length}</span>
                    <span className="vouch-stat__label">Vouches Out</span>
                </div>
            </div>

            {/* Search */}
            <div className="vouch-search-wrap animate-fade-up">
                <input
                    type="search"
                    className="input vouch-search"
                    placeholder="Search by @username or wallet..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    aria-label="Search pioneers to vouch"
                />
            </div>

            {/* Tab selector */}
            <div className="tab-row animate-fade-up">
                <button className={`tab-btn ${tab === 'received' ? 'active' : ''}`} onClick={() => setTab('received')}>
                    Received ({receivedVouches.length})
                </button>
                <button className={`tab-btn ${tab === 'given' ? 'active' : ''}`} onClick={() => setTab('given')}>
                    Given ({givenVouches.length})
                </button>
            </div>

            {/* Vouch list */}
            <div className="vouch-list stagger animate-fade-up">
                {(tab === 'received' ? receivedVouches : givenVouches)
                    .filter(v => !search || v.username.includes(search.toLowerCase()))
                    .map(v => (
                        <div key={v.wallet} className="vouch-card frost-card">
                            <div className="vouch-card__left">
                                <div className="vouch-avatar">{(v.username || 'P').charAt(0).toUpperCase()}</div>
                                <div className="vouch-info">
                                    <div className="vouch-username">@{v.username}</div>
                                    <div className="vouch-wallet">{formatWallet(v.wallet)}</div>
                                </div>
                            </div>
                            <div className="vouch-card__right">
                                <div className="vouch-amount">π {v.amountPi.toFixed(1)}</div>
                                <div className={`badge ${v.active ? 'badge-success' : 'badge-ghost'}`}>
                                    {v.active ? 'Active' : 'Expired'}
                                </div>
                                {tab === 'received' && v.active && (
                                    <button className="btn btn-ghost vouch-action-btn" onClick={() => openVouchSheet(v.username)}>
                                        Vouch Back
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
            </div>

            {/* New vouch FAB */}
            <button className="vouch-fab btn btn-primary" onClick={() => openVouchSheet('')} aria-label="Add new vouch">
                + New Vouch
            </button>

            {/* === Vouch Bottom Sheet === */}
            <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={selectedTarget ? `Vouch for @${selectedTarget}` : 'New Vouch'}>
                <div className="vouch-sheet">
                    {!selectedTarget && (
                        <input type="text" className="input" placeholder="@username or wallet address"
                            value={selectedTarget} onChange={e => setSelectedTarget(e.target.value)}
                            style={{ marginBottom: '16px' }} aria-label="Pioneer to vouch" />
                    )}
                    <div className="stake-slider-section">
                        <div className="stake-label-row">
                            <span className="stake-label">Stake Amount</span>
                            <span className="stake-amount-display">π {stakeAmount.toFixed(1)}</span>
                        </div>
                        <input type="range" className="range-slider" min={0.1} max={50} step={0.1}
                            value={stakeAmount} onChange={e => setStakeAmount(parseFloat(e.target.value))} aria-label="Vouch stake amount" />
                        <div className="stake-limits"><span>Min: π 0.1</span><span>Max: π 50</span></div>
                    </div>
                    <div className="stake-info">
                        <div className="stake-info-row"><span>Lock Period</span><strong>90 days</strong></div>
                        <div className="stake-info-row"><span>Protocol Fee</span><strong>2% (π {(stakeAmount * 0.02).toFixed(3)})</strong></div>
                        <div className="stake-info-row"><span>Net Staked</span><strong>π {(stakeAmount * 0.98).toFixed(3)}</strong></div>
                    </div>
                    <p className="stake-disclaimer">Your staked π can be slashed if this pioneer is convicted. Stake only what you're comfortable losing.</p>
                    {payState === 'completed' ? (
                        <div className="mint-success"><div className="success-check">✓</div><p>Vouch staked successfully!</p></div>
                    ) : (
                        <button className="btn btn-primary w-full" onClick={handleStake}
                            disabled={payState === 'awaiting_approval' || payState === 'processing' || !selectedTarget}>
                            {payState === 'awaiting_approval' && 'Pi Browser approving...'}
                            {payState === 'processing' && 'Staking on-chain...'}
                            {(payState === 'idle' || payState === 'cancelled') && `Stake π ${stakeAmount.toFixed(1)}`}
                        </button>
                    )}
                </div>
            </BottomSheet>
        </div>
    );
}
