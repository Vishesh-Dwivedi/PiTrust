/**
 * AppShell - root layout with ambient background and route-aware chrome.
 */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { usePiAuth } from '../../context/PiAuthContext';
import { getCanonicalAppUrl } from '../../utils/helpers';
import './AppShell.css';

interface AppShellProps {
    children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
    const { user } = usePiAuth();
    const location = useLocation();
    const isPublicTrustRoute = location.pathname.startsWith('/trust/');

    return (
        <div className={`app-shell${isPublicTrustRoute ? ' app-shell--public' : ''}`}>
            <div className="ambient-layer" aria-hidden="true">
                <div className="orb orb--teal" />
                <div className="orb orb--purple" />
            </div>

            <header className={`app-header${isPublicTrustRoute ? ' app-header--public' : ''}`}>
                <div className="app-header__logo">
                    <span className="logo-icon">PI</span>
                    <span className="logo-text">PiTrust</span>
                </div>
                {isPublicTrustRoute ? (
                    <a className="app-header__link" href={getCanonicalAppUrl('/dashboard')}>Open App</a>
                ) : user ? (
                    <div className="app-header__user">
                        <span className="user-avatar">{(user.username || 'P').charAt(0).toUpperCase()}</span>
                        <span className="user-name">@{user.username || 'pioneer'}</span>
                    </div>
                ) : null}
            </header>

            <main className={`app-main${isPublicTrustRoute ? ' app-main--public' : ''}`}>
                {children}
            </main>

            {!isPublicTrustRoute && <BottomNav />}
        </div>
    );
}

