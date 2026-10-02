'use client';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
type Membership = { clinic_id: string; clinic_name: string; roles: string[]; clinical_verified: boolean };
type Account = { email: string; csrf_token: string; memberships: Membership[] };
type Staff = { id: string; email: string; roles: string[]; active: boolean; clinical_verified: boolean };
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
export default function Home() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [selected, setSelected] = useState('');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [link, setLink] = useState('');
  const membership = account?.memberships.find(m => m.clinic_id === selected);
  const admin = membership?.roles.includes('clinic_admin');
  async function call(path: string, method = 'GET', body?: object, csrf = account?.csrf_token) {
    const response = await fetch(API + path, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/login') { setAccount(null); setStaff([]); setSelected(''); }
      throw new Error(typeof data.detail === 'string' ? data.detail : 'Check the form fields and try again.');
    }
    return data;
  }
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('invite');
    if (token) window.history.replaceState({}, '', '/');
    fetch(API + '/auth/me', { credentials: 'include' }).then(async r => {
      if (token) setInviteToken(token);
      if (r.ok) { const data: Account = await r.json(); setAccount(data); setSelected(data.memberships[0]?.clinic_id || ''); }
      else if (r.status !== 401) setError('Could not load your account.');
    }).catch(() => { if (token) setInviteToken(token); setError('Backend unavailable. Start FastAPI and refresh.'); }).finally(() => setLoading(false));
  }, []);
  async function action(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); } finally { setBusy(false); } }
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const data = new FormData(e.currentTarget);
    await action(async () => { await call('/auth/login', 'POST', { email: data.get('email'), password: data.get('password') }); const me: Account = await call('/auth/me'); setAccount(me); setSelected(me.memberships[0]?.clinic_id || ''); });
  }
  async function accept(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const data = new FormData(e.currentTarget);
    await action(async () => { await call('/invitations/accept', 'POST', { token: inviteToken, ...(data.get('password') ? { password: data.get('password') } : {}) }); setInviteToken(''); setNotice('Invitation accepted. Sign in, or refresh to load your new clinic.'); });
  }
  if (loading) return <main className="shell"><p>Loading your workspace…</p></main>;
  return <main className="shell">
    <header><Link className="brand" href="/">velora<span>●</span></Link><span className="badge">PART 01 · SYNTHETIC PROTOTYPE</span></header>
    <section className="intro"><p className="eyebrow">RECOVERY, CONNECTED</p><h1>Your care team.<br /><span>One clear workspace.</span></h1><p>Secure clinic access is the first step. Recovery plans and patient workflows arrive in the next milestones.</p></section>
    {error && <div role="alert" className="error">{error}</div>}{notice && <div role="status" className="notice">{notice}</div>}
    <div className="grid">
      {!account ? <section className="card"><h2>Welcome back</h2><p>Sign in with your clinic-invited account.</p><form onSubmit={login}><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label><button disabled={busy}>Sign in</button></form><small>No public staff signup. Ask your clinic administrator for an invitation.</small></section> : <section className="card"><h2>Your workspace</h2><p>{account.email}</p><label>Clinic<select value={selected} onChange={e => { setSelected(e.target.value); setStaff([]); setLink(''); }}>{account.memberships.map(m => <option key={m.clinic_id} value={m.clinic_id}>{m.clinic_name}</option>)}</select></label>{!account.memberships.length && <p>No active clinic memberships. Contact your administrator.</p>}<div className="roles">{membership?.roles.map(r => <span className="badge" key={r}>{r.replaceAll('_', ' ')}</span>)}</div><p>Clinical eligibility: {membership?.clinical_verified ? 'verified' : 'not verified'}. Role assignment alone does not grant clinical approval.</p><button className="secondary" disabled={busy} onClick={() => action(async () => { await call('/auth/logout', 'POST'); setAccount(null); setStaff([]); setLink(''); setSelected(''); })}>Sign out</button></section>}
      {inviteToken && <section className="card"><h2>Accept invitation</h2><p>Existing users: sign in to the invited account first. New users: set a password below. Links are single-use and expire after 24 hours.</p><form onSubmit={accept}>{!account && <label>New account password<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" /></label>}<button disabled={busy}>Accept invitation</button></form></section>}
      {admin && <section className="card"><h2>Invite a teammate</h2><p>Development only: share the link with a synthetic test identity. No email is sent.</p><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); action(async () => { const result = await call(`/clinics/${selected}/staff-invitations`, 'POST', { email: data.get('email'), role: data.get('role') }); setLink(result.development_link); }); }}><label>Staff email<input name="email" type="email" required /></label><label>Role<select name="role"><option value="care_coordinator">Care coordinator</option><option value="clinical_reviewer">Clinical reviewer — unverified</option></select></label><button disabled={busy}>Create invitation</button></form>{link && <label>One-time development link<input readOnly value={link} onFocus={e => e.currentTarget.select()} /></label>}</section>}
      {admin && <section className="card"><h2>Clinic settings</h2><form key={selected} onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); action(async () => { await call(`/clinics/${selected}`, 'PATCH', { contact: data.get('contact'), response_hours: data.get('hours') }); setNotice('Clinic settings saved.'); }); }}><label>Clinic contact<input name="contact" maxLength={200} required /></label><label>Response hours<input name="hours" maxLength={200} placeholder="Mon–Fri, 09:00–17:00 IST" required /></label><button disabled={busy}>Save settings</button></form></section>}
    </div>
    {admin && <section className="card staff"><div className="row"><h2>Staff access</h2><button disabled={busy} className="secondary" onClick={() => action(async () => setStaff(await call(`/clinics/${selected}/memberships`)))}>Load staff</button></div>{staff.map(person => <div className="staffrow" key={person.id}><div><strong>{person.email}</strong><p>{person.roles.join(', ')} · {person.active ? 'Active' : 'Inactive'}</p></div>{person.active && !person.roles.includes('clinic_admin') && <button disabled={busy} className="secondary" onClick={() => action(async () => { await call(`/clinics/${selected}/memberships/${person.id}`, 'DELETE'); setStaff(await call(`/clinics/${selected}/memberships`)); })}>Deactivate</button>}</div>)}</section>}
    <footer>Clinical records are not part of this screen. Use synthetic identities only.</footer>
  </main>;
}
