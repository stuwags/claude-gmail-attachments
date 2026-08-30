/**
 * Generates the app icons into `public/icons/`.
 *
 * The mark is four discs in a two-by-two block, two of each colour — legible at
 * 32 px where a whole 7x6 grid would collapse into mush, and unmistakably this
 * game rather than a generic board-game glyph. Colours and the backdrop
 * gradient come straight from `docs/ART_BIBLE.md` §0 so the icon matches the
 * product it launches.
 *
 * Rendered by rasterising SVG in headless Chromium rather than pulling in an
 * image library, since Chromium is already here for the screenshot harness.
 *
 *   node tools/make-icons.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const EMBER = '#CE5A32';
const PETROL = '#0F6068';
const VOID_LOW = '#101114';
const VOID_HIGH = '#1D2024';
const POOL = '#2A2521';

/**
 * @param size    pixel dimensions
 * @param inset   fraction of the canvas kept clear of content. Maskable icons
 *                get cropped to a circle of 80% diameter on some launchers, so
 *                their content has to sit well inside the frame.
 * @param rounded whether to round the corners (never for maskable — the
 *                launcher applies its own mask and a pre-rounded icon shows a
 *                dark halo inside it).
 */
function svg(size, inset, rounded) {
  const s = size;
  const r = rounded ? s * 0.22 : 0;
  // Disc block geometry, centred, scaled by the inset.
  const block = s * (1 - inset * 2) * 0.86;
  const cx = s / 2;
  const cy = s / 2;
  const gap = block * 0.075;
  const rad = (block - gap) / 4;
  const off = rad + gap / 2;

  const discs = [
    { x: cx - off, y: cy - off, fill: EMBER },
    { x: cx + off, y: cy - off, fill: PETROL },
    { x: cx - off, y: cy + off, fill: PETROL },
    { x: cx + off, y: cy + off, fill: EMBER },
  ];

  // A disc is a flat cylinder seen face-on, so the shading stays close to even
  // across the face and the form is carried by the rim: a bright lit arc at the
  // top-left and a dark contact arc opposite. A strong radial falloff here
  // would read as a sphere, which is the wrong object entirely.
  const disc = (d, i) => `
    <g>
      <circle cx="${d.x}" cy="${d.y}" r="${rad}" fill="url(#body${i})"/>
      <circle cx="${d.x}" cy="${d.y}" r="${rad * 0.955}" fill="none"
              stroke="${darken(d.fill, 0.35)}" stroke-width="${rad * 0.09}" opacity="0.55"/>
      <!-- Softbox highlight: rectangular, matching the key light in the game. -->
      <rect x="${d.x - rad * 0.6}" y="${d.y - rad * 0.62}"
            width="${rad * 0.42}" height="${rad * 0.66}"
            rx="${rad * 0.08}" fill="url(#gloss)" transform="rotate(-16 ${d.x} ${d.y})"/>
      <path d="${arc(d.x, d.y, rad * 0.975, 185, 310)}" fill="none"
            stroke="rgba(255,248,240,0.34)" stroke-width="${rad * 0.055}" stroke-linecap="round"/>
      <path d="${arc(d.x, d.y, rad * 0.975, 20, 130)}" fill="none"
            stroke="rgba(0,0,0,0.4)" stroke-width="${rad * 0.06}" stroke-linecap="round"/>
    </g>`;

  const bodyGradients = discs
    .map(
      (d, i) => `
      <linearGradient id="body${i}" x1="0.18" y1="0" x2="0.82" y2="1">
        <stop offset="0%" stop-color="${lighten(d.fill, 0.2)}"/>
        <stop offset="52%" stop-color="${d.fill}"/>
        <stop offset="100%" stop-color="${darken(d.fill, 0.26)}"/>
      </linearGradient>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="ground" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="${VOID_LOW}"/>
      <stop offset="100%" stop-color="${VOID_HIGH}"/>
    </linearGradient>
    <radialGradient id="pool" cx="50%" cy="46%" r="58%">
      <stop offset="0%" stop-color="${POOL}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${POOL}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.34)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.04)"/>
    </linearGradient>
    ${bodyGradients}
  </defs>
  <rect width="${s}" height="${s}" rx="${r}" fill="url(#ground)"/>
  <rect width="${s}" height="${s}" rx="${r}" fill="url(#pool)"/>
  ${discs.map(disc).join('')}
</svg>`;
}

/** SVG path for an arc of a circle, from `a0` to `a1` degrees (0 = east, clockwise). */
function arc(cx, cy, r, a0, a1) {
  const p = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + Math.cos(rad) * r, cy + Math.sin(rad) * r];
  };
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function lighten(hex, amount) {
  return mix(hex, [255, 245, 235], amount);
}
function darken(hex, amount) {
  return mix(hex, [8, 9, 11], amount);
}
function mix(hex, target, amount) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const out = c.map((v, i) => Math.round(v + (target[i] - v) * amount));
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0.14, rounded: true },
  { file: 'icon-512.png', size: 512, inset: 0.14, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.22, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.1, rounded: false },
  { file: 'favicon-64.png', size: 64, inset: 0.1, rounded: true },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-dev-shm-usage'] });

  try {
    for (const icon of ICONS) {
      const markup = svg(icon.size, icon.inset, icon.rounded);
      const page = await browser.newPage({
        viewport: { width: icon.size, height: icon.size },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<style>html,body{margin:0;padding:0;background:transparent}</style>${markup}`,
        { waitUntil: 'load' },
      );
      const buffer = await page.screenshot({ omitBackground: false });
      await writeFile(path.join(OUT, icon.file), buffer);
      await page.close();
      console.log(`  public/icons/${icon.file}  ${icon.size}x${icon.size}`);
    }
    // Keep one SVG around so the mark can be re-cut at any size later.
    await writeFile(path.join(OUT, 'icon.svg'), svg(512, 0.14, true));
    console.log('  public/icons/icon.svg');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
