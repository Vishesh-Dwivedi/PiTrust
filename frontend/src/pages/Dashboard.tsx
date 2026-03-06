/**
 * Dashboard — Premium Trust Command Center
 * Shows: TrustWeather, Animated Score Gauge, Score Pillars, Tier Progression, Activity, Quick Actions
 */
import { usePassport } from '../hooks/usePassport';
import { usePiAuth } from '../context/PiAuthContext';
import {
    tierLabel,
    tierColor,
    tierGlowClass,
    scorePercentage,
    trustWeatherCopy,
    formatWallet,
} from '../utils/helpers';
import { TrustWeather } from '../components/web3/TrustWeather';
import { DashboardSkeleton } from '../components/ui/Skeleton';
import './Dashboard.css';
import { useNavigate } from 'react-router-dom';

const TIER_THRESHOLDS = [
    { tier: 'Bronze', min: 0, max: 250, color: 'var(--tier-bronze)' },
    { tier: 'Silver', min: 250, max: 500, color: 'var(--tier-silver)' },
    { tier: 'Gold', min: 500, max: 700, color: 'var(--tier-gold)' },
    { tier: 'Platinum', min: 700, max: 900, color: 'var(--tier-platinum)' },
    { tier: 'Sentinel', min: 900, max: 1000, color: 'var(--tier-sentinel)' },
];

function getNextTier(score: number) {
    for (const t of TIER_THRESHOLDS) {
        if (score < t.max) return { ...t, pointsNeeded: t.max - score };
    }
    return null;
}

export function Dashboard() {
    const { user, loading: authLoading, error: authError } = usePiAuth();
    const { passport, loading: passportLoading } = usePassport();
    const navigate = useNavigate();

    // Show skeleton while loading
    if (authLoading || passportLoading) return <DashboardSkeleton />;

    // Not authenticated — show welcome/connect screen
    if (!user) return (
        <div className="dashboard">
            <div className="auth-required frost-card animate-fade-up">
                <div className="auth-required__icon">🛡️</div>
                <h2>Welcome to PiTrust</h2>
                <p>Your decentralized trust identity on the Pi Network.</p>
                <div style={{ margin: '24px 0', padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}>
                    <p style={{ fontWeight: 600, marginBottom: '8px' }}>To get started:</p>
                    <p style={{ fontSize: '14px', opacity: 0.8 }}>
                        Open <strong>trustpi.space</strong> inside the <strong>Pi Browser</strong> to authenticate with your Pi account, mint your Trust Passport, and start building your on-chain reputation.
                    </p>
                </div>
                {authError && (
                    <div style={{ padding: '12px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', borderRadius: '8px', color: '#fca5a5', fontSize: '14px', textAlign: 'left', marginTop: '16px' }}>
                        <strong>Authentication Error:</strong><br />
                        {authError}
                    </div>
                )}
                {!authError && (
                    <p className="auth-required__help" style={{ fontSize: '13px', opacity: 0.5, marginTop: '16px' }}>
                        Waiting for Pi SDK authorization...
                    </p>
                )}
            </div>
        </div>
    );

    if (!passport) return (
        <div className="dashboard">
            <div className="auth-required frost-card animate-fade-up">
                <div className="auth-required__icon">🎫</div>
                <h2>Mint Your Trust Passport</h2>
                <p>You're authenticated but haven't minted your passport yet.</p>
                <button
                    onClick={() => navigate('/passport')}
                    style={{ marginTop: '16px', padding: '12px 32px', borderRadius: '12px', background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', border: 'none', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '15px' }}
                >
                    Mint Passport — 1 π
                </button>
            </div>
        </div>
    );

    const weather = trustWeatherCopy(passport.score);
    const glowClass = tierGlowClass(passport.tier);
    const nextTier = getNextTier(passport.score);
    const scorePercent = scorePercentage(passport.score);

    // SVG arc gauge calculation
    const radius = 80;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (scorePercent / 100) * circumference;

    return (
        <div className="dashboard stagger">

            {/* === Trust Score Hero with Arc Gauge === */}
            <div className={`score-hero frost-card ${glowClass} animate-fade-up`}>
                <div
                    className="tier-orb"
                    style={{ background: `radial-gradient(circle, ${tierColor(passport.tier)}30 0%, transparent 70%)` }}
                    aria-hidden="true"
                />

                <div className="score-hero__top">
                    <div>
                        <p className="score-hero__eyebrow">Pioneer Trust Score</p>
                        <p className="score-hero__wallet">{formatWallet(passport.wallet_address)}</p>
                    </div>
                    <div className={`tier-badge ${passport.tier}`}>
                        {tierLabel(passport.tier)}
                    </div>
                </div>

                {/* Animated SVG Arc Gauge */}
                <div className="score-gauge">
                    <svg viewBox="0 0 200 200" className="score-gauge__svg">
                        {/* Background track */}
                        <circle
                            cx="100" cy="100" r={radius}
                            fill="none"
                            stroke="rgba(255,255,255,0.06)"
                            strokeWidth="10"
                            strokeLinecap="round"
                        />
                        {/* Score arc */}
                        <circle
                            cx="100" cy="100" r={radius}
                            fill="none"
                            stroke={tierColor(passport.tier)}
                            strokeWidth="10"
                            strokeLinecap="round"
                            strokeDasharray={circumference}
                            strokeDashoffset={strokeDashoffset}
                            className="score-gauge__arc"
                            style={{ '--dashoffset': strokeDashoffset } as any}
                        />
                        {/* Inner glow */}
                        <circle
                            cx="100" cy="100" r={radius}
                            fill="none"
                            stroke={tierColor(passport.tier)}
                            strokeWidth="10"
                            strokeLinecap="round"
                            strokeDasharray={circumference}
                            strokeDashoffset={strokeDashoffset}
                            className="score-gauge__glow"
                            style={{ filter: 'blur(8px)', opacity: 0.3 }}
                        />
                    </svg>
                    <div className="score-gauge__center">
                        <div className="score-gauge__value" style={{ color: tierColor(passport.tier) }}>
                            {passport.score}
                        </div>
                        <div className="score-gauge__max">/ 1,000</div>
                    </div>
                </div>

                {/* Next tier progress */}
                {nextTier && (
                    <div className="next-tier-hint">
                        <span>{nextTier.pointsNeeded} pts to</span>
                        <span className="next-tier-name" style={{ color: nextTier.color }}>{nextTier.tier}</span>
                    </div>
                )}

                {passport.score_frozen && (
                    <div className="frozen-notice badge badge-warning">
                        ⚠️ Score frozen — dispute active
                    </div>
                )}
            </div>

            {/* === Trust Weather === */}
            <div className="animate-fade-up">
                <TrustWeather headline={weather.headline} sub={weather.sub} />
            </div>

            {/* === Score Pillars as Individual Cards === */}
            <div className="pillars-grid animate-fade-up">
                <h2 className="section-title">Score Breakdown</h2>
                <div className="pillar-cards">
                    <div className="pillar-card frost-card">
                        <div className="pillar-card__header">
                            <span className="pillar-card__icon">⛓️</span>
                            <span className="pillar-card__label">On-Chain</span>
                        </div>
                        <div className="pillar-card__value">{passport.pillar_on_chain}</div>
                        <div className="pillar-card__bar">
                            <div className="pillar-card__fill" style={{
                                width: `${Math.min(100, (passport.pillar_on_chain / 400) * 100)}%`,
                                background: `linear-gradient(90deg, ${tierColor(passport.tier)}66, ${tierColor(passport.tier)})`
                            }} />
                        </div>
                        <span className="pillar-card__max">/ 400</span>
                    </div>
                    <div className="pillar-card frost-card">
                        <div className="pillar-card__header">
                            <span className="pillar-card__icon">🤝</span>
                            <span className="pillar-card__label">Vouch</span>
                        </div>
                        <div className="pillar-card__value">{passport.pillar_vouch}</div>
                        <div className="pillar-card__bar">
                            <div className="pillar-card__fill" style={{
                                width: `${Math.min(100, (passport.pillar_vouch / 300) * 100)}%`,
                                background: `linear-gradient(90deg, ${tierColor(passport.tier)}66, ${tierColor(passport.tier)})`
                            }} />
                        </div>
                        <span className="pillar-card__max">/ 300</span>
                    </div>
                    <div className="pillar-card frost-card">
                        <div className="pillar-card__header">
                            <span className="pillar-card__icon">👥</span>
                            <span className="pillar-card__label">Social</span>
                        </div>
                        <div className="pillar-card__value">{passport.pillar_social}</div>
                        <div className="pillar-card__bar">
                            <div className="pillar-card__fill" style={{
                                width: `${Math.min(100, (passport.pillar_social / 300) * 100)}%`,
                                background: `linear-gradient(90deg, ${tierColor(passport.tier)}66, ${tierColor(passport.tier)})`
                            }} />
                        </div>
                        <span className="pillar-card__max">/ 300</span>
                    </div>
                </div>
            </div>

            {/* === Quick stat row === */}
            <div className="stat-row animate-fade-up">
                <div className="stat-card frost-card">
                    <span className="stat-value">{passport.vouches_received}</span>
                    <span className="stat-label">Vouches In</span>
                </div>
                <div className="stat-card frost-card">
                    <span className="stat-value">{passport.vouches_given}</span>
                    <span className="stat-label">Vouches Out</span>
                </div>
                <div className="stat-card frost-card">
                    <span className="stat-value">{passport.red_flags.length}</span>
                    <span className="stat-label">Red Flags</span>
                </div>
            </div>

            {/* === Quick actions === */}
            <div className="quick-actions animate-fade-up">
                {!passport.minted && (
                    <button
                        className="btn btn-gold w-full"
                        onClick={() => navigate('/passport')}
                    >
                        <span>✦</span> Mint Your Passport — 1 π
                    </button>
                )}
                <button
                    className="btn btn-primary w-full"
                    onClick={() => navigate('/vouch')}
                >
                    🤝 Vouch for a Pioneer
                </button>
                <button
                    className="btn btn-ghost w-full"
                    onClick={() => navigate('/merchants')}
                >
                    Browse Merchants
                </button>
                <button
                    className="btn btn-ghost w-full"
                    onClick={() => navigate('/disputes')}
                >
                    ⚖️ View Disputes
                </button>
            </div>

        </div>
    );
}

