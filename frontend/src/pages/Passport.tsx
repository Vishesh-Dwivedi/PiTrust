import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePassport } from '../hooks/usePassport';
import { usePiPayment } from '../hooks/usePiPayment';
import { usePiAuth } from '../context/PiAuthContext';
import { formatPi, formatWallet, scorePercentage, shortTimeAgo, tierColor, tierLabel } from '../utils/helpers';
import './Passport.css';

const TIER_MOTTOS: Record<string, string> = {
    bronze: 'Beginning the journey',
    silver: 'Earning trust',
    gold: 'Proven trailblazer',
    platinum: 'Elite counterparty',
    sentinel: 'Guardian of the network',
};

const SCORE_THRESHOLDS = [0, 250, 500, 700, 900];
const MERCHANT_MIN_SCORE = 200;
const MERCHANT_CATEGORIES = ['Retail', 'Food & Beverage', 'Services', 'Digital Goods', 'Education', 'Travel', 'Other'];

function historyToneClass(impact?: 'positive' | 'neutral' | 'warning') {
    if (impact === 'positive') return 'trust-history__tone positive';
    if (impact === 'warning') return 'trust-history__tone warning';
    return 'trust-history__tone neutral';
}

export function Passport() {
    const { user, loading: authLoading, accessToken } = usePiAuth();
    const { passport, loading: passportLoading, refetch, error: passportError } = usePassport();
    const { state: payState, error: payError, pay, reset: resetPayment } = usePiPayment(accessToken || undefined);
    const navigate = useNavigate();
    const cardRef = useRef<HTMLDivElement>(null);
    const [tilt, setTilt] = useState({ x: 0, y: 0 });
    const [isFlipped, setIsFlipped] = useState(false);
    const [questing, setQuesting] = useState(false);
    const [merchantForm, setMerchantForm] = useState({
        display_name: '',
        category: MERCHANT_CATEGORIES[0],
        location: '',
        description: '',
    });
    const [merchantFormError, setMerchantFormError] = useState<string | null>(null);

    useEffect(() => {
        const handleOrientation = (e: DeviceOrientationEvent) => {
            const x = Math.min(15, Math.max(-15, (e.gamma ?? 0) * 0.4));
            const y = Math.min(10, Math.max(-10, (e.beta ?? 0) * 0.2 - 5));
            setTilt({ x, y });
        };
        window.addEventListener('deviceorientation', handleOrientation);
        return () => window.removeEventListener('deviceorientation', handleOrientation);
    }, []);

    const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
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

    const handleMerchantRegister = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!passport) return;

        const display_name = merchantForm.display_name.trim();
        const category = merchantForm.category.trim();
        const location = merchantForm.location.trim();
        const description = merchantForm.description.trim();

        if (!display_name || !category) {
            setMerchantFormError('Display name and category are required.');
            return;
        }
        if (description.length > 240) {
            setMerchantFormError('Description must stay within 240 characters.');
            return;
        }
        if (location.length > 100) {
            setMerchantFormError('Location must stay within 100 characters.');
            return;
        }
        if (passport.score < MERCHANT_MIN_SCORE) {
            setMerchantFormError(`Merchant verification requires a trust score of at least ${MERCHANT_MIN_SCORE}.`);
            return;
        }
        if (passport.score_frozen) {
            setMerchantFormError('Merchant verification is unavailable while your score is frozen.');
            return;
        }

        setMerchantFormError(null);
        resetPayment();

        await pay(
            {
                amount: 5,
                memo: 'PiTrust Merchant Verification',
                metadata: {
                    type: 'merchant_registration',
                    display_name,
                    category,
                    description,
                    location,
                },
            },
            undefined,
            async () => { await refetch(); }
        );
    };

    const handleShare = async () => {
        if (!passport) return;

        const publicUrl = `${window.location.origin}/trust/${encodeURIComponent(passport.wallet_address)}`;
        const shareText = `I am ${tierLabel(passport.tier)} on PiTrust with a score of ${passport.score}/1000. Check trust before you trade.`;

        try {
            if (navigator.share) {
                await navigator.share({
                    title: 'My PiTrust Passport',
                    text: shareText,
                    url: publicUrl,
                });
                return;
            }
        } catch (err) {
            console.warn('[Passport] Share cancelled or failed', err);
        }

        if (window.Pi) {
            window.Pi.openShareDialog('My PiTrust Passport', `${shareText} ${publicUrl}`);
        }

        try {
            await navigator.clipboard.writeText(publicUrl);
            alert('Public passport link copied to clipboard.');
        } catch {
            alert(publicUrl);
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
                    Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ questId, platform }),
            });
            if (res.ok) {
                alert(`${platform} connected successfully. Your score will update soon.`);
                await refetch();
            } else {
                const data = await res.json();
                alert(`Error: ${data.error}`);
            }
        } catch {
            alert('Failed to complete quest');
        } finally {
            setQuesting(false);
        }
    };

    if (authLoading || passportLoading) {
        return (
            <div className="passport-page">
                <div className="passport-loading">
                    <div className="passport-loading__spinner" />
                    <p className="passport-loading__text">Loading your Passport...</p>
                </div>
            </div>
        );
    }

    if (passportError && !passport) {
        return (
            <div className="passport-page">
                <div className="passport-error frost-card">
                    <div className="passport-error__icon">!</div>
                    <h2>Could not load Passport</h2>
                    <p>{passportError}</p>
                    <button className="btn btn-primary" onClick={refetch}>Retry</button>
                </div>
            </div>
        );
    }

    if (!passport) return null;

    const cardColor = tierColor(passport.tier);
    const mintDate = passport.minted_at
        ? new Date(passport.minted_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
        : null;
    const scoreRingStyle = {
        '--ring-progress': `${scorePercentage(passport.score)}%`,
        '--ring-color': cardColor,
    } as CSSProperties;

    const trustSignals = [
        {
            label: 'Pi authenticated',
            value: passport.verification_flags.pi_authenticated ? 'Verified' : 'Pending',
            emphasis: passport.verification_flags.pi_authenticated ? 'good' : 'muted',
        },
        {
            label: 'Wallet bound',
            value: passport.verification_flags.wallet_bound ? 'Bound' : 'Pending',
            emphasis: passport.verification_flags.wallet_bound ? 'good' : 'muted',
        },
        {
            label: 'Verified socials',
            value: `${passport.verification_flags.social_verified_count}`,
            emphasis: passport.verification_flags.social_verified_count > 0 ? 'good' : 'muted',
        },
        {
            label: 'Active warnings',
            value: `${passport.red_flags.length}`,
            emphasis: passport.red_flags.length > 0 ? 'danger' : 'good',
        },
    ];

    const scorePillars = [
        {
            key: 'on-chain',
            label: 'On-chain behavior',
            value: passport.score_breakdown.on_chain,
            max: 400,
            copy: `${passport.stats.completed_trades} completed trades, ${passport.stats.disputes_resolved} resolved disputes, ${passport.stats.disputed_trades} disputed trades.`,
        },
        {
            key: 'vouch',
            label: 'Stake-backed vouches',
            value: passport.score_breakdown.vouch,
            max: 300,
            copy: `${passport.vouches_received} received and ${passport.vouches_given} given, backed by ${formatPi(passport.stats.total_received_stake_pi)} received stake.`,
        },
        {
            key: 'social',
            label: 'Verified proofs',
            value: passport.score_breakdown.social,
            max: 300,
            copy: `${passport.verified_social.length} verified social attestations currently linked to this passport.`,
        },
    ];

    const merchantEligible = passport.score >= MERCHANT_MIN_SCORE && !passport.score_frozen;
    const merchantPointsNeeded = Math.max(0, MERCHANT_MIN_SCORE - passport.score);
    const merchantGateCopy = passport.score_frozen
        ? 'Resolve the active dispute on your Passport before applying for merchant verification.'
        : merchantPointsNeeded > 0
            ? `You need ${merchantPointsNeeded} more trust points to unlock merchant verification.`
            : 'Your Passport is eligible for merchant verification.';

    return (
        <div className="passport-page stagger">
            <div className="passport-card-section animate-fade-up">
                <p className="passport-section-label">
                    {passport.minted ? 'Your Trust Passport' : 'Mint Your Trust Passport'}
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
                        <div className="passport-face passport-front">
                            <div className="passport-bg-effect" />
                            <div
                                className="holo-foil"
                                style={{ backgroundPosition: `${50 + tilt.x * 3}% ${50 + tilt.y * 3}%` }}
                            />
                            {passport.tier === 'sentinel' && <div className="scan-line" />}

                            <div className="passport-card__header">
                                <div className="passport-card__brand">
                                    <span className="pi-emblem">PI</span>
                                    <span className="brand-text">PiTrust</span>
                                </div>
                                <div className="passport-card__type">
                                    {passport.minted ? 'TRUST PASSPORT' : 'NOT MINTED'}
                                </div>
                            </div>

                            <div className="passport-card__score-block">
                                <div className="score-ring" style={scoreRingStyle}>
                                    <span className="score-ring__value">{passport.score}</span>
                                    <span className="score-ring__max">/1000</span>
                                </div>
                                <div className="passport-card__tier-info">
                                    <span className="tier-name" style={{ color: cardColor }}>
                                        {tierLabel(passport.tier)}
                                    </span>
                                    <span className="tier-motto">{TIER_MOTTOS[passport.tier]}</span>
                                    <p className="passport-card__headline">{passport.trust_summary.headline}</p>
                                </div>
                            </div>

                            <div className="passport-card__pillars">
                                {scorePillars.map((pillar) => (
                                    <div key={pillar.key} className="pillar-mini">
                                        <span className="pillar-mini__label">{pillar.label}</span>
                                        <div className="pillar-mini__bar">
                                            <div
                                                className="pillar-mini__fill"
                                                style={{
                                                    width: `${Math.min(100, (pillar.value / pillar.max) * 100)}%`,
                                                    background: cardColor,
                                                }}
                                            />
                                        </div>
                                        <span className="pillar-mini__value">{pillar.value}</span>
                                    </div>
                                ))}
                            </div>

                            <div className="passport-card__footer">
                                <div className="passport-card__identity">
                                    <div className="passport-card__username">@{user?.username || 'pioneer'}</div>
                                    <div className="passport-card__wallet">{formatWallet(passport.wallet_address)}</div>
                                </div>
                                <div className="passport-card__meta">
                                    {mintDate && <div className="passport-card__since">Since {mintDate}</div>}
                                    <div className={`passport-card__orb tier-${passport.tier}`} />
                                </div>
                            </div>
                        </div>

                        <div className="passport-face passport-back">
                            <div className="passport-bg-effect" />
                            <div className="passport-back__content">
                                <div className="passport-back__logo">
                                    <span className="pi-emblem-large">PI</span>
                                    <span>PiTrust Network</span>
                                </div>
                                <div className="passport-back__metadata">
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Trust headline</span>
                                        <span className="back-meta__value">{passport.trust_summary.headline}</span>
                                    </div>
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Warnings</span>
                                        <span className="back-meta__value" style={{ color: passport.red_flags.length ? '#ef4444' : '#10b981' }}>
                                            {passport.red_flags.length ? `${passport.red_flags.length} active` : 'No active flags'}
                                        </span>
                                    </div>
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Verified proofs</span>
                                        <span className="back-meta__value">{passport.verified_social.length} linked</span>
                                    </div>
                                    <div className="back-meta-item">
                                        <span className="back-meta__label">Last score refresh</span>
                                        <span className="back-meta__value">
                                            {passport.last_score_update ? shortTimeAgo(passport.last_score_update) : 'Awaiting refresh'}
                                        </span>
                                    </div>
                                </div>
                                <div className="passport-back__stats">
                                    <div className="back-stat">
                                        <span className="back-stat__value">{passport.vouches_received}</span>
                                        <span className="back-stat__label">Endorsed By</span>
                                    </div>
                                    <div className="back-stat">
                                        <span className="back-stat__value">{passport.stats.completed_trades}</span>
                                        <span className="back-stat__label">Completed Trades</span>
                                    </div>
                                </div>
                                <p className="passport-back__disclaimer">
                                    This passport summarizes portable trust signals for Pi commerce. Use it to decide who to trust before you trade.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {passport.minted && <p className="card-hint animate-fade-up">Tap the card to flip</p>}
            </div>

            {!passport.minted ? (
                <div className="mint-section frost-card animate-fade-up">
                    <div className="mint-header">
                        <div className="mint-badge">LIVE</div>
                        <h2 className="mint-title">Mint your commerce-trust passport</h2>
                    </div>
                    <p className="mint-description">
                        Pay 1 Pi once to activate your public trust card. Minting unlocks a readable score, stake-backed vouches, dispute eligibility, and a passport you can share before you trade.
                    </p>

                    <div className="mint-benefits">
                        <div className="mint-benefit">
                            <span className="mint-benefit__icon">01</span>
                            <div>
                                <strong>Public trust card</strong>
                                <p>Show score, tier, proofs, and trust history in one place.</p>
                            </div>
                        </div>
                        <div className="mint-benefit">
                            <span className="mint-benefit__icon">02</span>
                            <div>
                                <strong>Stake-backed vouches</strong>
                                <p>Give and receive social proof that carries economic weight.</p>
                            </div>
                        </div>
                        <div className="mint-benefit">
                            <span className="mint-benefit__icon">03</span>
                            <div>
                                <strong>Dispute-ready identity</strong>
                                <p>Build a trade history others can inspect before paying you.</p>
                            </div>
                        </div>
                    </div>

                    <div className="mint-details">
                        <div className="mint-detail-row">
                            <span>Mint fee</span>
                            <strong>1 Pi</strong>
                        </div>
                        <div className="mint-detail-row">
                            <span>Unlocks</span>
                            <strong>Passport, score, vouches, disputes</strong>
                        </div>
                        <div className="mint-detail-row">
                            <span>Starting tier</span>
                            <strong>Bronze Pioneer</strong>
                        </div>
                        <div className="mint-detail-row">
                            <span>Primary use</span>
                            <strong>Trust before commerce</strong>
                        </div>
                    </div>

                    {payError && <div className="mint-error badge badge-danger">{payError}</div>}

                    {payState === 'completed' ? (
                        <div className="mint-success">
                            <div className="success-check">OK</div>
                            <h3>Passport minted</h3>
                            <p>Your trust card is now live. Start building history and linking proofs.</p>
                        </div>
                    ) : (
                        <button
                            className="btn btn-gold w-full mint-cta"
                            onClick={handleMint}
                            disabled={payState === 'awaiting_approval' || payState === 'processing'}
                        >
                            {payState === 'awaiting_approval' && 'Waiting for approval...'}
                            {payState === 'processing' && 'Minting passport...'}
                            {(payState === 'idle' || payState === 'cancelled' || payState === 'error') && 'Mint Passport - 1 Pi'}
                        </button>
                    )}
                </div>
            ) : (
                <>
                    <div className="passport-summary frost-card animate-fade-up">
                        <div>
                            <p className="passport-summary__eyebrow">Trust summary</p>
                            <h2 className="passport-summary__title">{passport.trust_summary.headline}</h2>
                            <p className="passport-summary__copy">{passport.trust_summary.subline}</p>
                        </div>
                        <div className="passport-summary__actions">
                            <button className="btn btn-ghost share-btn" onClick={() => navigate(`/trust/${encodeURIComponent(passport.wallet_address)}`)}>View Public Card</button>
                            <button className="btn btn-primary share-btn" onClick={() => { void handleShare(); }}>Share Passport</button>
                        </div>
                    </div>

                    <div className="trust-signal-grid animate-fade-up">
                        {trustSignals.map((signal) => (
                            <div key={signal.label} className="trust-signal frost-card">
                                <span className="trust-signal__label">{signal.label}</span>
                                <span className={`trust-signal__value ${signal.emphasis}`}>{signal.value}</span>
                            </div>
                        ))}
                    </div>

                    <div className="passport-section-block animate-fade-up">
                        <h2 className="section-title">Why this score</h2>
                        <div className="score-breakdown-grid">
                            {scorePillars.map((pillar) => (
                                <div key={pillar.key} className="score-breakdown-card frost-card">
                                    <div className="score-breakdown-card__top">
                                        <span className="score-breakdown-card__label">{pillar.label}</span>
                                        <strong>{pillar.value}</strong>
                                    </div>
                                    <div className="score-breakdown-card__bar">
                                        <div
                                            className="score-breakdown-card__fill"
                                            style={{ width: `${Math.min(100, (pillar.value / pillar.max) * 100)}%`, background: cardColor }}
                                        />
                                    </div>
                                    <p className="score-breakdown-card__copy">{pillar.copy}</p>
                                </div>
                            ))}
                            <div className="score-breakdown-card frost-card score-breakdown-card--penalty">
                                <div className="score-breakdown-card__top">
                                    <span className="score-breakdown-card__label">Penalty drag</span>
                                    <strong>{passport.score_breakdown.penalties}</strong>
                                </div>
                                <p className="score-breakdown-card__copy">
                                    Active flags reduce trust and should remain visible. Score clarity matters more than flattering numbers.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="passport-section-block animate-fade-up">
                        <h2 className="section-title">Verified proofs</h2>
                        <div className="proof-list">
                            <div className="proof-item frost-card">
                                <span className="proof-item__label">Pi authentication</span>
                                <strong>{passport.verification_flags.pi_authenticated ? 'Verified' : 'Pending'}</strong>
                            </div>
                            <div className="proof-item frost-card">
                                <span className="proof-item__label">Wallet continuity</span>
                                <strong>{passport.verification_flags.wallet_bound ? formatWallet(passport.wallet_address) : 'Pending'}</strong>
                            </div>
                            <div className="proof-item frost-card">
                                <span className="proof-item__label">Verified socials</span>
                                <strong>
                                    {passport.verified_social.length > 0
                                        ? passport.verified_social.map((item) => item.platform).join(', ')
                                        : 'None linked yet'}
                                </strong>
                            </div>
                            <div className="proof-item frost-card">
                                <span className="proof-item__label">Vouch stake received</span>
                                <strong>{formatPi(passport.stats.total_received_stake_pi)}</strong>
                            </div>
                        </div>
                    </div>

                    {passport.merchant_profile ? (
                        <div className="passport-section-block animate-fade-up">
                            <h2 className="section-title">Merchant trust profile</h2>
                            <div className="merchant-profile frost-card">
                                <div className="merchant-profile__top">
                                    <div>
                                        <p className="passport-summary__eyebrow">Merchant spotlight</p>
                                        <h3 className="merchant-profile__title">{passport.merchant_profile.display_name}</h3>
                                        <p className="merchant-profile__copy">{passport.merchant_profile.verification_copy}</p>
                                    </div>
                                    <span className={`badge ${passport.merchant_profile.badge ? 'badge-success' : 'badge-warning'}`}>
                                        {passport.merchant_profile.badge ? 'Verified merchant' : 'Review status'}
                                    </span>
                                </div>
                                <div className="merchant-profile__grid">
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Category</span>
                                        <strong>{passport.merchant_profile.category}</strong>
                                    </div>
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Location</span>
                                        <strong>{passport.merchant_profile.location || 'Not listed'}</strong>
                                    </div>
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Merchant trades</span>
                                        <strong>{passport.merchant_profile.completed_trades} completed</strong>
                                    </div>
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Merchant disputes</span>
                                        <strong>{passport.merchant_profile.disputed_trades}</strong>
                                    </div>
                                </div>
                                {passport.merchant_profile.description && (
                                    <p className="merchant-profile__description">{passport.merchant_profile.description}</p>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="passport-section-block animate-fade-up">
                            <h2 className="section-title">Become a verified merchant</h2>
                            <div className="merchant-onboarding frost-card">
                                <div className="merchant-onboarding__top">
                                    <div>
                                        <p className="passport-summary__eyebrow">Merchant activation</p>
                                        <h3 className="merchant-profile__title">Turn your Passport into a merchant trust card</h3>
                                        <p className="merchant-profile__copy">
                                            Register once to unlock a verified merchant badge, public merchant profile, and buyer-facing trust context before payment.
                                        </p>
                                    </div>
                                    <div className={`merchant-onboarding__status ${merchantEligible ? 'eligible' : 'locked'}`}>
                                        <strong>{merchantEligible ? 'Eligible now' : 'Not unlocked yet'}</strong>
                                        <span>{merchantGateCopy}</span>
                                    </div>
                                </div>

                                <div className="merchant-onboarding__requirements">
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Verification fee</span>
                                        <strong>5 Pi</strong>
                                    </div>
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Minimum score</span>
                                        <strong>{MERCHANT_MIN_SCORE}+</strong>
                                    </div>
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Current score</span>
                                        <strong>{passport.score}</strong>
                                    </div>
                                    <div className="proof-item frost-card">
                                        <span className="proof-item__label">Status</span>
                                        <strong>{passport.score_frozen ? 'Frozen' : 'Ready for review'}</strong>
                                    </div>
                                </div>

                                <form className="merchant-form" onSubmit={(event) => { void handleMerchantRegister(event); }}>
                                    <div className="merchant-form__grid">
                                        <label className="merchant-field">
                                            <span>Display name</span>
                                            <input
                                                value={merchantForm.display_name}
                                                onChange={(event) => setMerchantForm((current) => ({ ...current, display_name: event.target.value }))}
                                                placeholder="How buyers should see your shop"
                                                maxLength={100}
                                            />
                                        </label>
                                        <label className="merchant-field">
                                            <span>Category</span>
                                            <select
                                                value={merchantForm.category}
                                                onChange={(event) => setMerchantForm((current) => ({ ...current, category: event.target.value }))}
                                            >
                                                {MERCHANT_CATEGORIES.map((category) => (
                                                    <option key={category} value={category}>{category}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="merchant-field">
                                            <span>Location</span>
                                            <input
                                                value={merchantForm.location}
                                                onChange={(event) => setMerchantForm((current) => ({ ...current, location: event.target.value }))}
                                                placeholder="City, region, or delivery zone"
                                                maxLength={100}
                                            />
                                        </label>
                                        <label className="merchant-field merchant-field--wide">
                                            <span>Description</span>
                                            <textarea
                                                value={merchantForm.description}
                                                onChange={(event) => setMerchantForm((current) => ({ ...current, description: event.target.value }))}
                                                placeholder="What do you sell and why should buyers trust you?"
                                                maxLength={240}
                                                rows={4}
                                            />
                                        </label>
                                    </div>

                                    <div className="merchant-form__footer">
                                        <p className="merchant-form__note">
                                            Your merchant profile becomes part of your public trust card and is visible to buyers before they pay.
                                        </p>
                                        <div className="merchant-form__actions">
                                            {merchantFormError && <div className="mint-error badge badge-danger">{merchantFormError}</div>}
                                            {payError && <div className="mint-error badge badge-danger">{payError}</div>}
                                            <button className="btn btn-gold" type="submit" disabled={!merchantEligible || payState === 'awaiting_approval' || payState === 'processing'}>
                                                {payState === 'awaiting_approval' && 'Waiting for approval...'}
                                                {payState === 'processing' && 'Activating merchant profile...'}
                                                {(payState === 'idle' || payState === 'cancelled' || payState === 'error' || payState === 'completed') && 'Verify Merchant - 5 Pi'}
                                            </button>
                                        </div>
                                    </div>
                                </form>
                            </div>
                        </div>
                    )}

                    <div className="passport-section-block animate-fade-up">
                        <h2 className="section-title">Trust history</h2>
                        <div className="trust-history frost-card">
                            {passport.history.length === 0 ? (
                                <div className="trust-history__empty">
                                    <h3>No trust events yet</h3>
                                    <p>Minted passports become more useful as vouches, verified proofs, and trade outcomes accumulate.</p>
                                </div>
                            ) : (
                                passport.history.map((event) => (
                                    <div key={event.id} className="trust-history__item">
                                        <div className={historyToneClass(event.impact)} />
                                        <div className="trust-history__body">
                                            <div className="trust-history__topline">
                                                <strong>{event.title}</strong>
                                                <span>{shortTimeAgo(event.occurred_at)}</span>
                                            </div>
                                            <p>{event.detail}</p>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="tier-progression animate-fade-up">
                        <h2 className="section-title">Tier progression</h2>
                        <div className="tier-track">
                            {(['bronze', 'silver', 'gold', 'platinum', 'sentinel'] as const).map((tier, index) => {
                                const isActive = passport.score >= SCORE_THRESHOLDS[index];
                                const isCurrent = passport.tier === tier;
                                return (
                                    <div key={tier} className={`tier-track__item ${isActive ? 'reached' : ''} ${isCurrent ? 'current' : ''}`}>
                                        <div className={`tier-track__dot tier-${tier}`}>
                                            {isCurrent && <div className="tier-track__pulse" />}
                                        </div>
                                        <span className="tier-track__label">{tier.charAt(0).toUpperCase() + tier.slice(1)}</span>
                                        <span className="tier-track__threshold">{SCORE_THRESHOLDS[index]}</span>
                                    </div>
                                );
                            })}
                            <div className="tier-track__line">
                                <div className="tier-track__progress" style={{ width: `${scorePercentage(passport.score)}%` }} />
                            </div>
                        </div>
                    </div>

                    <div className="quests-section animate-fade-up">
                        <h2 className="section-title" style={{ marginTop: '0' }}>Trust quests</h2>
                        <div className="quest-list">
                            <div className="quest-card frost-card">
                                <div className="quest-info">
                                    <span className="quest-icon">X</span>
                                    <div>
                                        <strong>Link X</strong>
                                        <p>Add a visible identity anchor and improve your proof set.</p>
                                    </div>
                                </div>
                                <button className="btn btn-primary btn-sm" onClick={() => completeQuest('social_link', 'Twitter')} disabled={questing}>Connect</button>
                            </div>
                            <div className="quest-card frost-card">
                                <div className="quest-info">
                                    <span className="quest-icon">TG</span>
                                    <div>
                                        <strong>Link Telegram</strong>
                                        <p>Give buyers and counterparties more confidence in your continuity.</p>
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







