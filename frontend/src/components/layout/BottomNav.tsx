/**
 * BottomNav — mobile-first thumb-zone navigation
 * Fixed at the bottom with safe-area handling
 */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import './BottomNav.css';

interface NavItem {
    to: string;
    icon: ReactNode;
    label: string;
}

const ShieldIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
);

const IdCardIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <circle cx="8" cy="12" r="2" />
        <path d="M14 9h4M14 13h4M5 19l2-7" />
    </svg>
);

const HandshakeIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
        <path d="M9 12h6M12 9v6" />
    </svg>
);

const GavelIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2L22 10 10 22 2 14 14 2z" />
        <path d="M9 9l6 6M3 21l4-4" />
    </svg>
);

const navItems: NavItem[] = [
    { to: '/dashboard', icon: <ShieldIcon />, label: 'Trust' },
    { to: '/passport', icon: <IdCardIcon />, label: 'Passport' },
    { to: '/vouch', icon: <HandshakeIcon />, label: 'Vouch' },
    { to: '/disputes', icon: <GavelIcon />, label: 'Disputes' },
];

export function BottomNav() {
    return (
        <nav className="bottom-nav" role="navigation" aria-label="Main navigation">
            {navItems.map((item) => (
                <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => `bottom-nav__item${isActive ? ' active' : ''}`}
                >
                    <span className="bottom-nav__icon">{item.icon}</span>
                    <span className="bottom-nav__label">{item.label}</span>
                </NavLink>
            ))}
        </nav>
    );
}
