'use strict';

// Browser-level checks for the Recovery Network hero. These cannot run in jsdom:
// they need a real WebGL context, a real render loop and real navigation.
//
//   node qa/hero-browser-test.js            (dev server on 5173)
//
// Prints one PASS/FAIL/NOTE line per check and exits non-zero on any failure.
const { chromium } = require(process.cwd() + '/node_modules/@playwright/test');

const BASE = process.env.BASE || 'http://localhost:5173';
const SIZES = [
  { name: 'desktop 1440x900', width: 1440, height: 900, tier: 'desktop' },
  { name: 'tablet 768x1024', width: 768, height: 1024, tier: 'tablet' },
  { name: 'mobile 390x844', width: 390, height: 844, tier: 'mobile' },
  { name: 'small 320x568', width: 320, height: 568, tier: 'mobile' },
  { name: 'landscape 844x390', width: 844, height: 390, tier: 'mobile' },
  { name: 'short 320x400', width: 320, height: 400, tier: 'mobile' },
];

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name, detail });
  process.stdout.write(`${status}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function canvasInfo(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const host = document.querySelector('.hero-visual');
    if (!canvas) return { canvas: false, fallback: Boolean(document.querySelector('.hero-visual__fallback')) };
    return {
      canvas: true,
      width: canvas.width,
      height: canvas.height,
      cssWidth: Math.round(host.getBoundingClientRect().width),
      dpr: window.devicePixelRatio,
      pointerEvents: getComputedStyle(canvas).pointerEvents,
      ariaHidden: host.getAttribute('aria-hidden'),
      tier: host.getAttribute('data-tier'),
      fallback: Boolean(document.querySelector('.hero-visual__fallback')),
    };
  });
}

async function sceneCoverage(page) {
  const withScene = await page.screenshot();
  await page.addStyleTag({ content: '.hero-visual{display:none !important}.landing__hero-content{visibility:hidden !important}' });
  await page.waitForTimeout(150);
  const without = await page.screenshot();
  return page.evaluate(
    async ([a, b]) => {
      const load = (d) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = `data:image/png;base64,${d}`;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const c = document.createElement('canvas');
      c.width = ia.width;
      c.height = ia.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(ia, 0, 0);
      const da = ctx.getImageData(0, 0, c.width, c.height).data;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(0, 0, c.width, c.height).data;
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d =
          Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 12) changed += 1;
      }
      return (changed / (da.length / 4)) * 100;
    },
    [withScene.toString('base64'), without.toString('base64')]
  );
}


(async () => {
  const browser = await chromium.launch();

  // 1. Scene loads, is decorative, and stays inside the hero at every size.
  for (const size of SIZES) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.width < 480 ? 3 : 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2400);
    const info = await canvasInfo(page);
    const layout = await page.evaluate(() => {
      const hostEl = document.querySelector('.hero-visual');
      const host = hostEl.getBoundingClientRect();
      const link = document.querySelector('.landing__hero a').getBoundingClientRect();
      const heroEl = document.querySelector('.landing__hero');
      const hero = heroEl.getBoundingClientRect();
      // The scene is allowed to bleed past the hero box; the hero clips it. What
      // matters is that an ancestor clips it, that the visible part is the whole
      // hero height, and that nothing reaches the document scroll area.
      let clipped = false;
      let ancestor = hostEl.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflow !== 'visible' || style.overflowX !== 'visible') {
          clipped = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      const visibleHeight = Math.max(0, Math.min(host.bottom, hero.bottom) - Math.max(host.top, hero.top));
      return {
        clipped,
        visibleFraction: Math.min(hero.height, host.height) > 0 ? visibleHeight / Math.min(hero.height, host.height) : 1,
        heroInViewport: hero.bottom <= window.innerHeight + 1,
        linkInViewport: link.bottom <= window.innerHeight && link.top >= 0,
        docWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        heroHeight: Math.round(hero.height),
      };
    });

    if (!info.canvas) record('FAIL', `${size.name}: scene canvas`, 'no canvas');
    else if (info.tier !== size.tier) {
      record('FAIL', `${size.name}: quality tier`, `got ${info.tier}, expected ${size.tier}`);
    } else {
      const ratio = info.width / info.cssWidth;
      const cap = { mobile: 1.25, tablet: 1.5, desktop: 1.75 }[info.tier];
      if (ratio > Math.min(info.dpr, cap) + 0.05) {
        record('FAIL', `${size.name}: pixel ratio cap`, `backing ratio ${ratio.toFixed(2)} > ${cap}`);
      }
      record(
        'PASS',
        `${size.name}: ${info.tier} canvas ${info.width}x${info.height} for ${info.cssWidth}px css (device dpr ${info.dpr}, cap ${cap})`
      );
    }
    if (info.pointerEvents !== 'none') record('FAIL', `${size.name}: canvas pointer events`, info.pointerEvents);
    if (info.ariaHidden !== 'true') record('FAIL', `${size.name}: canvas aria-hidden`, String(info.ariaHidden));
    // The scene deliberately bleeds 30-70 px past the hero's top edge (the
    // masked glow), so 80 % of the hero is the floor, not 100 %.
    if (!layout.clipped || layout.visibleFraction < 0.8) {
      record('FAIL', `${size.name}: scene confined and clipped by the hero`, JSON.stringify(layout));
    } else if (!layout.heroInViewport) {
      record('FAIL', `${size.name}: hero inside the viewport`, JSON.stringify(layout));
    }
    if (!layout.linkInViewport) record('FAIL', `${size.name}: sign-in link in viewport`, JSON.stringify(layout));
    if (layout.docWidth > layout.innerWidth + 1) {
      record('FAIL', `${size.name}: horizontal overflow`, `${layout.docWidth} > ${layout.innerWidth}`);
    }
    if (errors.length) record('FAIL', `${size.name}: page errors`, errors.join(' | '));
    if (size.name === 'desktop 1440x900') {
      const coverage = await sceneCoverage(page);
      if (coverage < 2) record('FAIL', 'scene paints pixels', `${coverage.toFixed(2)}% of the page`);
      else record('PASS', 'scene paints pixels', `${coverage.toFixed(2)}% of the page changes when hidden`);
    }
    await context.close();
  }

  // 2. Static fallback when the browser refuses WebGL.
  {
    const noGl = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2'] });
    const page = await noGl.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const info = await canvasInfo(page);
    if (info.canvas) record('FAIL', 'WebGL unavailable: no canvas', 'canvas present');
    else if (!info.fallback) record('FAIL', 'WebGL unavailable: gradient fallback', 'missing');
    else record('PASS', 'WebGL unavailable: gradient fallback, no error');
    if (errors.length) record('FAIL', 'WebGL unavailable: page errors', errors.join(' | '));
    await noGl.close();
  }

  // 3. Context loss is a fallback, not a crash.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const lost = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (!ext) return 'no-extension';
      ext.loseContext();
      return 'lost';
    });
    await page.waitForTimeout(700);
    const after = await canvasInfo(page);
    if (lost !== 'lost') record('NOTE', 'context loss probe unavailable', lost);
    else if (after.canvas) record('FAIL', 'context loss removes the canvas');
    else if (!after.fallback) record('FAIL', 'context loss shows the fallback', 'missing');
    else record('PASS', 'context loss shows the fallback, page still renders');
    if (errors.length) record('FAIL', 'context loss: page errors', errors.join(' | '));
    await page.close();
  }

  // 4. Repeated visits do not accumulate canvases and do not grow the heap.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { usedSize } = await cdp.send('Runtime.getHeapUsage');
      return Math.round(usedSize / 1024);
    };

    let maxCanvases = 0;
    let heaviest = 0;
    const samples = [];
    for (let visit = 0; visit < 6; visit += 1) {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1400);
      const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
      if (visit === 0) await page.waitForTimeout(400);
      maxCanvases = Math.max(maxCanvases, canvases);
      await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      const leftover = await page.evaluate(() => document.querySelectorAll('canvas').length);
      if (leftover > 0) maxCanvases = Math.max(maxCanvases, leftover);
      if (visit % 2 === 1) {
        const kb = await heap();
        samples.push(kb);
        heaviest = Math.max(heaviest, kb);
      }
    }
    if (maxCanvases > 1) record('FAIL', 'route remounts keep one canvas', `max ${maxCanvases}`);
    else record('PASS', '6 landing<->login remounts keep exactly one canvas, none after leaving');

    const growth = samples[samples.length - 1] - samples[0];
    const allowed = 6000;
    if (growth > allowed) record('FAIL', 'heap after repeated visits', `+${growth} kB over ${samples.length - 1} cycles (${samples.join(' → ')} kB)`);
    else record('PASS', 'heap after repeated visits', `+${growth} kB over ${samples.length - 1} cycles (${samples.join(' → ')} kB)`);
    await context.close();
  }

  // 5. Reduced motion: static composition, no parallax, entrance skipped.
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    const first = await page.screenshot();
    await page.mouse.move(1300, 200);
    await page.waitForTimeout(900);
    const second = await page.screenshot();
    const diff = await page.evaluate(
      async ([a, b]) => {
        const load = (d) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = `data:image/png;base64,${d}`;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const c = document.createElement('canvas');
        c.width = ia.width;
        c.height = ia.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(ia, 0, 0);
        const da = ctx.getImageData(0, 0, c.width, c.height).data;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(ib, 0, 0);
        const db = ctx.getImageData(0, 0, c.width, c.height).data;
        let changed = 0;
        for (let i = 0; i < da.length; i += 4) {
          if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 8) changed += 1;
        }
        return (changed / (da.length / 4)) * 100;
      },
      [first.toString('base64'), second.toString('base64')]
    );
    if (diff > 0.2) record('FAIL', 'reduced motion is static', `${diff.toFixed(2)}% pixels moved with the pointer`);
    else record('PASS', 'reduced motion is static', `${diff.toFixed(2)}% pixels changed across 900 ms + pointer move`);
    await context.close();
  }

  // 6. Pointer parallax exists when motion is allowed (proves the scene responds,
  //    and that the response is subtle rather than a camera swing).
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);
    const before = await page.screenshot();
    await page.mouse.move(1400, 120);
    await page.waitForTimeout(700);
    const after = await page.screenshot();
    const diff = await page.evaluate(
      async ([a, b]) => {
        const load = (d) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = `data:image/png;base64,${d}`;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const c = document.createElement('canvas');
        c.width = ia.width;
        c.height = ia.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(ia, 0, 0);
        const da = ctx.getImageData(0, 0, c.width, c.height).data;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(ib, 0, 0);
        const db = ctx.getImageData(0, 0, c.width, c.height).data;
        let changed = 0;
        for (let i = 0; i < da.length; i += 4) {
          if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 10) changed += 1;
        }
        return (changed / (da.length / 4)) * 100;
      },
      [before.toString('base64'), after.toString('base64')]
    );
    if (diff < 0.05) record('FAIL', 'pointer parallax responds', `${diff.toFixed(3)}%`);
    else if (diff > 12) record('FAIL', 'pointer parallax is subtle', `${diff.toFixed(2)}% of the page moved`);
    else record('PASS', 'pointer parallax is subtle', `${diff.toFixed(2)}% of the page changed`);
    await page.close();
  }

  // 7. Foreground controls stay usable and the exit transition lands on /login.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const started = Date.now();
    await page.getByRole('link', { name: /staff sign in/i }).click();
    await page.waitForURL('**/login', { timeout: 3000 });
    const elapsed = Date.now() - started;
    await page.waitForSelector('#email');
    record('PASS', 'sign-in link works over the canvas', `navigated in ${elapsed} ms`);
    if (elapsed > 900) record('NOTE', 'exit fade adds latency', `${elapsed} ms`);
    await page.close();
  }

  // 8. Resize and orientation change keep the canvas in step with its box.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    const portrait = await canvasInfo(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(900);
    const landscape = await canvasInfo(page);
    const grew = landscape.canvas && landscape.cssWidth > portrait.cssWidth;
    if (!landscape.canvas) record('FAIL', 'orientation change keeps the canvas');
    else if (!grew) record('FAIL', 'orientation change resizes the canvas', `${portrait.cssWidth} -> ${landscape.cssWidth}`);
    else record('PASS', 'orientation change resizes the canvas', `${portrait.cssWidth} -> ${landscape.cssWidth}px css`);
    if (errors.length) record('FAIL', 'orientation change: page errors', errors.join(' | '));
    await page.close();
  }

  // 9. Keyboard: the landing page is operable without a pointer, and the canvas
  //    never takes focus.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        tag: el.tagName,
        text: (el.textContent || '').trim(),
        isCanvas: el.tagName === 'CANVAS',
        outline: `${style.outlineStyle} ${style.outlineWidth}`,
      };
    });
    if (!focus || focus.isCanvas) record('FAIL', 'first Tab does not enter the canvas', JSON.stringify(focus));
    else if (!focus.outline.includes('solid')) record('FAIL', 'first Tab shows a focus ring', JSON.stringify(focus));
    else record('PASS', 'first Tab reaches the sign-in link with a visible focus ring', JSON.stringify(focus));
    await page.close();
  }

  // 10. Frame pacing under a throttled CPU. SwiftShader is not a phone GPU, so
  //     this is recorded as a NOTE, not a performance claim.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2600);
    const fps = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const frames = [];
          const start = performance.now();
          const tick = (t) => {
            frames.push(t);
            if (t - start < 2000) requestAnimationFrame(tick);
            else {
              const deltas = frames.slice(1).map((f, i) => f - frames[i]);
              deltas.sort((a, b) => a - b);
              resolve({ fps: (frames.length / (t - start)) * 1000, p95: deltas[Math.floor(deltas.length * 0.95)] });
            }
          };
          requestAnimationFrame(tick);
        })
    );
    record('NOTE', 'frame pacing at 390x844 with 4x CPU throttle (SwiftShader)', `${fps.fps.toFixed(1)} fps, p95 frame ${fps.p95.toFixed(1)} ms`);
    await context.close();
  }

  // 11. Lazy loading: the scene chunk is not fetched by the auth screen, and is
  //     fetched by the landing page.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const requested = [];
    page.on('request', (req) => requested.push(req.url()));
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const onLogin = requested.filter((u) => /RecoveryNetwork|three|fiber/i.test(u));
    requested.length = 0;
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const onLanding = requested.filter((u) => /RecoveryNetwork|three|fiber/i.test(u));
    if (onLogin.length) record('FAIL', 'auth screen does not load the 3D chunk', onLogin.join(', '));
    else if (!onLanding.length) record('FAIL', 'landing page lazy-loads the 3D chunk', 'no matching request');
    else record('PASS', '3D chunk is lazy', `${onLanding.length} request(s) on the landing page, none on /login`);
    await context.close();
  }

  await browser.close();

  const failures = results.filter((r) => r.status === 'FAIL');
  process.stdout.write(`\n${results.length} checks, ${failures.length} failure(s)\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(2);
});
