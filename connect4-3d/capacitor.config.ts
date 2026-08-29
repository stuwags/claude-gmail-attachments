import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native wrapper config. `npm run cap:ios` builds the web app and opens the
 * Xcode project; the same target runs on iPad and, via "Designed for iPad" on
 * Apple Silicon or a Mac Catalyst destination, on macOS.
 *
 * The web build is already a full PWA, so this wrapper exists only to get an
 * App Store binary and the native status-bar/splash behaviour.
 */
const config: CapacitorConfig = {
  appId: 'com.connectfour.grandmaster',
  appName: 'Connect Four',
  webDir: 'dist',
  // The renderer draws its own background; a transparent web view would show
  // the native window through the first frame.
  backgroundColor: '#0b0d10ff',
  ios: {
    contentInset: 'never',
    scrollEnabled: false,
    backgroundColor: '#0b0d10ff',
    // WKWebView on iPadOS honours this for the WebGL swap chain.
    limitsNavigationsToAppBoundDomains: true,
  },
  server: {
    // Serving from the bundle keeps the game fully offline.
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
};

export default config;
