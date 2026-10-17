'use strict';

import { useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
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
import PatientList from '../features/patients/PatientList';
import PatientDetail from '../features/patients/PatientDetail';
import PatientSelf from '../features/patient/PatientSelf';
import PatientEpisodes from '../features/patient/PatientEpisodes';
import CaregiverHome from '../features/caregiver/CaregiverHome';
import EpisodeList from '../features/episodes/EpisodeList';
import EpisodeDetail from '../features/episodes/EpisodeDetail';
import TodayView from '../features/today/TodayView';
import AssignedQueues from '../features/queues/AssignedQueues';
import MyCare from '../features/care/MyCare';
import AuditPanel from '../features/audit/AuditPanel';
import PrivacyPanel from '../features/privacy/PrivacyPanel';
import RetentionPanel from '../features/retention/RetentionPanel';
import MetricsPanel from '../features/metrics/MetricsPanel';

// Route guard (UX only - the server is the real boundary, control #3).
//
// A failed status check is not the same as a missing session: only the server's
// 401/403 signs the user out. A network failure, a 429 or a 5xx must not send a
// signed-in user to the login form, so it renders a retry state instead.
function Protected({ children }) {
  const { loading, authenticated, mfaPending, unavailable, refresh } = useAuth();
  if (loading) return <div className="centered" role="status">Checking your session…</div>;
  if (unavailable && !authenticated) {
    return (
      <main className="panel-page">
        <section className="panel" aria-labelledby="unavailable-title">
          <h1 id="unavailable-title">Velora is temporarily unreachable</h1>
          <p>
            Your session has not been signed out. Check your connection and try again -
            nothing you entered has been lost.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => refresh()}>
            Try again
          </button>
          <p className="panel__links">
            <Link to="/login">Go to sign in</Link>
          </p>
        </section>
      </main>
    );
  }
  if (!authenticated) {
    return <Navigate to={mfaPending ? '/login/mfa' : '/login'} replace />;
  }
  return children;
}

// The patient list and detail share the /app/patients path: the detail is a
// nested view keyed on the selected patient id, so the URL never grows beyond
// the fixed shell and the back action is a plain state reset.
function PatientsRoute() {
  const [selectedId, setSelectedId] = useState(null);
  if (selectedId) return <PatientDetail patientId={selectedId} onBack={() => setSelectedId(null)} />;
  return <PatientList onOpen={setSelectedId} />;
}

// Same nested pattern for episodes: the detail is a state-swapped view so the
// URL stays inside the fixed shell.
function EpisodesRoute() {
  const [selectedId, setSelectedId] = useState(null);
  if (selectedId) return <EpisodeDetail episodeId={selectedId} onBack={() => setSelectedId(null)} />;
  return <EpisodeList onOpen={setSelectedId} />;
}

// Part 8: the caregiver's scoped version of the care panel. The patient is part
// of the path because the server authorises each request against the ACTIVE
// grant for THAT patient - the id is a request parameter, never a permission.
function CaregiverCareRoute() {
  const { patientId } = useParams();
  return <MyCare mode="caregiver" patientId={patientId} />;
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
        <Route path="patients" element={<PatientsRoute />} />
        <Route path="episodes" element={<EpisodesRoute />} />
        <Route path="me" element={<PatientSelf />} />
        <Route path="me/episodes" element={<PatientEpisodes />} />
        <Route path="caregiver" element={<CaregiverHome />} />
        {/* Part 7: the day view. One route for patients, caregivers and assigned
            staff; the server resolves who is asking and what they may see. */}
        <Route path="today" element={<TodayView />} />
        {/* Part 8: the assigned-team dashboard (staff) and the patient's own care
            panel (patient or, scoped by a grant, their caregiver). */}
        <Route path="queues" element={<AssignedQueues />} />
        {/* Part 9: closure lives inside the episode detail; these four are the
            Part 9 staff/administrative surfaces, each one viewport tall. */}
        <Route path="audit" element={<AuditPanel />} />
        <Route path="privacy" element={<PrivacyPanel />} />
        <Route path="retention" element={<RetentionPanel />} />
        <Route path="metrics" element={<MetricsPanel />} />
        <Route path="me/care" element={<MyCare mode="patient" />} />
        <Route path="caregiver/:patientId/care" element={<CaregiverCareRoute />} />
        <Route path="profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
