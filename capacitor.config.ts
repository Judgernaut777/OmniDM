/**
 * Capacitor configuration — the MOBILE (iOS + Android) shell around the OmniDM
 * web client.
 *
 * HYBRID MODEL: like the Tauri desktop shell, the mobile app is a native WebView
 * that loads the SAME committed web client (`web/`) and runs the whole AI-DM
 * engine (`web/engine.bundle.js`) IN THE WEBVIEW. There is no Node sidecar and
 * no server bundled into the app — "Play on this device" talks straight to the
 * user's own LLM endpoint. `webDir` therefore points at the committed `web/`
 * directory (index.html + app.js + style.css + portraits.js + transport.js +
 * engine.bundle.js), exactly what `npm run web` serves.
 *
 * NATIVE HTTP (CORS bypass): `CapacitorHttp` is enabled so the in-app provider
 * can route the LLM request through the native HTTP stack instead of a browser
 * `fetch`. On device that avoids CORS entirely (the call is not a browser
 * context) — see src/browser/native-http.ts, which feature-detects the Capacitor
 * runtime and hands the providers a native-backed fetch. Enabling the plugin
 * here also registers `Capacitor.Plugins.CapacitorHttp`, which that module uses.
 *
 * The `ts` extension is read by the Capacitor CLI's own loader; it is NOT part of
 * the app's `tsconfig.json` build graph (which is `src/**` only), so it never
 * affects `npm run typecheck` / `npm run smoke`.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.omnidm.app',
  appName: 'OmniDM',
  // The committed web client — same files `npm run web` serves and the Tauri
  // shell wraps. No separate build/copy step: engine.bundle.js is committed.
  webDir: 'web',
  // Serve the app over https://localhost on both platforms so the page origin is
  // a secure context (needed for crypto/IndexedDB parity with the browser build)
  // and stable for the CSP's same-origin rules.
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
  },
  plugins: {
    // Native HTTP transport for the in-app LLM provider (bypasses WebView CORS).
    // Feature-detected at runtime in src/browser/native-http.ts.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
