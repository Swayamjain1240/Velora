'use strict';

import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import Landing from '../features/public/Landing';
import Login from '../features/auth/Login';
import MfaVerify from '../features/auth/MfaVerify';
import MfaEnroll from '../features/auth/MfaEnroll';
import ForgotPassword from '../features/auth/ForgotPassword';
import ResetPassword from '../features/auth/ResetPassword';
import AcceptInvite from '../features/auth/AcceptInvite';
import AppShell from '../features/app/AppShell';
import Dashboard from '../features/app/Dashboard';
import ClinicSettings from '../features/app/ClinicSettings';
import Profile from '../features/app/Profile';

// Route guard (UX only - the server is the real boundary, control #3).
function Protected({ children }) {
  const { loading, authenticated, mfaPending } = useAuth();
  if (loading) return <div className="centered" role="status">Loading…</div>;
  if (!authenticated) {
    return <Navigate to={mfaPending ? '/login/mfa' : '/login'} replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/login/mfa" element={<MfaVerify />} />
      <Route path="/login/enroll" element={<MfaEnroll />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password/:token" element={<ResetPassword />} />
      <Route path="/accept-invite/:token" element={<AcceptInvite />} />
      <Route
        path="/app"
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="clinic" element={<ClinicSettings />} />
        <Route path="profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
