'use strict';

// L2: the shared status toast.
//
// A toast is a *second* channel for a message the screen already shows in
// place, never the only one. The caller keeps its inline `role="status"` or
// `role="alert"` element; this component only repeats the message in a
// fixed-position live region so it stays visible while the user scrolls a long
// form. Nothing here is the sole copy of a clinical fact.
//
// Rules kept here so no screen can weaken them:
//  - the queue is bounded: the oldest toast is dropped, so a failing loop can
//    never stack hundreds of banners over the interface;
//  - a toast is never the only way to dismiss anything, and it holds no focus,
//    so it can never trap a keyboard user;
//  - automatic dismissal is bounded and is disabled entirely under
//    prefers-reduced-motion, where a message that vanishes on a timer is the
//    wrong behaviour;
//  - it renders into a live region with `role="status"`, so it is announced
//    without stealing focus.
import { useEffect, useState } from 'react';

/** Hard ceiling on visible toasts; the oldest is dropped beyond it. */
export const TOAST_LIMIT = 3;
const DEFAULT_DURATION = 6000;

function reducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function Toast({ toasts = [], onDismiss }) {
  // A toast with a duration only disappears under motion allowed; otherwise it
  // waits for the user, because a timed disappearance is a motion behaviour.
  const [allowed] = useState(() => !reducedMotion());

  useEffect(() => {
    if (!allowed || !onDismiss) return undefined;
    const timers = toasts
      .filter((toast) => toast.duration !== 0)
      .map((toast) =>
        window.setTimeout(() => onDismiss(toast.id), toast.duration || DEFAULT_DURATION)
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts, onDismiss, allowed]);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-region" role="status" aria-live="polite" data-testid="toast-region">
      {toasts.slice(-TOAST_LIMIT).map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone || 'info'}`}>
          <span className="toast__text">{toast.message}</span>
          {onDismiss ? (
            <button
              type="button"
              className="toast__close"
              onClick={() => onDismiss(toast.id)}
              aria-label={`Dismiss: ${toast.message}`}
            >
              <span aria-hidden="true">&#215;</span>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// Small reducer helper a screen can adopt without inventing its own ids.
let toastSeq = 0;
export function nextToast(message, tone = 'info', duration) {
  toastSeq += 1;
  return { id: `toast-${toastSeq}`, message, tone, duration };
}
