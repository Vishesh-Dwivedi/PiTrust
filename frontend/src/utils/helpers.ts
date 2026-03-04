/**
 * Utility helpers — formatting, score math, tier logic
 */

import type { PiPayment } from './piTypes';

export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'sentinel';

export function scoreToTier(score: number): Tier {
    if (score >= 900) return 'sentinel';
    if (score >= 700) return 'platinum';
    if (score >= 500) return 'gold';
    if (score >= 250) return 'silver';
    return 'bronze';
}

export function tierLabel(tier: Tier): string {
    return {
        bronze: 'Bronze Pioneer',
        silver: 'Silver Pioneer',
        gold: 'Gold Trailblazer',
        platinum: 'Platinum Vanguard',
        sentinel: 'Sentinel Guardian',
    }[tier];
}

export function tierColor(tier: Tier): string {
    return {
        bronze: 'var(--tier-bronze)',
        silver: 'var(--tier-silver)',
        gold: 'var(--tier-gold)',
        platinum: 'var(--tier-platinum)',
        sentinel: 'var(--tier-sentinel)',
    }[tier];
}

export function tierGlowClass(tier: Tier): string {
    return `glow-${tier}`;
}

export function tierScoreClass(tier: Tier): string {
    return `score-${tier}`;
}

export function formatPi(amount: number): string {
    return `π ${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 })}`;
}

export function formatWallet(address: string): string {
    if (!address || address.length < 10) return address;
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function scorePercentage(score: number): number {
    return Math.min(100, Math.max(0, (score / 1000) * 100));
}

export function trustWeatherCopy(score: number): { headline: string; sub: string } {
    if (score >= 900) return {
        headline: '🌟 Top 1% Network Sentinel',
        sub: 'The community trusts you at the highest level.',
    };
    if (score >= 700) return {
        headline: '⚡ Outstanding Reliability',
        sub: 'Your on-chain history speaks for itself.',
    };
    if (score >= 500) return {
        headline: '✅ Solid Reputation',
        sub: 'Vouchers & history show consistent character.',
    };
    if (score >= 250) return {
        headline: '📈 Building Momentum',
        sub: 'Keep transacting — your score is growing.',
    };
    if (score >= 50) return {
        headline: '🌱 Getting Started',
        sub: 'Mint your passport to begin your trust journey.',
    };
    return {
        headline: '⚠️ Reputation at Risk',
        sub: 'Active flags detected. Consider recovery options.',
    };
}

export function handleIncompletePayment(payment: PiPayment): void {
    // In production, call backend to resolve the incomplete payment
    console.warn('[PiTrust] Incomplete payment found:', payment.identifier);
}

export function shortTimeAgo(isoDate: string): string {
    const diff = (Date.now() - new Date(isoDate).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}
