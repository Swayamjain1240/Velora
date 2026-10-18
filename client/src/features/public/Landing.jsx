'use strict';

import { useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import { MOTION, gsap, useReducedMotion, useReveal } from '../../lib/motion';
import HeroVisual from './recovery/HeroVisual';

// Marketing page - the one screen allowed to scroll (control #25).
// Copy is unchanged: the safety boundaries are product claims, not decoration.
export default function Landing() {
  const sectionsRef = useRef(null);
  const heroTextRef = useRef(null);
  const pageRef = useRef(null);
  const exitRef = useRef(null);
  const reduced = useReducedMotion();
  const navigate = useNavigate();

  useReveal(sectionsRef, { selector: '.landing__section' });

  // Hero copy entrance, on the same clock as the scene's own entrance. Both
  // start on mount, so the headline resolves as the network appears instead of
  // arriving before or after it. Content starts at 0.55 opacity, never 0.
  useEffect(() => {
    const el = heroTextRef.current;
    if (!el || !el.children.length) return undefined;
    if (reduced) return undefined;

    const targets = Array.from(el.children);
    const ctx = gsap.context(() => {
      gsap.fromTo(
        targets,
        { opacity: 0.55, y: 10 },
        {
          opacity: 1,
          y: 0,
          duration: MOTION.reveal,
          ease: MOTION.easeOut,
          stagger: 0.07,
          delay: 0.1,
          clearProps: 'transform',
        }
      );
    }, el);

    const failsafe = window.setTimeout(() => {
      gsap.set(targets, { opacity: 1, y: 0, clearProps: 'transform' });
    }, 900);

    return () => {
      window.clearTimeout(failsafe);
      ctx.revert();
    };
  }, [reduced]);

  // Leaving for the application fades the marketing page out instead of
  // cutting. Deliberately short (260 ms) and backed by a timer: if GSAP never
  // ticks, navigation still happens - a decorative fade must never block sign-in.
  useEffect(() => () => {
    if (exitRef.current) exitRef.current.revert();
  }, []);

  const onSignIn = useCallback(
    (event) => {
      // Modified clicks, non-primary buttons and reduced motion keep the
      // browser's default navigation.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        reduced
      ) {
        return;
      }
      event.preventDefault();
      const href = event.currentTarget.getAttribute('href') || '/login';
      const page = pageRef.current;
      let navigated = false;
      const go = () => {
        if (navigated) return;
        navigated = true;
        window.clearTimeout(failsafe);
        navigate(href);
      };
      const failsafe = window.setTimeout(go, 420);
      if (!page) {
        go();
        return;
      }
      exitRef.current = gsap.context(() => {
        gsap.to(page, { opacity: 0, duration: 0.26, ease: 'power2.in', onComplete: go });
      }, page);
    },
    [navigate, reduced]
  );

  return (
    <main className="landing" ref={pageRef}>
      <header className="landing__hero">
        <HeroVisual />
        <div className="landing__hero-content" ref={heroTextRef}>
          <p className="landing__eyebrow">
            <Icon name="shield" size={14} />
            Clinician-approved by design
          </p>
          <h1>Velora</h1>
          <p className="tagline">
            Clinician-approved post-discharge recovery, coordinated securely.
          </p>
          <nav aria-label="Primary">
            <Link className="btn btn--primary" to="/login" onClick={onSignIn}>
              Staff sign in
            </Link>
          </nav>
        </div>
      </header>

      <div className="landing__grid" ref={sectionsRef}>
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
      </div>

      <footer className="landing__footer">
        <p>Development preview. Synthetic data only - not for real patient use.</p>
      </footer>
    </main>
  );
}
