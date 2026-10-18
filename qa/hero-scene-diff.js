'use strict';

// Isolates the pixels contributed by the decorative scene: captures the hero,
// hides the canvas, captures again, and reports the difference as an ASCII map
// plus line/node pixel counts. Used to confirm connection paths actually render.
const { chromium } = require(process.cwd() + '/node_modules/@playwright/test');

const BASE = process.env.BASE || 'http://localhost:5173';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2600);
  const withScene = await page.screenshot();
  await page.addStyleTag({ content: '.hero-visual{display:none !important}' });
  await page.waitForTimeout(200);
  const withoutScene = await page.screenshot();

  const analysis = await page.evaluate(
    async ([a, b]) => {
      const load = (dataUrl) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = dataUrl;
        });
      const [imgA, imgB] = await Promise.all([
        load(`data:image/png;base64,${a}`),
        load(`data:image/png;base64,${b}`),
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = imgA.width;
      canvas.height = imgA.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgA, 0, 0);
      const da = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(imgB, 0, 0);
      const db = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      const X = 200;
      const Y = 0;
      const W = 1040;
      const H = 470;
      const OW = 104;
      const OH = 40;
      const ramp = ' .:-=+*#%@';
      const rows = [];
      let changed = 0;
      let strong = 0;
      let maxDelta = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = ((Y + y) * canvas.width + X + x) * 4;
          const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
          if (d > 6) changed += 1;
          if (d > 40) strong += 1;
          if (d > maxDelta) maxDelta = d;
        }
      }
      for (let y = 0; y < OH; y += 1) {
        let line = '';
        for (let x = 0; x < OW; x += 1) {
          const sx = Math.floor(X + (x + 0.5) * (W / OW));
          const sy = Math.floor(Y + (y + 0.5) * (H / OH));
          let sum = 0;
          for (let oy = 0; oy < 4; oy += 1) {
            for (let ox = 0; ox < 10; ox += 1) {
              const i = ((sy + oy) * canvas.width + sx + ox) * 4;
              sum +=
                Math.abs(da[i] - db[i]) +
                Math.abs(da[i + 1] - db[i + 1]) +
                Math.abs(da[i + 2] - db[i + 2]);
            }
          }
          const v = Math.min(1, sum / (40 * 90));
          line += ramp[Math.min(9, Math.round(Math.pow(v, 0.5) * 9))];
        }
        rows.push(line);
      }
      return { changed, strong, maxDelta, rows };
    },
    [withScene.toString('base64'), withoutScene.toString('base64')]
  );

  console.log('scene pixels changed:', analysis.changed, 'strong:', analysis.strong, 'maxDelta:', analysis.maxDelta);
  console.log(analysis.rows.join('\n'));
  await browser.close();
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(2);
});
