/**
 * App.tsx - Router and layout composition.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PiAuthProvider } from './context/PiAuthContext';
import { AppShell } from './components/layout/AppShell';
import { Dashboard } from './pages/Dashboard';
import { Passport } from './pages/Passport';
import { PublicPassport } from './pages/PublicPassport';
import { Merchants } from './pages/Merchants';
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
                        <Route path="/merchants" element={<Merchants />} />
                        <Route path="/trust/:walletOrUid" element={<PublicPassport />} />
                        <Route path="/vouch" element={<Vouch />} />
                        <Route path="/disputes" element={<Disputes />} />
                        <Route path="*" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                </AppShell>
            </BrowserRouter>
        </PiAuthProvider>
    );
}

