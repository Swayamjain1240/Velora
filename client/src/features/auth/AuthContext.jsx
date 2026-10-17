'use strict';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';

// Global auth state. The server is authoritative (control #3/#5): this context
// only mirrors what /api/auth/status reports, and clears ALL sensitive state
// on 401/403 so a denied refresh never leaves stale patient data on screen.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, authenticated: false, unavailable: false });
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const read = () => api('/auth/status');
    try {
      const data = await read();
      setState({ loading: false, unavailable: false, ...data });
      return data;
    } catch (err) {
      // 401/403 is the server saying "no valid session": sign out.
      const signedOut = err instanceof ApiError && (err.status === 401 || err.status === 403);
      if (signedOut) {
        setState({ loading: false, authenticated: false, unavailable: false });
        return { authenticated: false };
      }

      // Anything else (offline, 429 from the coarse limiter, 5xx) says nothing
      // about the session. Retry once, then show a retry state rather than a
      // login form: sending a signed-in user back to sign in would ask them to
      // retype a password because of a momentary failure.
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const data = await read();
        setState({ loading: false, unavailable: false, ...data });
        return data;
      } catch {
        setError(err.message);
        setState((prev) => ({ ...prev, loading: false, unavailable: true }));
        return { authenticated: false, unavailable: true };
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { email, password } });
    // Mirror the server's next-step contract so the router sends the user to
    // the MFA screens instead of bouncing them back to /login.
    setState({
      loading: false,
      authenticated: false,
      unavailable: false,
      ...data,
      mfaPending: data.next === 'mfa_verify' || data.next === 'mfa_enroll',
      mfaEnrollmentRequired: data.next === 'mfa_enroll',
    });
    return data;
  }, []);

  const verifyMfa = useCallback(async (payload) => {
    const data = await api('/auth/mfa/verify', { method: 'POST', body: payload });
    await refresh();
    return data;
  }, [refresh]);

  const enrollSetup = useCallback(async () => api('/auth/mfa/enroll/setup', { method: 'POST' }), []);

  const enrollVerify = useCallback(async (code) => {
    const data = await api('/auth/mfa/enroll/verify', { method: 'POST', body: { code } });
    await refresh();
    return data;
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      // Always drop local state, even if the call failed.
      setState({ loading: false, authenticated: false, unavailable: false });
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      error,
      login,
      verifyMfa,
      enrollSetup,
      enrollVerify,
      logout,
      refresh,
      clearError: () => setError(null),
    }),
    [state, error, login, verifyMfa, enrollSetup, enrollVerify, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
