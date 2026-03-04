/**
 * ScoreRadar — simplified CSS-based radar chart
 * Shows 3 score pillars: On-Chain, Vouch, Social
 */
import './ScoreRadar.css';

interface ScoreRadarProps {
    onChain: number;  // 0–500
    vouch: number;    // 0–400
    social: number;   // 0–300
}

interface PillarProps {
    label: string;
    value: number;
    max: number;
    color: string;
    icon: string;
}

function Pillar({ label, value, max, color, icon }: PillarProps) {
    const pct = Math.min(100, (value / max) * 100);
    return (
        <div className="pillar">
            <div className="pillar__top">
                <span className="pillar__icon">{icon}</span>
                <span className="pillar__value" style={{ color }}>
                    {Math.round(value)}
                    <span className="pillar__max"> /{max}</span>
                </span>
            </div>
            <div className="pillar__track">
                <div
                    className="pillar__fill"
                    style={{ width: `${pct}%`, background: color }}
                />
            </div>
            <span className="pillar__label">{label}</span>
        </div>
    );
}

export function ScoreRadar({ onChain, vouch, social }: ScoreRadarProps) {
    return (
        <div className="score-radar frost-card">
            <Pillar label="On-Chain Activity" value={onChain} max={500} color="#4dabf5" icon="⛓" />
            <Pillar label="Vouch Network" value={vouch} max={400} color="#9b7ff5" icon="🤝" />
            <Pillar label="Social Identity" value={social} max={300} color="#30d88a" icon="🌐" />
        </div>
    );
}
