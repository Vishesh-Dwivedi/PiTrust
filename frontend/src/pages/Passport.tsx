/**
 * Passport Page — Premium NFT Card with tier-differentiated visuals
 * 
 * Design concept: Each tier has its own distinct visual identity:
 * Bronze → Matte copper with grain texture
 * Silver → Brushed steel with geometric patterns  
 * Gold → Rich gradient with animated particles
 * Platinum → Aurora glass with prismatic refraction
 * Sentinel → Obsidian with electric pulse effects
 */
import { useState, useEffect, useRef } from 'react';
import { usePassport } from '../hooks/usePassport';
import { usePiPayment } from '../hooks/usePiPayment';
import { usePiAuth } from '../context/PiAuthContext';
import { tierLabel, tierColor, formatWallet, scorePercentage } from '../utils/helpers';
import './Passport.css';

const TIER_MOTTOS: Record<string, string> = {
    bronze: 'Beginning the Journey',
    silver: 'Earning Trust',
    gold: 'Proven Trailblazer',
    platinum: 'Elite Vanguard',
    sentinel: 'Guardian of the Network',
};

const TIER_ICONS: Record<string, string> = {
    bronze: '🛡️',
    silver: '⚔️',
    gold: '⭐',
    platinum: '💎',
    sentinel: '👁️',
};

export function Passport() {
    const { user, loading: authLoading, accessToken } = usePiAuth();
    const { passport, loading: passportLoading, refetch, error: passportError } = usePassport();
    const { state: payState, error: payError, pay } = usePiPayment(accessToken || undefined);
    const cardRef = useRef<HTMLDivElement>(null);
    const [tilt, setTilt] = useState({ x: 0, y: 0 });
    const [isFlipped, setIsFlipped] = useState(false);
    const [questing, setQuesting] = useState(false);

    // Gyroscope tilt for the 3D card
    useEffect(() => {
        const handleOrientation = (e: DeviceOrientationEvent) => {
            const x = Math.min(15, Math.max(-15, (e.gamma ?? 0) * 0.4));
            const y = Math.min(10, Math.max(-10, (e.beta ?? 0) * 0.2 - 5));
            setTilt({ x, y });
        };
        window.addEventListener('deviceorientation', handleOrientation);
        return () => window.removeEventListener('deviceorientation', handleOrientation);
    }, []);

    // Mouse tilt for desktop
    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isFlipped) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const x = ((e.clientX - cx) / rect.width) * 20;
        const y = -((e.clientY - cy) / rect.height) * 15;
        setTilt({ x, y });
    };

    const handleMouseLeave = () => setTilt({ x: 0, y: 0 });

    const handleMint = async () => {
        await pay(
            { amount: 1, memo: 'PiTrust Passport Mint', metadata: { type: 'passport_mint' } },
            undefined,
            async () => { await refetch(); }
        );
    };

    const handleShare = () => {
        if (window.Pi && passport) {
            window.Pi.openShareDialog(
                '🛡️ My PiTrust Passport',
                `I'm a ${tierLabel(passport.tier)} on PiTrust with a score of ${passport.score}/1000! 🚀\n\nMint yours at trustpi.space`
            );
        }
    };

    const completeQuest = async (questId: string, platform: string) => {
        if (questing) return;
        setQuesting(true);
        try {
            const res = await fetch('/api/quests/complete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify({ questId, platform })
            });
            if (res.ok) {
                alert(`${platform} connected successfully! Your score will update soon.`);
                await refetch();
            } else {
                const data = await res.json();
                alert(`Error: ${data.error}`);
            }
        } catch (err) {
            alert('Failed to complete quest');
        } finally {
            setQuesting(false);
        }
    };

    // Loading state
    if (authLoading || passportLoading) return (
        <div className="passport-page">
            <div className="passport-loading">
                <div className="passport-loading__spinner" />
                <p className="passport-loading__text">Loading your Passport...</p>
            </div>
        </div>
    );

    // Error state
    if (passportError && !passport) return (
        <div className="passport-page">
            <div className="passport-error frost-card">
                <div className="passport-error__icon">⚠️</div>
                <h2>Could not load Passport</h2>
                <p>{passportError}</p>
                <button className="btn btn-primary" onClick={refetch}>Retry</button>
            </div>
        </div>
    );

    if (!passport) return null;

    const cardColor = tierColor(passport.tier);
    const mintDate = passport.minted_at ? new Date(passport.minted_at).toLocaleDateString('en-US', {
        month: 'short', year: 'numeric'
    }) : null;

    return (
        <div className="passport-page stagger">

            {/* === Premium 3D Passport Card === */}
            <div className="passport-card-section animate-fade-up">
                <p className="passport-section-label">
                    {passport.minted ? '✦ Your Soulbound Passport' : '✦ Mint Your Identity'}
                </p>

                <div
                    className="passport-card-wrap"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                    onClick={() => passport.minted && setIsFlipped(!isFlipped)}
                >
                    <div
                        ref={cardRef}
                        className={`passport-card tier-${passport.tier} ${passport.minted ? 'minted' : 'unminted'} ${isFlipped ? 'flipped' : ''}`}
                        style={{
                            transform: `perspective(800px) rotateX(${isFlipped ? 180 : tilt.y}deg) rotateY(${isFlipped ? 0 : tilt.x}deg)`,
                        }}
                    >
                        {/* ── FRONT FACE ── */}
                        <div className="passport-face passport-front">
                            {/* Tier-specific background effects */}
                            <div className="passport-bg-effect" />

                            {/* Holographic foil overlay */}
                            <div
                                className="holo-foil"
                                style={{
                                    backgroundPosition: `${50 + tilt.x * 3}% ${50 + tilt.y * 3}%`,
                                }}
                            />

                            {/* Scan line for Sentinel tier */}
                            {passport.tier === 'sentinel' && <div className="scan-line" />}

                            {/* Card header */}
                            <div className="passport-card__header">
                                <div className="passport-card__brand">
                                    <span className="pi-emblem">π</span>
                                    <span className="brand-text">PiTrust</span>
                                </div>
                                <div className="passport-card__type">
                                    {passport.minted ? 'SOULBOUND TOKEN' : 'NOT MINTED'}
                                </div>
                            </div>

                            {/* Center score display */}
                            <div className="passport-card__score-block">
                                <div className="score-ring" style={{ '--ring-progress': `${scorePercentage(passport.score)}%`, '--ring-color': cardColor } as any}>
                                    <span className="score-ring__value">{passport.score}</span>
                                    <span className="score-ring__max">/1000</span>
                                </div>
                                <div className="passport-card__tier-info">
                                    <span className="tier-icon">{TIER_ICONS[passport.tier]}</span>
                                    <span className="tier-name" style={{ color: cardColor }}>
                                        {tierLabel(passport.tier)}
                                    </span>
                                    <span className="tier-motto">{TIER_MOTTOS[passport.tier]}</span>
                                </div>
                            </div>

                            {/* Score pillars mini-bars */}
                            <div className="passport-card__pillars">
                                <div className="pillar-mini">
                                    <span className="pillar-mini__label">On-Chain</span>
                                    <div className="pillar-mini__bar">
                                        <div className="pillar-mini__fill" style={{ width: `${Math.min(100, (passport.pillar_on_chain / 400) * 100)}%`, background: cardColor }} />
                                    </div>
                                    <span className="pillar-mini__value">{passport.pillar_on_chain}</span>
                                </div>
                                <div className="pillar-mini">
                                    <span className="pillar-mini__label">Vouch</span>
                                    <div className="pillar-mini__bar">
                                        <div className="pillar-mini__fill" style={{ width: `${Math.min(100, (passport.pillar_vouch / 300) * 100)}%`, background: cardColor }} />
                                    </div>
                                    <span className="pillar-mini__value">{passport.pillar_vouch}</span>
                                </div>
                                <div className="pillar-mini">
                                    <span className="pillar-mini__label">Social</span>
                                    <div className="pillar-mini__bar">
                                        <div className="pillar-mini__fill" style={{ width: `${Math.min(100, (passport.pillar_social / 300) * 100)}%`, background: cardColor }} />
                                    </div>
                                    <span className="pillar-mini__value">{passport.pillar_social}</span>
                                </div>
                            </div>

                            {/* Footer */}
                            <div className="passport-card__footer">
                                <div className="passport-card__identity">
                                    <div className="passport-card__username">@{user?.username}</div>
                                    <div className="passport-card__wallet">{formatWallet(passport.wallet_address)}</div>
                                </div>
                                <div className="passport-card__meta">
                                    {mintDate && <div className="passport-card__since">Since {mintDate}</div>}
                                    <div className={`passport-card__orb tier-${passport.tier}`} />
                                </div>
                            </div>
                        </div>

                        {/* ── BACK FACE ── */}
                        <div className="passport-face passport-back">
                            <div className="passport-bg-effect" />
                            <div className="passport-back__content">
                                <div className="passport-back__logo">
                                    <span className="pi-emblem-large">π</span>
                                    <span>PiTrust Network</span>
                                </div>
                                <div className="passport-back__metadata">
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Security Clearance</span>
                                        <span className="back-meta__value" style={{ color: passport.red_flags.length ? '#ef4444' : '#10b981' }}>{passport.red_flags.length ? 'FLAGGED' : 'CLEAN'}</span>
                                    </div>
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Oracle Signature</span>
                                        <span className="back-meta__value sig-hash">0x{passport.wallet_address.slice(1, 9)}...{user?.uid?.slice(0, 6)}...</span>
                                    </div>
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Issue Authority</span>
                                        <span className="back-meta__value">Decentralized Trust Protocol</span>
                                    </div>
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Account Age</span>
                                        <span className="back-meta__value">Network Verified Pioneer</span>
                                    </div>
                                </div>
                                <div className="passport-back__stats">
                                    <div className="back-stat">
                                        <span className="back-stat__value">{passport.vouches_received}</span>
                                        <span className="back-stat__label">Endorsed By</span>
                                    </div>
                                    <div className="back-stat">
                                        <span className="back-stat__value">{passport.vouches_given}</span>
                                        <span className="back-stat__label">Vouches Given</span>
                                    </div>
                                </div>
                                <p className="passport-back__disclaimer">
                                    This Soulbound Token is non-transferable and anchored to the Stellar Soroban Network.
                                    It represents the immutable trust identity of its holder in the Pi ecosystem.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {passport.minted && (
                    <p className="card-hint animate-fade-up">Tap the card to flip</p>
                )}
            </div>

            {/* === Mint / Status section === */}
            {!passport.minted ? (
                <div className="mint-section frost-card animate-fade-up">
                    <div className="mint-header">
                        <div className="mint-badge">NEW</div>
                        <h2 className="mint-title">Claim Your Digital Identity</h2>
                    </div>
                    <p className="mint-description">
                        Your Soulbound Token is a permanent, non-transferable identity on Pi Network.
                        It anchors your trust score, vouches, and social credentials on-chain forever.
                        This is your passport to the trustless economy.
                    </p>

                    <div className="mint-benefits">
                        <div className="mint-benefit">
                            <span className="mint-benefit__icon">🔐</span>
                            <div>
                                <strong>Immutable Identity</strong>
                                <p>On-chain proof of your reputation</p>
                            </div>
                        </div>
                        <div className="mint-benefit">
                            <span className="mint-benefit__icon">📈</span>
                            <div>
                                <strong>Score Growth</strong>
                                <p>Build your trust score over time</p>
                            </div>
                        </div>
                        <div className="mint-benefit">
                            <span className="mint-benefit__icon">🤝</span>
                            <div>
                                <strong>Vouch Network</strong>
                                <p>Receive and give trust endorsements</p>
                            </div>
                        </div>
                    </div>

                    <div className="mint-details">
                        <div className="mint-detail-row">
                            <span>Mint Fee</span>
                            <strong>1 π</strong>
                        </div>
                        <div className="mint-detail-row">
                            <span>Token Type</span>
                            <strong>Soulbound (Non-transferable)</strong>
                        </div>
                        <div className="mint-detail-row">
                            <span>Network</span>
                            <strong>Stellar / Soroban</strong>
                        </div>
                        <div className="mint-detail-row">
                            <span>Starting Tier</span>
                            <strong>🛡️ Bronze Pioneer</strong>
                        </div>
                    </div>

                    {payError && (
                        <div className="mint-error badge badge-danger">{payError}</div>
                    )}

                    {payState === 'completed' ? (
                        <div className="mint-success">
                            <div className="success-check">✓</div>
                            <h3>Passport Minted!</h3>
                            <p>Welcome to the PiTrust network. Your trust journey begins now.</p>
                        </div>
                    ) : (
                        <button
                            className="btn btn-gold w-full mint-cta"
                            onClick={handleMint}
                            disabled={payState === 'awaiting_approval' || payState === 'processing'}
                        >
                            {payState === 'awaiting_approval' && '⏳ Waiting for approval...'}
                            {payState === 'processing' && '⛓️ Minting on-chain...'}
                            {(payState === 'idle' || payState === 'cancelled' || payState === 'error') && '✦ Mint Passport — 1 π'}
                        </button>
                    )}
                </div>
            ) : (
                <>
                    {/* Passport Status section for minted users */}
                    <div className="passport-stats-section animate-fade-up">
                        <h2 className="section-title">Passport Status</h2>
                        <div className="passport-stat-list">
                            <div className="passport-stat-item frost-card">
                                <span className="pstat-label">Red Flags</span>
                                <span className={`pstat-value ${passport.red_flags.length > 0 ? 'badge badge-danger' : 'badge badge-success'}`}>
                                    {passport.red_flags.length > 0 ? `${passport.red_flags.length} active` : 'Clean ✓'}
                                </span>
                            </div>
                            <div className="passport-stat-item frost-card">
                                <span className="pstat-label">Score Status</span>
                                <span className={`pstat-value badge ${passport.score_frozen ? 'badge-warning' : 'badge-success'}`}>
                                    {passport.score_frozen ? '⚠️ Frozen' : '✓ Active'}
                                </span>
                            </div>
                            <div className="passport-stat-item frost-card">
                                <span className="pstat-label">Network</span>
                                <span className="pstat-value badge badge-ghost">Stellar</span>
                            </div>
                        </div>

                        {/* Share button */}
                        <button className="btn btn-primary w-full share-btn" onClick={handleShare}>
                            📤 Share Passport
                        </button>

                        {passport.red_flags.length > 0 && (
                            <div className="recovery-prompt frost-card">
                                <h3>💊 Rehabilitation Available</h3>
                                <p>Lock 50 π for 12 months to begin score recovery. Your commitment is your reputation.</p>
                                <button className="btn btn-primary" style={{ marginTop: '12px' }}>
                                    Enter Recovery — 50 π
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Tier Progression section */}
                    <div className="tier-progression animate-fade-up">
                        <h2 className="section-title">Tier Progression</h2>
                        <div className="tier-track">
                            {(['bronze', 'silver', 'gold', 'platinum', 'sentinel'] as const).map((tier, i) => {
                                const thresholds = [0, 250, 500, 700, 900];
                                const isActive = passport.score >= thresholds[i];
                                const isCurrent = passport.tier === tier;
                                return (
                                    <div key={tier} className={`tier-track__item ${isActive ? 'reached' : ''} ${isCurrent ? 'current' : ''}`}>
                                        <div className={`tier-track__dot tier-${tier}`}>
                                            {isCurrent && <div className="tier-track__pulse" />}
                                        </div>
                                        <span className="tier-track__label">{tier.charAt(0).toUpperCase() + tier.slice(1)}</span>
                                        <span className="tier-track__threshold">{thresholds[i]}</span>
                                    </div>
                                );
                            })}
                            <div className="tier-track__line">
                                <div
                                    className="tier-track__progress"
                                    style={{ width: `${scorePercentage(passport.score)}%` }}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Gamified Quests section */}
                    <div className="quests-section animate-fade-up">
                        <h2 className="section-title" style={{ marginTop: '0' }}>Trust Quests</h2>
                        <div className="quest-list">
                            <div className="quest-card frost-card">
                                <div className="quest-info">
                                    <span className="quest-icon">𝕏</span>
                                    <div>
                                        <strong>Link X (Twitter)</strong>
                                        <p>+50 Score points • Identity Anchor</p>
                                    </div>
                                </div>
                                <button className="btn btn-primary btn-sm" onClick={() => completeQuest('social_link', 'Twitter')} disabled={questing}>Connect</button>
                            </div>
                            <div className="quest-card frost-card">
                                <div className="quest-info">
                                    <span className="quest-icon">💬</span>
                                    <div>
                                        <strong>Link Telegram</strong>
                                        <p>+50 Score points • Identity Anchor</p>
                                    </div>
                                </div>
                                <button className="btn btn-primary btn-sm" onClick={() => completeQuest('social_link', 'Telegram')} disabled={questing}>Connect</button>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
