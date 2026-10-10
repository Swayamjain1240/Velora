'use strict';

import { Link } from 'react-router-dom';

// Marketing page - the one screen allowed to scroll (control #25).
export default function Landing() {
  return (
    <main className="landing">
      <header className="landing__hero">
        <h1>Velora</h1>
        <p className="tagline">
          Clinician-approved post-discharge recovery, coordinated securely.
        </p>
        <nav aria-label="Primary">
          <Link className="btn btn--primary" to="/login">Staff sign in</Link>
        </nav>
      </header>

      <section className="landing__section" aria-labelledby="what">
        <h2 id="what">What Velora does</h2>
        <p>
          Velora turns private discharge documents into structured recovery plans
          that a qualified clinical reviewer reviews and approves. Patients and
          explicitly authorized caregivers see only approved instructions.
        </p>
      </section>

      <section className="landing__section" aria-labelledby="boundaries">
        <h2 id="boundaries">Clear safety boundaries</h2>
        <ul>
          <li>Velora does not diagnose or prescribe.</li>
          <li>It does not decide clinical urgency or handle emergencies.</li>
          <li>AI output is never published automatically - a human approves it.</li>
          <li>It never declares a patient medically recovered.</li>
        </ul>
      </section>

      <footer className="landing__footer">
        <p>Development preview. Synthetic data only - not for real patient use.</p>
      </footer>
    </main>
  );
}
