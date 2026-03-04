/**
 * App.tsx — Router & layout composition
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { PiAuthProvider } from './context/PiAuthContext';
import { AppShell } from './components/layout/AppShell';
import { Dashboard } from './pages/Dashboard';
import { Passport } from './pages/Passport';
import { Vouch } from './pages/Vouch';
import { Disputes } from './pages/Disputes';

export default function App() {
    return (
        <PiAuthProvider>
            <BrowserRouter>
                <AppShell>
                    <Routes>
                        <Route path="/" element={<Navigate to="/dashboard" replace />} />
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route path="/passport" element={<Passport />} />
                        <Route path="/vouch" element={<Vouch />} />
                        <Route path="/disputes" element={<Disputes />} />
                        <Route path="*" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                </AppShell>
            </BrowserRouter>
        </PiAuthProvider>
    );
}
