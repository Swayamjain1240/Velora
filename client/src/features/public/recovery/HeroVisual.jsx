'use strict';

// Hosts the Recovery Network on the landing page.
//
// This module is deliberately thin: the three.js scene lives in a separate
// chunk that is imported only when the browser can actually render it. A phone
// on a slow connection, a browser without WebGL, a lost GPU context and a
// render error all get the same static gradient instead of an error message.
import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaQuery } from '../../../lib/useMediaQuery';

const RecoveryNetwork = lazy(() => import('./RecoveryNetwork'));

function webglAvailable() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  // jsdom (and any non-browser renderer) has no WebGL constructor at all; skip
  // the probe so it never logs "getContext not implemented".
  if (!('WebGLRenderingContext' in window) && !('WebGL2RenderingContext' in window)) return false;
  try {
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    return Boolean(context);
  } catch {
    return false;
  }
}

// Exported for the unit tests and for the QA capture script: the tier boundaries
// are a contract (mobile 320-719, tablet 720-1099, desktop 1100+).
export function qualityFor(width) {
  if (width && width < 720) {
    return { tier: 'mobile', nodes: 15, pulses: 5, dpr: 1.25, antialias: false, parallax: false };
  }
  if (width && width < 1100) {
    return { tier: 'tablet', nodes: 24, pulses: 10, dpr: 1.5, antialias: true, parallax: true };
  }
  return { tier: 'desktop', nodes: 36, pulses: 18, dpr: 1.75, antialias: true, parallax: true };
}

export function lowerTier(quality) {
  if (quality.tier === 'desktop') return qualityFor(800);
  if (quality.tier === 'tablet') return qualityFor(500);
  return { ...quality, pulses: 3, dpr: 1, antialias: false };
}

class SceneBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // A decorative scene must never take the page down or surface an error to
    // the visitor; the gradient fallback is the whole recovery path.
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export default function HeroVisual() {
  const container = useRef(null);
  const [inView, setInView] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [contextLost, setContextLost] = useState(false);

  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const compact = useMediaQuery('(max-width: 719px)');
  const tablet = useMediaQuery('(max-width: 1099px)');
  // A phone held sideways is still a phone. Width alone would hand an 844x390
  // phone the tablet scene, so a short viewport keeps the mobile tier.
  const shortViewport = useMediaQuery('(max-height: 480px)');

  // Capability is checked once per mount; it cannot change without a reload.
  const supported = useMemo(() => webglAvailable(), []);

  const quality = useMemo(() => {
    const width = compact || shortViewport ? 480 : tablet ? 800 : 1440;
    const base = qualityFor(width);
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
    const memory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
    const lowPower = (cores && cores <= 4) || (memory && memory <= 4);
    return lowPower ? lowerTier(base) : base;
  }, [compact, shortViewport, tablet]);

  // Pause rendering when the hero is off screen or the tab is in the background.
  useEffect(() => {
    const el = container.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.05 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // A lost GPU context is a fallback, not a crash. Capture phase catches the
  // non-bubbling event on the canvas without owning the canvas ref.
  useEffect(() => {
    const el = container.current;
    if (!el) return undefined;
    const onLost = (event) => {
      event.preventDefault();
      setContextLost(true);
    };
    el.addEventListener('webglcontextlost', onLost, true);
    el.addEventListener('webglcontextcreationerror', onLost, true);
    return () => {
      el.removeEventListener('webglcontextlost', onLost, true);
      el.removeEventListener('webglcontextcreationerror', onLost, true);
    };
  }, []);

  const frameloop = reducedMotion ? 'demand' : inView && !hidden ? 'always' : 'never';
  const fallback = <div className="hero-visual__fallback" />;
  const showScene = supported && !contextLost;

  return (
    // data-tier is diagnostic only: it lets the QA script assert the tier a
    // device received without guessing from pixel sizes.
    <div
      className="hero-visual"
      ref={container}
      aria-hidden="true"
      data-testid="hero-visual"
      data-tier={quality.tier}
    >
      {showScene ? (
        <SceneBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <RecoveryNetwork quality={quality} reducedMotion={reducedMotion} frameloop={frameloop} />
          </Suspense>
        </SceneBoundary>
      ) : (
        fallback
      )}
    </div>
  );
}
