/**
 * Native HTTP bridge for the in-app engine on Capacitor (iOS/Android).
 *
 * WHY: "Play on this device" runs the whole AI-DM engine inside a WebView and
 * calls the user's LLM endpoint straight from client JS. In a plain browser that
 * is an ordinary cross-origin `fetch`, which the provider must allow via CORS —
 * fine for OpenRouter/OpenAI/Anthropic (they send CORS headers) but a hard wall
 * for endpoints that don't. Inside a Capacitor native WebView we can do better:
 * the CapacitorHttp core plugin performs the request on the NATIVE side (URLSession
 * / OkHttp), which is not a browser context and therefore has NO CORS check and
 * is not gated by the page CSP's `connect-src`. Routing the provider's HTTP
 * through it makes any LLM host reachable on device.
 *
 * DESIGN: this module is transport-only and DOM-free. It FEATURE-DETECTS the
 * Capacitor runtime off a global (`globalThis.Capacitor`, injected by the native
 * shell) — it does NOT import `@capacitor/core`, so nothing Capacitor-specific is
 * pulled into the browser bundle or the Node build, and it imports cleanly under
 * Node for the offline smoke. `selectFetch()` returns a `fetch`-compatible
 * function backed by CapacitorHttp when (and only when) running natively, and
 * `undefined` otherwise — the providers read `undefined` as "use your default
 * (the global fetch / the OpenAI SDK's built-in)", so a normal browser and the
 * Node server are completely unaffected.
 *
 * SECURITY: the user's API key rides in the request headers exactly as with a
 * plain fetch — handed only to the endpoint the user configured, never logged
 * here, never persisted. The native plugin is a transport, not a store.
 */

/** The subset of the WHATWG `fetch` signature the providers actually use. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The single CapacitorHttp method we need (see @capacitor/core's HttpPlugin). */
export interface CapacitorHttpLike {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    data?: unknown;
    responseType?: 'text' | 'json' | 'arraybuffer' | 'blob' | 'document';
    connectTimeout?: number;
    readTimeout?: number;
  }): Promise<{ status: number; data: unknown; headers?: Record<string, string>; url?: string }>;
}

/** The shape of the `Capacitor` global the native runtime injects into the WebView. */
export interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { CapacitorHttp?: CapacitorHttpLike };
}

type GlobalWithCapacitor = typeof globalThis & {
  Capacitor?: CapacitorGlobal;
  CapacitorHttp?: CapacitorHttpLike;
  Response?: typeof Response;
};

/** True iff we are running inside a Capacitor NATIVE WebView (not a browser tab). */
export function isCapacitorNative(g: typeof globalThis = globalThis): boolean {
  const cap = (g as GlobalWithCapacitor).Capacitor;
  return !!cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() === true;
}

/** The registered CapacitorHttp plugin, if present and callable. */
export function getCapacitorHttp(g: typeof globalThis = globalThis): CapacitorHttpLike | undefined {
  const gg = g as GlobalWithCapacitor;
  const http = gg.Capacitor?.Plugins?.CapacitorHttp ?? gg.CapacitorHttp;
  return http && typeof http.request === 'function' ? http : undefined;
}

/** Normalize the various `HeadersInit` shapes into a plain object. */
function headersToObject(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers).forEach === 'function' && !Array.isArray(headers)) {
    (headers as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) out[key] = value;
  return out;
}

function isJsonContentType(headers: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return /application\/json/i.test(v);
  }
  return false;
}

/**
 * Build a `fetch`-compatible function that performs the request natively via
 * CapacitorHttp and returns a standard `Response` (so callers — including the
 * OpenAI SDK — read `.ok` / `.status` / `.json()` / `.text()` unchanged).
 *
 * Response bodies are fetched as text to preserve the exact JSON bytes for
 * `.json()`; request bodies that are JSON strings are parsed back to objects so
 * the plugin serializes them once (CapacitorHttp double-encodes a raw string
 * when the content-type is application/json).
 */
export function makeNativeFetch(http: CapacitorHttpLike, ResponseCtor: typeof Response = Response): FetchLike {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method =
      (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : undefined) ?? 'GET').toUpperCase();
    const headers = headersToObject(init?.headers);

    let data: unknown = init?.body;
    if (typeof data === 'string' && isJsonContentType(headers)) {
      try {
        data = JSON.parse(data);
      } catch {
        /* leave as string if it is not valid JSON */
      }
    }

    const res = await http.request({ url, method, headers, data, responseType: 'text' });
    const bodyText = typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data);
    // A 204/205 must carry a null body per the Response spec.
    const nullBody = res.status === 204 || res.status === 205 || bodyText === '';
    return new ResponseCtor(nullBody ? null : bodyText, {
      status: res.status,
      headers: res.headers ?? {},
    });
  };
}

/**
 * The `fetch` the in-app providers should use: a native-backed one when running
 * inside a Capacitor native WebView with CapacitorHttp available, else
 * `undefined` (meaning "keep your default"). This is the one call the composition
 * root makes; everything above is exported for the offline smoke to exercise the
 * selection and the request/response mapping deterministically.
 */
export function selectFetch(g: typeof globalThis = globalThis): FetchLike | undefined {
  if (!isCapacitorNative(g)) return undefined;
  const http = getCapacitorHttp(g);
  if (!http) return undefined;
  const ResponseCtor = (g as GlobalWithCapacitor).Response ?? Response;
  return makeNativeFetch(http, ResponseCtor);
}
