import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Builds the whole game into one self-contained HTML file.
 *
 * The normal build splits into chunks, a worker and a service worker, which is
 * right for a site but useless for anywhere a page has to arrive as a single
 * document — a hosted link, an email attachment, a USB stick. Everything is
 * inlined here instead: scripts, styles, and the search worker.
 *
 * The worker matters most. Left as a separate file it would 404, and while the
 * client falls back to searching on the main thread, that is a needless
 * regression when inlining costs nothing. `format: 'iife'` plus
 * `inlineDynamicImports` is what lets the plugin fold it into the document.
 */
export default defineConfig({
  base: './',
  worker: {
    format: 'iife',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  build: {
    target: 'es2022',
    outDir: 'dist-standalone',
    // One file: no separate chunks to fetch, nothing to lose in transit.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
});
