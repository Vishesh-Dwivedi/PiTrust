import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMerchants } from '../hooks/useMerchants';
import { formatWallet, shortTimeAgo, tierColor, tierLabel } from '../utils/helpers';
import './Merchants.css';

const MERCHANT_CATEGORIES = ['All', 'Retail', 'Food & Beverage', 'Services', 'Digital Goods', 'Education', 'Travel', 'Other'];

function buildBuyerPrecheck(merchant: {
    score: number;
    score_frozen: boolean;
    disputed_trades: number;
    completed_trades: number;
    active_red_flags: number;
}) {
    if (merchant.active_red_flags > 0) {
        return {
            tone: 'danger',
            headline: 'Review carefully before sending Pi',
            copy: 'Active warnings exist on this merchant passport. Open the full trust card before any payment.',
        };
    }

    if (merchant.score_frozen) {
        return {
            tone: 'warning',
            headline: 'Trust score is currently frozen',
            copy: 'This usually means a dispute or trust lock is active. Avoid larger transactions until it is resolved.',
        };
    }

    if (merchant.score >= 700 && merchant.completed_trades >= 5 && merchant.disputed_trades === 0) {
        return {
            tone: 'good',
            headline: 'Strong fit for regular Pi commerce',
            copy: 'High trust score, solid completion history, and no visible dispute drag in the merchant record.',
        };
    }

    if (merchant.score >= 400 && merchant.disputed_trades <= 1) {
        return {
            tone: 'neutral',
            headline: 'Reasonable for smaller transactions',
            copy: 'Signals are mostly positive, but open the full trust card and keep trade size proportional to history.',
        };
    }

    return {
        tone: 'neutral',
        headline: 'Early merchant record',
        copy: 'The merchant profile is live, but the trade trail is still thin. Start small and verify details first.',
    };
}

export function Merchants() {
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('');
    const { merchants, loading, error, refetch } = useMerchants({ category, search, limit: 12 });

    const categories = useMemo(() => MERCHANT_CATEGORIES, []);

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSearch(searchInput.trim());
    };

    return (
        <div className="merchants-page stagger">
            <section className="merchants-hero frost-card animate-fade-up">
                <div>
                    <p className="merchants-hero__eyebrow">Merchant discovery</p>
                    <h1>Check the merchant before the payment</h1>
                    <p className="merchants-hero__copy">
                        Browse merchant trust cards, compare score and dispute posture, and open the full passport before you send Pi.
                    </p>
                </div>

                <form className="merchant-search" onSubmit={handleSubmit}>
                    <label className="merchant-search__field merchant-search__field--wide">
                        <span>Search merchants</span>
                        <input
                            value={searchInput}
                            onChange={(event) => setSearchInput(event.target.value)}
                            placeholder="Merchant name, category, or location"
                        />
                    </label>
                    <label className="merchant-search__field">
                        <span>Category</span>
                        <select value={category} onChange={(event) => setCategory(event.target.value === 'All' ? '' : event.target.value)}>
                            {categories.map((option) => (
                                <option key={option} value={option === 'All' ? '' : option}>{option}</option>
                            ))}
                        </select>
                    </label>
                    <button className="btn btn-primary merchant-search__submit" type="submit">Refresh list</button>
                </form>
            </section>

            <section className="merchant-precheck-band frost-card animate-fade-up">
                <div>
                    <p className="merchants-hero__eyebrow">Buyer pre-check</p>
                    <h2>Three things to read before you pay</h2>
                </div>
                <div className="merchant-precheck-band__grid">
                    <div className="merchant-precheck-band__item">
                        <strong>Score + tier</strong>
                        <p>Treat the score as a summary, then inspect the full trust card for the reason behind it.</p>
                    </div>
                    <div className="merchant-precheck-band__item">
                        <strong>Disputes + warnings</strong>
                        <p>If dispute drag or red flags are visible, slow down and shrink transaction size.</p>
                    </div>
                    <div className="merchant-precheck-band__item">
                        <strong>Trade depth</strong>
                        <p>Prefer merchants with completed activity, not just a badge and a name.</p>
                    </div>
                </div>
            </section>

            {loading && (
                <div className="merchant-state frost-card animate-fade-up">
                    <div className="passport-loading__spinner" />
                    <p>Loading merchants...</p>
                </div>
            )}

            {!loading && error && (
                <div className="merchant-state frost-card animate-fade-up">
                    <h2>Could not load merchants</h2>
                    <p>{error}</p>
                    <button className="btn btn-primary" onClick={refetch}>Retry</button>
                </div>
            )}

            {!loading && !error && (
                <section className="merchant-grid animate-fade-up">
                    {merchants.length === 0 ? (
                        <div className="merchant-state frost-card">
                            <h2>No merchants match this filter</h2>
                            <p>Try a broader search or clear the category filter.</p>
                        </div>
                    ) : (
                        merchants.map((merchant) => {
                            const precheck = buildBuyerPrecheck(merchant);
                            return (
                                <article key={merchant.wallet_address} className="merchant-card frost-card">
                                    <div className="merchant-card__top">
                                        <div>
                                            <p className="merchant-card__eyebrow">{merchant.category}</p>
                                            <h2>{merchant.display_name}</h2>
                                            <p className="merchant-card__subline">
                                                {merchant.location || formatWallet(merchant.wallet_address)}
                                            </p>
                                        </div>
                                        <span className="merchant-card__badge">
                                            {merchant.badge ? 'Verified merchant' : 'Merchant profile'}
                                        </span>
                                    </div>

                                    <div className="merchant-card__scoreband">
                                        <div>
                                            <span className="merchant-card__score-label">Trust score</span>
                                            <strong style={{ color: tierColor(merchant.tier) }}>{merchant.score}</strong>
                                        </div>
                                        <div className="merchant-card__tier-pill" style={{ borderColor: tierColor(merchant.tier), color: tierColor(merchant.tier) }}>
                                            {tierLabel(merchant.tier)}
                                        </div>
                                    </div>

                                    {merchant.description && (
                                        <p className="merchant-card__description">{merchant.description}</p>
                                    )}

                                    <div className={`merchant-card__precheck ${precheck.tone}`}>
                                        <span className="merchant-card__precheck-label">Buyer pre-check</span>
                                        <strong>{precheck.headline}</strong>
                                        <p>{precheck.copy}</p>
                                    </div>

                                    <div className="merchant-card__stats">
                                        <div>
                                            <span>Completed</span>
                                            <strong>{merchant.completed_trades}</strong>
                                        </div>
                                        <div>
                                            <span>Disputes</span>
                                            <strong>{merchant.disputed_trades}</strong>
                                        </div>
                                        <div>
                                            <span>Warnings</span>
                                            <strong>{merchant.active_red_flags}</strong>
                                        </div>
                                        <div>
                                            <span>Listed</span>
                                            <strong>{shortTimeAgo(merchant.registered_at)}</strong>
                                        </div>
                                    </div>

                                    <div className="merchant-card__actions">
                                        <Link className="btn btn-ghost" to={`/trust/${encodeURIComponent(merchant.wallet_address)}`}>
                                            Check trust
                                        </Link>
                                        <Link className="btn btn-primary" to={`/trust/${encodeURIComponent(merchant.wallet_address)}`}>
                                            Buyer view
                                        </Link>
                                    </div>
                                </article>
                            );
                        })
                    )}
                </section>
            )}
        </div>
    );
}

