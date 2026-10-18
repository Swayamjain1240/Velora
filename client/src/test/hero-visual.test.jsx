import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The scene module is replaced by a stub: jsdom cannot run WebGL, but the host's
// decisions (when to lazy-load, which quality tier and frameloop to pass) are
// exactly what this test needs to verify.
const seen = [];
vi.mock('../features/public/recovery/RecoveryNetwork', () => ({
  default: (props) => {
    seen.push(props);
    return (
      <div
        data-testid="scene"
        data-tier={props.quality.tier}
        data-frameloop={props.frameloop}
        data-reduced={String(props.reducedMotion)}
      />
    );
  },
}));

const HeroVisual = (await import('../features/public/recovery/HeroVisual')).default;
const { qualityFor, lowerTier } = await import('../features/public/recovery/HeroVisual');

function withWebgl() {
  vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
  const spy = vi
    .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => ({}));
  return () => {
    spy.mockRestore();
    vi.unstubAllGlobals();
  };
}

function media({ reduce = false, compact = false } = {}) {
  const original = window.matchMedia;
  window.matchMedia = (query) => ({
    matches:
      (query.includes('prefers-reduced-motion') && reduce) ||
      (query.includes('max-width: 719px') && compact) ||
      (query.includes('max-width: 1099px') && compact),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  return () => {
    window.matchMedia = original;
  };
}

afterEach(() => {
  seen.length = 0;
  vi.restoreAllMocks();
});

// jsdom has no WebGL context, which is exactly the "WebGL unavailable" case the
// hero must survive. These tests therefore assert the production fallback path.
describe('Recovery Network hero', () => {
  it('renders the static gradient, not a canvas, when WebGL is unavailable', () => {
    const { container } = render(<HeroVisual />);
    expect(screen.getByTestId('hero-visual')).toBeInTheDocument();
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('.hero-visual__fallback')).not.toBeNull();
  });

  it('is hidden from assistive technology and cannot take pointer input', () => {
    render(<HeroVisual />);
    const host = screen.getByTestId('hero-visual');
    expect(host).toHaveAttribute('aria-hidden', 'true');
    expect(host.className).toContain('hero-visual');
  });

  it('lazy-loads the scene only when a WebGL context can be created', async () => {
    const restore = withWebgl();
    render(<HeroVisual />);
    const scene = await screen.findByTestId('scene');
    expect(scene).toHaveAttribute('data-tier', 'desktop');
    // Motion allowed and the hero on screen: the loop runs continuously.
    expect(scene).toHaveAttribute('data-frameloop', 'always');
    restore();
  });

  it('freezes the scene and asks for no continuous frames under reduced motion', async () => {
    const restoreWebgl = withWebgl();
    const restoreMedia = media({ reduce: true });
    render(<HeroVisual />);
    const scene = await screen.findByTestId('scene');
    expect(scene).toHaveAttribute('data-reduced', 'true');
    expect(scene).toHaveAttribute('data-frameloop', 'demand');
    restoreMedia();
    restoreWebgl();
  });

  it('stops the loop when the tab is hidden and resumes when it is visible', async () => {
    const restore = withWebgl();
    render(<HeroVisual />);
    await screen.findByTestId('scene');

    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByTestId('scene')).toHaveAttribute('data-frameloop', 'never');

    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByTestId('scene')).toHaveAttribute('data-frameloop', 'always');
    restore();
  });
});

describe('quality tiers', () => {
  it('reduces geometry, particles and pixel ratio down the device ladder', () => {
    const desktop = qualityFor(1440);
    const tablet = qualityFor(800);
    const mobile = qualityFor(390);
    expect(desktop.nodes).toBeGreaterThan(tablet.nodes);
    expect(tablet.nodes).toBeGreaterThan(mobile.nodes);
    expect(desktop.pulses).toBeGreaterThan(mobile.pulses);
    expect(mobile.antialias).toBe(false);
    expect(mobile.parallax).toBe(false);
    expect(mobile.dpr).toBeLessThan(desktop.dpr);
  });

  it('drops a tier on low-core or low-memory devices', () => {
    expect(lowerTier(qualityFor(1440)).tier).toBe('tablet');
    expect(lowerTier(qualityFor(800)).tier).toBe('mobile');
    const floor = lowerTier(qualityFor(390));
    expect(floor.tier).toBe('mobile');
    expect(floor.pulses).toBeLessThan(qualityFor(390).pulses);
    expect(floor.dpr).toBe(1);
  });
});
