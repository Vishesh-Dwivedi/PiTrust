/**
 * Dashboard — the Trust Command Center
 * Shows: TrustWeather, PiScore with tier glow, Score Radar, and quick actions
 */
import { usePassport } from '../hooks/usePassport';
import { usePiAuth } from '../context/PiAuthContext';
import {
    tierLabel,
    tierColor,
    tierGlowClass,
    tierScoreClass,
    scorePercentage,
    trustWeatherCopy,
    formatWallet,
} from '../utils/helpers';
import { ScoreRadar } from '../components/web3/ScoreRadar';
import { TrustWeather } from '../components/web3/TrustWeather';
import { DashboardSkeleton } from '../components/ui/Skeleton';
import './Dashboard.css';
import { useNavigate } from 'react-router-dom';

export function Dashboard() {
    const { loading: authLoading } = usePiAuth();
    const { passport, loading: passportLoading } = usePassport();
    const navigate = useNavigate();

    // Show skeleton while auth resolves OR while passport is fetching
    if (authLoading || passportLoading || !passport) return <DashboardSkeleton />;

    const weather = trustWeatherCopy(passport.score);
    const glowClass = tierGlowClass(passport.tier);

    return (
        <div className="dashboard stagger">

            {/* === Trust Score Hero Card === */}
            <div className={`score-hero frost-card ${glowClass} animate-fade-up`}>
                {/* Tier ambient glow orb */}
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

                <div className="score-hero__main">
                    <div
                        className={`score-numeral ${tierScoreClass(passport.tier)}`}
                        style={{ textShadow: `0 0 32px ${tierColor(passport.tier)}60` }}
                    >
                        {passport.score}
                    </div>
                    <div className="score-label">/ 1000</div>
                </div>

                {/* Progress arc */}
                <div className="score-progress">
                    <div className="score-progress__track">
                        <div
                            className="score-progress__fill"
                            style={{
                                width: `${scorePercentage(passport.score)}%`,
                                background: `linear-gradient(90deg, ${tierColor(passport.tier)}88, ${tierColor(passport.tier)})`,
                            }}
                        />
                    </div>
                    <div className="score-progress__labels">
                        <span>0</span>
                        <span>500</span>
                        <span>1000</span>
                    </div>
                </div>

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

            {/* === Score Pillars === */}
            <div className="pillars-section animate-fade-up">
                <h2 className="section-title">Score Breakdown</h2>
                <ScoreRadar
                    onChain={passport.pillar_on_chain}
                    vouch={passport.pillar_vouch}
                    social={passport.pillar_social}
                />
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
                    Vouch for a Pioneer
                </button>
            </div>

        </div>
    );
}
