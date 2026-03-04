/**
 * Passport Page — 3D SBT card with gyroscope tilt + 1 Pi mint flow
 */
import { useState, useEffect, useRef } from 'react';
import { usePassport } from '../hooks/usePassport';
import { usePiPayment } from '../hooks/usePiPayment';
import { usePiAuth } from '../context/PiAuthContext';
import { tierLabel, tierColor, formatWallet } from '../utils/helpers';
import './Passport.css';

export function Passport() {
    const { user, loading: authLoading } = usePiAuth();
    const { passport, loading: passportLoading, refetch } = usePassport();
    const { state: payState, error: payError, pay } = usePiPayment();
    const cardRef = useRef<HTMLDivElement>(null);
    const [tilt, setTilt] = useState({ x: 0, y: 0 });

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

    // Mouse tilt fallback for desktop
    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
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

    if (authLoading || passportLoading || !passport) return (
        <div className="passport-page">
            <div className="passport-card-wrap">
                <div className="skeleton" style={{ width: '100%', aspectRatio: '1.6', borderRadius: '20px' }} />
            </div>
        </div>
    );

    const cardColor = tierColor(passport.tier);

    return (
        <div className="passport-page stagger">

            {/* === 3D Passport Card === */}
            <div className="passport-card-section animate-fade-up">
                <p className="passport-section-label">Your Soulbound Passport</p>

                <div
                    className="passport-card-wrap"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                >
                    <div
                        ref={cardRef}
                        className={`passport-card ${passport.tier} ${passport.minted ? 'minted' : 'unminted'}`}
                        style={{
                            transform: `perspective(700px) rotateX(${tilt.y}deg) rotateY(${tilt.x}deg)`,
                            boxShadow: passport.minted
                                ? `0 24px 80px ${cardColor}50, 0 8px 32px rgba(0,0,0,0.6)`
                                : '0 16px 60px rgba(0,0,0,0.5)',
                        }}
                    >
                        {/* Holographic foil overlay */}
                        <div
                            className="holo-foil"
                            style={{
                                backgroundPosition: `${50 + tilt.x * 2}% ${50 + tilt.y * 2}%`,
                            }}
                        />

                        {/* Card content */}
                        <div className="passport-card__top">
                            <div className="passport-card__network">
                                <span className="pi-hex">⬡</span> Pi Network
                            </div>
                            <div className="passport-card__type">
                                {passport.minted ? 'SOULBOUND PASSPORT' : 'NOT MINTED'}
                            </div>
                        </div>

                        <div className="passport-card__score-display">
                            <span className="passport-score">{passport.score}</span>
                            <span className="passport-tier-name" style={{ color: cardColor }}>
                                {tierLabel(passport.tier)}
                            </span>
                        </div>

                        <div className="passport-card__bottom">
                            <div className="passport-card__info">
                                <div className="passport-card__uid">{user?.username}</div>
                                <div className="passport-card__wallet">{formatWallet(passport.wallet_address)}</div>
                            </div>
                            <div className={`passport-card__orb ${passport.tier}`} />
                        </div>
                    </div>
                </div>
            </div>

            {/* === Mint / Status section === */}
            {!passport.minted ? (
                <div className="mint-section frost-card animate-fade-up">
                    <h2 className="mint-title">Mint Your Passport</h2>
                    <p className="mint-description">
                        Your Soulbound Token is a permanent, non-transferable identity on Pi Network.
                        It anchors your trust score, vouches, and social credentials on-chain forever.
                    </p>

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
                            <strong>Pi Testnet</strong>
                        </div>
                    </div>

                    {payError && (
                        <div className="mint-error badge badge-danger">{payError}</div>
                    )}

                    {payState === 'completed' ? (
                        <div className="mint-success">
                            <div className="success-check">✓</div>
                            <p>Passport Minted! Welcome to the PiTrust network.</p>
                        </div>
                    ) : (
                        <button
                            className="btn btn-gold w-full"
                            onClick={handleMint}
                            disabled={payState === 'awaiting_approval' || payState === 'processing'}
                        >
                            {payState === 'awaiting_approval' && 'Waiting for approval...'}
                            {payState === 'processing' && 'Processing on-chain...'}
                            {(payState === 'idle' || payState === 'cancelled' || payState === 'error') && '✦ Mint for 1 π'}
                        </button>
                    )}
                </div>
            ) : (
                <div className="passport-stats-section animate-fade-up">
                    <h2 className="section-title">Passport Status</h2>
                    <div className="passport-stat-list">
                        <div className="passport-stat-item frost-card">
                            <span className="pstat-label">Red Flags</span>
                            <span className={`pstat-value ${passport.red_flags.length > 0 ? 'badge badge-danger' : 'badge badge-success'}`}>
                                {passport.red_flags.length > 0 ? `${passport.red_flags.length} active` : 'Clean'}
                            </span>
                        </div>
                        <div className="passport-stat-item frost-card">
                            <span className="pstat-label">Score Status</span>
                            <span className={`pstat-value badge ${passport.score_frozen ? 'badge-warning' : 'badge-success'}`}>
                                {passport.score_frozen ? 'Frozen' : 'Active'}
                            </span>
                        </div>
                        <div className="passport-stat-item frost-card">
                            <span className="pstat-label">Network</span>
                            <span className="pstat-value badge badge-ghost">Pi Testnet</span>
                        </div>
                    </div>

                    {passport.red_flags.length > 0 && (
                        <div className="recovery-prompt frost-card">
                            <h3>Rehabilitation Available</h3>
                            <p>Lock 50 π for 12 months to begin score recovery. Your commitment is your reputation.</p>
                            <button className="btn btn-primary" style={{ marginTop: '12px' }}>
                                Enter Recovery — 50 π
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
