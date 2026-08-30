/**
 * Repackages the single-file build as an Artifact page.
 *
 * The Artifact host supplies its own document skeleton — doctype, html, head,
 * body — so a page handed to it must be document *content*, not a document.
 * This lifts the title, the stylesheet and the bundle out of the built file and
 * drops the wrapper, rather than maintaining a second hand-written copy of a
 * page that is already generated.
 *
 *   npm run build:standalone && node tools/make-artifact.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dist-standalone', 'index.html');
const OUT = path.join(ROOT, 'dist-artifact', 'connect-four.html');

/** Slice out the contents of the first `<tag ...>…</tag>` pair. */
function extract(html, tag) {
  const open = html.indexOf(`<${tag}`);
  if (open === -1) return null;
  const openEnd = html.indexOf('>', open);
  const close = html.indexOf(`</${tag}>`, openEnd);
  if (openEnd === -1 || close === -1) return null;
  return {
    attrs: html.slice(open + tag.length + 1, openEnd).trim(),
    body: html.slice(openEnd + 1, close),
  };
}

const html = await readFile(SRC, 'utf8');

const style = extract(html, 'style');
const script = extract(html, 'script');
if (!style || !script) throw new Error('could not find the inlined style and script');

const bodyOpen = html.indexOf('<body>');
const bodyClose = html.indexOf('</body>');
if (bodyOpen === -1 || bodyClose === -1) throw new Error('could not find the body');
const bodyContent = html.slice(html.indexOf('>', bodyOpen) + 1, bodyClose).trim();

const page = `<title>Smoke &amp; Ember Connect Four</title>

<style>
/* The host paints its own ground behind the page, and this game is a lit
   studio set — it commits to one visual world and must not borrow a light
   theme's background through a transparent body. The canvas also needs the
   whole viewport: it is the product, not an illustration inside a document. */
html, body {
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: #0b0d10;
  overscroll-behavior: none;
}
#stage {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}
</style>

<style>${style.body}</style>

${bodyContent}

<script type="module">${script.body}</script>
`;

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, page);
console.log(`${path.relative(ROOT, OUT)}  ${(page.length / 1024 / 1024).toFixed(2)} MB`);
