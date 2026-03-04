/**
 * Disputes Page — view active disputes, file new claims, Sentinel voting
 */
import { useState, useEffect } from 'react';
import { usePiPayment } from '../hooks/usePiPayment';
import { usePiAuth } from '../context/PiAuthContext';
import { BottomSheet } from '../components/layout/BottomSheet';
import { shortTimeAgo } from '../utils/helpers';
import './Disputes.css';

type DisputeStatus = 'filed' | 'arbitrators_assigned' | 'voting' | 'finalized';
type DisputeOutcome = 'convicted' | 'dismissed' | null;

interface Dispute {
    id: string;
    claimant: string;
    defendant: string;
    status: DisputeStatus;
    outcome: DisputeOutcome;
    filedAt: string;
    isArbitrator: boolean;
    myVote?: 'convict' | 'dismiss';
}

const STATUS_LABELS: Record<DisputeStatus, string> = {
    filed: 'Filed',
    arbitrators_assigned: 'Assigned',
    voting: 'Voting',
    finalized: 'Finalized',
};

const STATUS_BADGE: Record<DisputeStatus, string> = {
    filed: 'badge-info',
    arbitrators_assigned: 'badge-warning',
    voting: 'badge-warning',
    finalized: 'badge-ghost',
};

export function Disputes() {
    const { user, accessToken } = usePiAuth();
    const { state: payState, pay, reset: resetPay } = usePiPayment(accessToken || undefined);
    const [disputes, setDisputes] = useState<Dispute[]>([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [claimForm, setClaimForm] = useState({ defendant: '', evidence: '' });
    const [filter, setFilter] = useState<'all' | 'sentinel' | 'mine'>('all');

    useEffect(() => {
        const fetchDisputes = async () => {
            setLoading(true);
            setFetchError(null);
            try {
                const res = await fetch('/api/dispute', {
                    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
                });
                // Check if response is actually JSON (Vercel may return HTML)
                const contentType = res.headers.get('content-type') || '';
                if (!contentType.includes('application/json')) {
                    console.warn('[Disputes] API returned non-JSON (backend not available)');
                    setDisputes([]);
                    return;
                }
                if (res.ok) {
                    const data = await res.json();
                    setDisputes(data.map((d: any) => ({
                        id: String(d.dispute_id),
                        claimant: d.claimant_wallet?.slice(0, 8) || 'Unknown',
                        defendant: d.defendant_wallet?.slice(0, 8) || 'Unknown',
                        status: d.status as DisputeStatus,
                        outcome: null,
                        filedAt: d.filed_at,
                        isArbitrator: false,
                    })));
                } else {
                    console.warn('[Disputes] API returned', res.status);
                    // Don't treat non-200 as fatal — could be empty
                    setDisputes([]);
                }
            } catch (err) {
                console.error('Failed to fetch disputes', err);
                setFetchError('Could not load disputes. The server may be unavailable.');
            } finally {
                setLoading(false);
            }
        };
        fetchDisputes();
    }, [accessToken]);

    const filteredDisputes = disputes.filter(d => {
        if (filter === 'sentinel') return d.isArbitrator;
        if (filter === 'mine') return d.claimant === '@you';
        return true;
    });

    const handleFileClaim = async () => {
        await pay(
            { amount: 0.5, memo: `PiTrust Dispute: ${claimForm.defendant.slice(0, 10)}`, metadata: { type: 'dispute_filing', target: claimForm.defendant, evidence: claimForm.evidence } },
            undefined,
            async () => {
                const newDispute: Dispute = {
                    id: `d${Date.now()}`,
                    claimant: user?.wallet_address || 'you',
                    defendant: claimForm.defendant,
                    status: 'filed',
                    outcome: null,
                    filedAt: new Date().toISOString(),
                    isArbitrator: false,
                };
                setDisputes(prev => [newDispute, ...prev]);
                setSheetOpen(false);
                resetPay();
            }
        );
    };

    const castVote = (disputeId: string, vote: 'convict' | 'dismiss') => {
        setDisputes(prev => prev.map(d =>
            d.id === disputeId ? { ...d, myVote: vote } : d
        ));
    };

    const sentinelCount = disputes.filter(d => d.isArbitrator && d.status === 'voting').length;

    return (
        <div className="disputes-page stagger">

            {/* Loading state */}
            {loading && (
                <div className="disputes-loading frost-card animate-fade-up" style={{ textAlign: 'center', padding: '48px 24px' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading disputes...</p>
                </div>
            )}

            {/* Error state */}
            {fetchError && (
                <div className="disputes-error frost-card animate-fade-up" style={{ textAlign: 'center', padding: '32px 24px' }}>
                    <p style={{ color: 'var(--danger)', marginBottom: '8px' }}>⚠️ {fetchError}</p>
                    <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>Disputes will load when the backend is connected.</p>
                </div>
            )}

            {/* Sentinel banner if active arbitrations */}
            {sentinelCount > 0 && (
                <div className="sentinel-banner frost-card animate-fade-up">
                    <div className="sentinel-icon">⚖️</div>
                    <div>
                        <p className="sentinel-title">{sentinelCount} case{sentinelCount > 1 ? 's' : ''} awaiting your vote</p>
                        <p className="sentinel-sub">You are assigned as Sentinel arbitrator. Cast your vote within 72h.</p>
                    </div>
                </div>
            )}

            {/* === Filter tabs === */}
            <div className="disputes-filters tab-row animate-fade-up">
                {(['all', 'sentinel', 'mine'] as const).map(f => (
                    <button
                        key={f}
                        className={`tab-btn ${filter === f ? 'active' : ''}`}
                        onClick={() => setFilter(f)}
                    >
                        {f === 'all' ? 'All' : f === 'sentinel' ? '⚖️ Sentinel' : 'My Cases'}
                    </button>
                ))}
            </div>

            {/* === Dispute list === */}
            <div className="dispute-list stagger animate-fade-up">
                {filteredDisputes.length === 0 ? (
                    <div className="dispute-empty frost-card">
                        <p>No disputes found.</p>
                        <p className="dispute-empty__sub">The network is in good shape.</p>
                    </div>
                ) : (
                    filteredDisputes.map(d => (
                        <div key={d.id} className={`dispute-card frost-card ${d.isArbitrator && d.status === 'voting' ? 'dispute-card--active' : ''}`}>
                            <div className="dispute-card__top">
                                <div className="dispute-parties">
                                    <span className="party claimant">{d.claimant}</span>
                                    <span className="vs">vs</span>
                                    <span className="party defendant">{d.defendant}</span>
                                </div>
                                <span className={`badge ${STATUS_BADGE[d.status]}`}>
                                    {STATUS_LABELS[d.status]}
                                </span>
                            </div>

                            {d.outcome && (
                                <div className={`badge ${d.outcome === 'convicted' ? 'badge-danger' : 'badge-success'}`} style={{ marginTop: '8px' }}>
                                    {d.outcome === 'convicted' ? '🔴 Convicted' : '✅ Dismissed'}
                                </div>
                            )}

                            <div className="dispute-meta">
                                <span className="dispute-time">{shortTimeAgo(d.filedAt)}</span>
                                {d.isArbitrator && <span className="badge badge-info">Sentinel</span>}
                            </div>

                            {/* Sentinel vote buttons */}
                            {d.isArbitrator && d.status === 'voting' && !d.myVote && (
                                <div className="sentinel-votes">
                                    <button
                                        className="btn btn-danger"
                                        style={{ flex: 1, fontSize: '13px' }}
                                        onClick={() => castVote(d.id, 'convict')}
                                    >
                                        🔴 Convict
                                    </button>
                                    <button
                                        className="btn btn-ghost"
                                        style={{ flex: 1, fontSize: '13px' }}
                                        onClick={() => castVote(d.id, 'dismiss')}
                                    >
                                        ✅ Dismiss
                                    </button>
                                </div>
                            )}

                            {d.myVote && (
                                <div className={`my-vote-state ${d.myVote === 'convict' ? 'badge-danger' : 'badge-success'} badge`}>
                                    Your vote: {d.myVote === 'convict' ? '🔴 Convict' : '✅ Dismiss'} · Awaiting quorum
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            {/* File dispute FAB */}
            <button
                className="dispute-fab btn btn-danger"
                onClick={() => { resetPay(); setSheetOpen(true); }}
                aria-label="File new dispute"
            >
                + File Dispute
            </button>

            {/* === File Dispute Bottom Sheet === */}
            <BottomSheet
                open={sheetOpen}
                onClose={() => setSheetOpen(false)}
                title="File a Dispute"
            >
                <div className="dispute-sheet">
                    <div className="dispute-cost-notice badge badge-warning">
                        ⚠️ Filing fee: 0.5 π — Refunded if you win
                    </div>

                    <div className="form-group">
                        <label htmlFor="defendant-input" className="form-label">Defendant (wallet or @username)</label>
                        <input
                            id="defendant-input"
                            type="text"
                            className="input"
                            placeholder="@username or GABCD..."
                            value={claimForm.defendant}
                            onChange={e => setClaimForm(p => ({ ...p, defendant: e.target.value }))}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="evidence-input" className="form-label">Evidence Description</label>
                        <textarea
                            id="evidence-input"
                            className="input"
                            rows={4}
                            style={{ resize: 'none', lineHeight: 1.6 }}
                            placeholder="Describe the incident, include transaction IDs, screenshots, and timeline..."
                            value={claimForm.evidence}
                            onChange={e => setClaimForm(p => ({ ...p, evidence: e.target.value }))}
                        />
                    </div>

                    <div className="dispute-process">
                        <p className="dispute-process__title">What happens next</p>
                        <ol className="dispute-process__list">
                            <li>Your dispute is recorded on-chain with evidence hash</li>
                            <li>3 Sentinel arbitrators are assigned (24h)</li>
                            <li>72-hour voting window</li>
                            <li>Majority verdict: conviction slashes all vouches</li>
                        </ol>
                    </div>

                    {payState === 'completed' ? (
                        <div className="mint-success">
                            <div className="success-check">✓</div>
                            <p>Dispute filed. Arbitrators will be assigned within 24 hours.</p>
                        </div>
                    ) : (
                        <button
                            className="btn btn-danger w-full"
                            onClick={handleFileClaim}
                            disabled={
                                !claimForm.defendant ||
                                !claimForm.evidence ||
                                payState === 'awaiting_approval' ||
                                payState === 'processing'
                            }
                        >
                            {payState === 'awaiting_approval' && 'Awaiting Pi Browser...'}
                            {payState === 'processing' && 'Filing on-chain...'}
                            {(payState === 'idle' || payState === 'cancelled') && 'File Dispute — 0.5 π'}
                        </button>
                    )}
                </div>
            </BottomSheet>
        </div>
    );
}
