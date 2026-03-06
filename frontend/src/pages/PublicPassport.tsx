import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePublicPassport } from '../hooks/usePublicPassport';
import { formatPi, formatWallet, getCanonicalAppUrl, getCanonicalTrustUrl, shortTimeAgo, tierColor, tierLabel } from '../utils/helpers';
import './PublicPassport.css';

function historyToneClass(impact?: 'positive' | 'neutral' | 'warning') {
    if (impact === 'positive') return 'public-history__tone positive';
    if (impact === 'warning') return 'public-history__tone warning';
    return 'public-history__tone neutral';
}

export function PublicPassport() {
    const { walletOrUid = '' } = useParams();
    const navigate = useNavigate();
    const { passport, loading, error, notFound, refetch } = usePublicPassport(walletOrUid);
    const [lookupValue, setLookupValue] = useState(walletOrUid);

    useEffect(() => {
        setLookupValue(walletOrUid);
    }, [walletOrUid]);

    useEffect(() => {
        document.title = passport
            ? `${tierLabel(passport.tier)} Trust Passport | PiTrust`
            : 'Public Trust Passport | PiTrust';
        return () => {
            document.title = 'PiTrust';
        };
    }, [passport]);

    const scorePillars = useMemo(() => {
        if (!passport) return [];
        return [
            {
                key: 'on-chain',
                label: 'On-chain behavior',
                value: passport.score_breakdown.on_chain,
                max: 400,
                copy: `${passport.stats.completed_trades} completed trades and ${passport.stats.disputes_resolved} resolved disputes.`,
            },
            {
                key: 'vouch',
                label: 'Stake-backed vouches',
                value: passport.score_breakdown.vouch,
                max: 300,
                copy: `${passport.vouches_received} received, backed by ${formatPi(passport.stats.total_received_stake_pi)} in received stake.`,
            },
            {
                key: 'social',
                label: 'Verified proofs',
                value: passport.score_breakdown.social,
                max: 300,
                copy: `${passport.verified_social.length} linked social attestations currently support this passport.`,
            },
        ];
    }, [passport]);

    const trustSignals = useMemo(() => {
        if (!passport) return [];
        return [
            {
                label: 'Pi authenticated',
                value: passport.verification_flags.pi_authenticated ? 'Verified' : 'Unavailable',
                emphasis: passport.verification_flags.pi_authenticated ? 'good' : 'muted',
            },
            {
                label: 'Wallet continuity',
                value: passport.verification_flags.wallet_bound ? 'Bound' : 'Unconfirmed',
                emphasis: passport.verification_flags.wallet_bound ? 'good' : 'muted',
            },
            {
                label: 'Verified proofs',
                value: `${passport.verification_flags.social_verified_count}`,
                emphasis: passport.verification_flags.social_verified_count > 0 ? 'good' : 'muted',
            },
            {
                label: 'Active warnings',
                value: `${passport.red_flags.length}`,
                emphasis: passport.red_flags.length > 0 ? 'danger' : 'good',
            },
        ];
    }, [passport]);

    const buyerPrecheck = useMemo(() => {
        if (!passport) return null;

        const merchantCompleted = passport.merchant_profile?.completed_trades ?? passport.stats.completed_trades;
        const merchantDisputes = passport.merchant_profile?.disputed_trades ?? passport.stats.disputed_trades;
        const warnings = passport.red_flags.length;

        if (passport.merchant_profile) {
            if (warnings > 0 || passport.score_frozen) {
                return {
                    eyebrow: 'Buyer pre-check',
                    title: 'Pause and inspect before paying',
                    tone: 'danger',
                    summary: 'This merchant card has visible trust friction. Open the history and warning state before you send Pi.',
                    points: [
                        'Review the active warning count and recent disputes first.',
                        'Keep payment size small until trust signals improve.',
                        'Use the public trust history, not just the merchant badge.',
                    ],
                };
            }

            if (passport.score >= 700 && merchantCompleted >= 5 && merchantDisputes === 0) {
                return {
                    eyebrow: 'Buyer pre-check',
                    title: 'Looks strong for regular Pi commerce',
                    tone: 'good',
                    summary: 'The trust score, trade history, and warning posture all read clean enough for routine transactions.',
                    points: [
                        'Still inspect the full history if the payment amount is high.',
                        'Prefer merchants with repeat completed trades over fresh profiles.',
                        'Match the merchant location and category to the offer you received.',
                    ],
                };
            }

            return {
                eyebrow: 'Buyer pre-check',
                title: 'Promising, but read the trail first',
                tone: 'neutral',
                summary: 'This merchant has a usable trust card, but the history is not yet deep enough to rely on the score alone.',
                points: [
                    'Check disputes and completed trades before larger payments.',
                    'Start smaller if the merchant track record is still thin.',
                    'Use the shared trust card as the primary reference, not chat claims.',
                ],
            };
        }

        return {
            eyebrow: 'Reading guide',
            title: 'How to use this passport',
            tone: 'neutral',
            summary: 'Treat the score as a summary, then read the proofs, warnings, and trust history before transacting.',
            points: [
                'Use the score as a summary, not the whole story.',
                'Check warnings, disputes, and history before paying.',
                'Prefer passports with consistent proofs and completed activity.',
            ],
        };
    }, [passport]);
    const handleLookup = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const nextIdentifier = lookupValue.trim();
        if (!nextIdentifier) return;
        navigate(`/trust/${encodeURIComponent(nextIdentifier)}`);
    };

    const handleShare = async () => {
        if (!passport) return;
        const url = getCanonicalTrustUrl(passport.wallet_address);
        const title = `${tierLabel(passport.tier)} Trust Passport`;
        const text = `Check this PiTrust Passport before you trade. Score: ${passport.score}/1000.`;

        try {
            if (navigator.share) {
                await navigator.share({ title, text, url });
                return;
            }
        } catch (err) {
            console.warn('[PublicPassport] Web share cancelled or failed', err);
        }

        try {
            await navigator.clipboard.writeText(url);
            window.alert('Public passport link copied to clipboard.');
        } catch {
            window.alert(url);
        }
    };

    const handleOpenApp = () => {
        window.location.assign(getCanonicalAppUrl('/dashboard'));
    };

    const mintedDate = passport?.minted_at
        ? new Date(passport.minted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : null;
    const tierAccent = passport ? tierColor(passport.tier) : 'var(--accent-primary)';

    return (
        <div className="public-passport-page" style={{ '--passport-tier-color': tierAccent } as CSSProperties}>
            <section className="public-passport-hero frost-card">
                <div>
                    <p className="public-passport-hero__eyebrow">Public trust lookup</p>
                    <h1>Check trust before you trade</h1>
                    <p className="public-passport-hero__copy">
                        A PiTrust Passport makes reputation readable. Inspect score, proofs, warnings, and trust history before sending Pi.
                    </p>
                </div>

                <form className="public-passport-search" onSubmit={handleLookup}>
                    <label htmlFor="passport-lookup">Wallet or Pi UID</label>
                    <div className="public-passport-search__row">
                        <input
                            id="passport-lookup"
                            value={lookupValue}
                            onChange={(event) => setLookupValue(event.target.value)}
                            placeholder="Paste wallet or Pi UID"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                        <button className="btn btn-primary" type="submit">Lookup</button>
                    </div>
                </form>
            </section>

            {loading && (
                <div className="public-passport-state frost-card">
                    <div className="passport-loading__spinner" />
                    <p>Loading public trust card...</p>
                </div>
            )}

            {!loading && error && (
                <div className="public-passport-state frost-card">
                    <h2>Could not load public passport</h2>
                    <p>{error}</p>
                    <button className="btn btn-primary" onClick={refetch}>Retry</button>
                </div>
            )}

            {!loading && notFound && (
                <div className="public-passport-state frost-card">
                    <h2>No active passport found</h2>
                    <p>This identifier does not currently resolve to a minted PiTrust Passport.</p>
                    <button className="btn btn-ghost" onClick={handleOpenApp}>Open PiTrust App</button>
                </div>
            )}

            {!loading && passport && (
                <>
                    <section className="public-passport-card frost-card">
                        <div className="public-passport-card__top">
                            <div>
                                <p className="public-passport-card__eyebrow">{passport.merchant_profile ? 'Merchant trust card' : 'Public trust card'}</p>
                                <h2>{passport.merchant_profile ? passport.merchant_profile.display_name : passport.trust_summary.headline}</h2>
                                <p className="public-passport-card__copy">{passport.trust_summary.subline}</p>
                            </div>
                            <button className="btn btn-primary" onClick={handleShare}>Share Link</button>
                        </div>

                        <div className="public-passport-card__grid">
                            <div className="public-passport-card__score">
                                <span className="public-passport-card__score-label">Trust score</span>
                                <strong>{passport.score}</strong>
                                <span>/ 1000</span>
                            </div>

                            <div className="public-passport-card__identity">
                                <div>
                                    <span className="public-passport-card__meta-label">Tier</span>
                                    <strong>{tierLabel(passport.tier)}</strong>
                                </div>
                                {passport.merchant_profile && (
                                    <div>
                                        <span className="public-passport-card__meta-label">Merchant badge</span>
                                        <strong>{passport.merchant_profile.badge ? 'PiTrust Verified' : 'Registered merchant'}</strong>
                                    </div>
                                )}
                                <div>
                                    <span className="public-passport-card__meta-label">Wallet</span>
                                    <strong>{formatWallet(passport.wallet_address)}</strong>
                                </div>
                                <div>
                                    <span className="public-passport-card__meta-label">Minted</span>
                                    <strong>{mintedDate || 'Active'}</strong>
                                </div>
                                <div>
                                    <span className="public-passport-card__meta-label">Warnings</span>
                                    <strong>{passport.red_flags.length > 0 ? `${passport.red_flags.length} active` : 'None active'}</strong>
                                </div>
                            </div>
                        </div>
                    </section>

                    {passport.merchant_profile && (
                        <section className="public-merchant-panel frost-card">
                            <div className="public-section__header">
                                <p className="public-section__eyebrow">Merchant profile</p>
                                <h2>{passport.merchant_profile.verification_headline}</h2>
                            </div>
                            <p className="public-passport-card__copy">{passport.merchant_profile.verification_copy}</p>
                            <div className="public-merchant-panel__grid">
                                <div className="public-proof-item frost-card">
                                    <span>Category</span>
                                    <strong>{passport.merchant_profile.category}</strong>
                                </div>
                                <div className="public-proof-item frost-card">
                                    <span>Location</span>
                                    <strong>{passport.merchant_profile.location || 'Not listed'}</strong>
                                </div>
                                <div className="public-proof-item frost-card">
                                    <span>Merchant trades</span>
                                    <strong>{passport.merchant_profile.completed_trades} completed</strong>
                                </div>
                                <div className="public-proof-item frost-card">
                                    <span>Merchant disputes</span>
                                    <strong>{passport.merchant_profile.disputed_trades}</strong>
                                </div>
                            </div>
                            {passport.merchant_profile.description && (
                                <p className="public-merchant-panel__description">{passport.merchant_profile.description}</p>
                            )}
                        </section>
                    )}

                    {passport.red_flags.length > 0 && (
                        <section className="public-warning frost-card">
                            <p className="public-warning__eyebrow">Warning</p>
                            <h2>Active flags are present on this passport</h2>
                            <p>
                                Review the warning count and trust history carefully before completing any trade or sending Pi.
                            </p>
                        </section>
                    )}

                    <section className="public-section">
                        <div className="public-section__header">
                            <p className="public-section__eyebrow">At a glance</p>
                            <h2>Verified signals</h2>
                        </div>
                        <div className="public-signal-grid">
                            {trustSignals.map((signal) => (
                                <div key={signal.label} className="public-signal frost-card">
                                    <span className="public-signal__label">{signal.label}</span>
                                    <strong className={`public-signal__value ${signal.emphasis}`}>{signal.value}</strong>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className="public-section">
                        <div className="public-section__header">
                            <p className="public-section__eyebrow">Why this score</p>
                            <h2>Trust breakdown</h2>
                        </div>
                        <div className="public-breakdown-grid">
                            {scorePillars.map((pillar) => (
                                <div key={pillar.key} className="public-breakdown-card frost-card">
                                    <div className="public-breakdown-card__top">
                                        <span>{pillar.label}</span>
                                        <strong>{pillar.value}</strong>
                                    </div>
                                    <div className="public-breakdown-card__bar">
                                        <div
                                            className="public-breakdown-card__fill"
                                            style={{ width: `${Math.min(100, (pillar.value / pillar.max) * 100)}%` }}
                                        />
                                    </div>
                                    <p>{pillar.copy}</p>
                                </div>
                            ))}
                            <div className="public-breakdown-card frost-card public-breakdown-card--penalty">
                                <div className="public-breakdown-card__top">
                                    <span>Penalty drag</span>
                                    <strong>{passport.score_breakdown.penalties}</strong>
                                </div>
                                <p>Warnings stay visible. PiTrust should favor readable trust signals over flattering numbers.</p>
                            </div>
                        </div>
                    </section>

                    <section className="public-section public-section--two-column">
                        <div>
                            <div className="public-section__header">
                                <p className="public-section__eyebrow">Proofs</p>
                                <h2>Linked verification set</h2>
                            </div>
                            <div className="public-proof-list">
                                <div className="public-proof-item frost-card">
                                    <span>Wallet continuity</span>
                                    <strong>{formatWallet(passport.wallet_address)}</strong>
                                </div>
                                <div className="public-proof-item frost-card">
                                    <span>Vouch stake received</span>
                                    <strong>{formatPi(passport.stats.total_received_stake_pi)}</strong>
                                </div>
                                <div className="public-proof-item frost-card">
                                    <span>Verified socials</span>
                                    <strong>
                                        {passport.verified_social.length > 0
                                            ? passport.verified_social.map((item) => item.platform).join(', ')
                                            : 'None linked yet'}
                                    </strong>
                                </div>
                                <div className="public-proof-item frost-card">
                                    <span>Completed trades</span>
                                    <strong>{passport.stats.completed_trades}</strong>
                                </div>
                            </div>
                        </div>

                        <div className="public-trust-note frost-card">
                            <p className="public-section__eyebrow">{buyerPrecheck?.eyebrow}</p>
                            <h2>{buyerPrecheck?.title}</h2>
                            <div className={`public-trust-note__callout ${buyerPrecheck?.tone || 'neutral'}`}>
                                <p>{buyerPrecheck?.summary}</p>
                            </div>
                            <ul>
                                {buyerPrecheck?.points.map((point) => (
                                    <li key={point}>{point}</li>
                                ))}
                            </ul>
                            <button className="btn btn-ghost" onClick={handleOpenApp}>Open PiTrust</button>
                        </div>
                    </section>

                    <section className="public-section">
                        <div className="public-section__header">
                            <p className="public-section__eyebrow">History</p>
                            <h2>Recent trust events</h2>
                        </div>
                        <div className="public-history frost-card">
                            {passport.history.length === 0 ? (
                                <div className="public-history__empty">
                                    <h3>No trust events recorded yet</h3>
                                    <p>This passport is active, but the public event trail is still thin.</p>
                                </div>
                            ) : (
                                passport.history.map((event) => (
                                    <div key={event.id} className="public-history__item">
                                        <div className={historyToneClass(event.impact)} />
                                        <div className="public-history__body">
                                            <div className="public-history__topline">
                                                <strong>{event.title}</strong>
                                                <span>{shortTimeAgo(event.occurred_at)}</span>
                                            </div>
                                            <p>{event.detail}</p>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}

