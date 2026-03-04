/**
 * Skeleton components — pulse loading states in the exact shape of real content
 */
import './Skeleton.css';

export function DashboardSkeleton() {
    return (
        <div className="dashboard-skeleton" aria-busy="true" aria-label="Loading trust profile...">
            {/* Score hero skeleton */}
            <div className="sk-hero">
                <div className="sk-row">
                    <div className="skeleton sk-text-sm" style={{ width: '120px' }} />
                    <div className="skeleton sk-badge" />
                </div>
                <div className="skeleton sk-score-num" />
                <div className="skeleton sk-progress" />
            </div>
            {/* Weather card skeleton */}
            <div className="frost-card sk-weather">
                <div className="skeleton sk-text-md" style={{ width: '70%' }} />
                <div className="skeleton sk-text-sm" style={{ width: '90%' }} />
            </div>
            {/* Pillars skeleton */}
            <div className="frost-card sk-pillars">
                {[1, 2, 3].map(i => (
                    <div key={i} className="sk-pillar">
                        <div className="skeleton sk-text-sm" style={{ width: '60%' }} />
                        <div className="skeleton sk-bar" />
                    </div>
                ))}
            </div>
            {/* Stat row skeleton */}
            <div className="sk-stat-row">
                {[1, 2, 3].map(i => (
                    <div key={i} className="frost-card sk-stat">
                        <div className="skeleton sk-stat-num" />
                        <div className="skeleton sk-text-sm" style={{ width: '70%' }} />
                    </div>
                ))}
            </div>
        </div>
    );
}

export function VouchSkeleton() {
    return (
        <div className="vouch-skeleton">
            <div className="skeleton" style={{ height: '48px', borderRadius: '14px', marginBottom: '16px' }} />
            {[1, 2, 3, 4].map(i => (
                <div key={i} className="frost-card" style={{ padding: '16px', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                        <div className="skeleton" style={{ width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0 }} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div className="skeleton sk-text-md" style={{ width: '60%' }} />
                            <div className="skeleton sk-text-sm" style={{ width: '40%' }} />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
