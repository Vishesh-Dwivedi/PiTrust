/**
 * TrustWeather — emotional score summary micro-copy card
 */
import './TrustWeather.css';

interface TrustWeatherProps {
    headline: string;
    sub: string;
}

export function TrustWeather({ headline, sub }: TrustWeatherProps) {
    return (
        <div className="trust-weather frost-card">
            <div className="trust-weather__headline">{headline}</div>
            <p className="trust-weather__sub">{sub}</p>
        </div>
    );
}
