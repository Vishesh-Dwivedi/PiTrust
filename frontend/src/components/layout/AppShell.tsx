/**
 * AppShell — root layout with ambient background and bottom nav
 */
import type { ReactNode } from 'react';
import { BottomNav } from './BottomNav';
import { usePiAuth } from '../../context/PiAuthContext';
import './AppShell.css';

interface AppShellProps {
    children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
    const { user } = usePiAuth();

    return (
        <div className="app-shell">
            {/* Ambient background orbs */}
            <div className="ambient-layer" aria-hidden="true">
                <div className="orb orb--teal" />
                <div className="orb orb--purple" />
            </div>

            {/* Top status bar */}
            <header className="app-header">
                <div className="app-header__logo">
                    <span className="logo-icon">⬡</span>
                    <span className="logo-text">PiTrust</span>
                </div>
                {user && (
                    <div className="app-header__user">
                        <span className="user-avatar">{(user.username || 'P').charAt(0).toUpperCase()}</span>
                        <span className="user-name">@{user.username || 'pioneer'}</span>
                    </div>
                )}
            </header>

            {/* Page content */}
            <main className="app-main">
                {children}
            </main>

            {/* Mobile bottom navigation */}
            <BottomNav />
        </div>
    );
}
