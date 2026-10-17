'use strict';

// Central motion layer. Screens never create ad-hoc tweens: they use these
// hooks, so durations, easing and reduced-motion behaviour stay consistent and
// every timeline is reverted on unmount (no leaks, no duplicate rerenders).
//
// Principles enforced here:
//  - only opacity/transform are animated (no layout thrash);
//  - nothing exceeds --dur-reveal, so medical information is never withheld;
//  - input is never blocked (no pointer-events tricks, no awaiting tweens);
//  - prefers-reduced-motion is honoured by NOT animating at all;
//  - gsap.context() ties every tween to the component and reverts it.
import { useEffect, useState } from 'react';
import { gsap } from 'gsap';

export const MOTION = Object.freeze({
  instant: 0.09,
  fast: 0.15,
  base: 0.24,
  slow: 0.38,
  reveal: 0.45,
  easeOut: 'power2.out',
  easeInOut: 'power2.inOut',
  /** Maximum number of children a stagger may animate in one pass. */
  staggerLimit: 12,
  stagger: 0.04,
});

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// React state mirror so components can render a static variant when the user
// changes the OS setting while the app is open.
export function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

// Page-level transition for the authenticated shell. Keyed on the route so a
// rerender of the same screen does not replay it (no duplicate animations).
export function usePageTransition(ref, routeKey) {
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (reduced) {
      gsap.set(el, { clearProps: 'all' });
      return undefined;
    }

    // Content starts at 0.6 opacity, never at zero: if the ticker stalls (a
    // backgrounded tab, a paused frame budget) the screen is still legible
    // instead of blank. A failsafe clears any residual inline style.
    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { opacity: 0.6, y: 8 },
        {
          opacity: 1,
          y: 0,
          duration: MOTION.base,
          ease: MOTION.easeOut,
          overwrite: 'auto',
          clearProps: 'transform',
        }
      );
    }, el);

    const failsafe = window.setTimeout(() => {
      gsap.set(el, { opacity: 1, y: 0, clearProps: 'transform' });
    }, 600);

    return () => {
      window.clearTimeout(failsafe);
      ctx.revert();
    };
    // routeKey is the trigger: a new route animates, a rerender does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, reduced]);
}

// Staggered reveal for a bounded set of children (cards, list rows). Children
// beyond staggerLimit appear with the last batch instead of animating for
// seconds, so a long list never delays the final item.
export function useReveal(ref, { selector, limit = MOTION.staggerLimit } = {}) {
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const targets = selector
      ? Array.from(el.querySelectorAll(selector)).slice(0, limit)
      : Array.from(el.children).slice(0, limit);
    if (!targets.length || reduced) return undefined;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        targets,
        { opacity: 0.6, y: 10 },
        {
          opacity: 1,
          y: 0,
          duration: MOTION.slow,
          ease: MOTION.easeOut,
          stagger: MOTION.stagger,
          overwrite: 'auto',
          clearProps: 'transform',
        }
      );
    }, el);

    // Guarantee the content becomes fully visible even if GSAP never ticks.
    const failsafe = window.setTimeout(() => {
      gsap.set(targets, { opacity: 1, y: 0, clearProps: 'transform' });
    }, 900);

    return () => {
      window.clearTimeout(failsafe);
      ctx.revert();
    };
  }, [ref, selector, limit, reduced]);
}

// Small helper for one-off state confirmations (e.g. a saved notice). The
// element animates itself; the text is already in the DOM and announced by the
// existing role="status"/alert before the tween starts.
export function pulse(el) {
  if (!el || prefersReducedMotion()) return;
  gsap.fromTo(
    el,
    { opacity: 0.4, scale: 0.99 },
    { opacity: 1, scale: 1, duration: MOTION.base, ease: MOTION.easeOut, clearProps: 'transform' }
  );
}

// Re-export the core for the rare screen that needs a bespoke timeline; such a
// timeline must still be created inside a gsap.context() and reverted.
export { gsap };
