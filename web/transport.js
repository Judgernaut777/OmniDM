/* OmniDM client transport abstraction — the hybrid model.
 *
 * The client talks to a Transport, never to a WebSocket directly, so the SAME
 * UI + protocol frames drive two backends:
 *
 *   • RemoteTransport — the existing WebSocket path to an OmniDM server. Protocol
 *     unchanged: hello/say/move up; welcome/roster/msg/roll/scene/error down.
 *     Multiplayer; reconnects with backoff. Portrait bytes go over HTTP.
 *
 *   • LocalTransport — runs the shared engine IN THE PAGE (RoomEngine + Bot +
 *     a browser SessionStorage + a provider built from the user's own settings,
 *     from web/engine.bundle.js). It routes the identical frames in-process —
 *     the only network is the LLM provider call the user configured. Single
 *     device (solo/hotseat); no reconnect (nothing to reconnect to).
 *
 * Every Transport exposes the same surface app.js uses:
 *   open(), send(frame), close(), isOpen(), httpBase(),
 *   uploadPortrait({channelId,userId,token,file}) -> {ok,status},
 *   and the flags .local / .multiplayer / .supportsReconnect.
 *
 * SECURITY: the LLM API key is a secret. LocalTransport hands the user's LLM
 * settings straight to the engine bundle (which passes the key only to the
 * provider fetch/SDK). Nothing here logs it, renders it, or serializes it.
 */
'use strict';

(function () {
  /** Read a File as base64 (+ its mime) without pulling bytes through the UI. */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('read failed'));
      fr.onload = () => {
        const url = String(fr.result || '');
        const comma = url.indexOf(',');
        const meta = url.slice(0, comma);
        const mimeMatch = meta.match(/data:([^;]+)/);
        resolve({ mime: (mimeMatch && mimeMatch[1]) || file.type || 'application/octet-stream', base64: url.slice(comma + 1) });
      };
      fr.readAsDataURL(file);
    });
  }

  /* ── Remote (WebSocket to an OmniDM server) ──────────────────────────────── */

  class RemoteTransport {
    /** @param {{serverUrl?:string, onFrame:Function, onOpen:Function, onClose:Function}} o */
    constructor(o) {
      this.local = false;
      this.multiplayer = true;
      this.supportsReconnect = true;
      this._serverUrl = (o.serverUrl || '').trim(); // '' = the origin that served this page
      this._onFrame = o.onFrame;
      this._onOpen = o.onOpen;
      this._onClose = o.onClose;
      this._ws = null;
    }

    /** Parsed server origin, or null for same-origin. Accepts ws(s):// or http(s)://. */
    _origin() {
      if (!this._serverUrl) return null;
      let u = this._serverUrl.replace(/\/+$/, '');
      // Tolerate a bare host or a ws(s)/http(s) URL; normalize to a URL object.
      if (!/^[a-z]+:\/\//i.test(u)) u = (location.protocol === 'https:' ? 'wss://' : 'ws://') + u;
      try {
        return new URL(u);
      } catch {
        return null;
      }
    }

    _wsUrl() {
      const o = this._origin();
      if (!o) {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        return `${proto}://${location.host}/ws`;
      }
      const wsProto = o.protocol === 'https:' || o.protocol === 'wss:' ? 'wss' : 'ws';
      return `${wsProto}://${o.host}/ws`;
    }

    /** Base for HTTP endpoints (portraits); '' when same-origin. */
    httpBase() {
      const o = this._origin();
      if (!o) return '';
      const httpProto = o.protocol === 'https:' || o.protocol === 'wss:' ? 'https' : 'http';
      return `${httpProto}://${o.host}`;
    }

    open() {
      const ws = new WebSocket(this._wsUrl());
      this._ws = ws;
      ws.addEventListener('open', () => this._onOpen());
      ws.addEventListener('message', (ev) => {
        let f;
        try {
          f = JSON.parse(ev.data);
        } catch {
          return;
        }
        this._onFrame(f);
      });
      ws.addEventListener('close', () => this._onClose());
    }

    isOpen() {
      return Boolean(this._ws) && this._ws.readyState === WebSocket.OPEN;
    }

    send(frame) {
      if (this.isOpen()) this._ws.send(JSON.stringify(frame));
    }

    close() {
      if (this._ws) this._ws.close();
    }
  }

  /* ── Local (engine runs in the page) ─────────────────────────────────────── */

  class LocalTransport {
    /** @param {{settings:object, onFrame:Function, onOpen:Function, onClose:Function, provider?:object, storage?:object}} o */
    constructor(o) {
      this.local = true;
      this.multiplayer = false;
      this.supportsReconnect = false;
      this._settings = o.settings || {};
      this._onFrame = o.onFrame;
      this._onOpen = o.onOpen;
      this._onClose = o.onClose;
      this._provider = o.provider; // injected (tests) — else the engine builds one from settings
      this._storage = o.storage; // injected (tests) — else durable browser storage
      this._engine = null;
      this._conn = null;
      this._open = false;
    }

    httpBase() {
      return '';
    }

    open() {
      const engineApi = globalThis.OmniDMEngine;
      if (!engineApi || typeof engineApi.createLocalEngine !== 'function') {
        // The bundle failed to load — surface it as an error frame, not a crash.
        this._onFrame({ type: 'error', error: 'In-app engine failed to load (web/engine.bundle.js). Run `npm run build:web`.' });
        return;
      }
      try {
        this._engine = engineApi.createLocalEngine({
          llm: this._settings.llm || {},
          provider: this._provider,
          storage: this._storage,
        });
      } catch (e) {
        this._onFrame({ type: 'error', error: 'Could not start the in-app engine: ' + (e && e.message ? e.message : e) });
        return;
      }
      // The engine pushes protocol frames straight to the client callback.
      this._conn = { send: (frame) => this._onFrame(frame), close: () => {} };
      this._open = true;
      // Defer the "open" signal a microtask so the caller can finish wiring
      // state before the first frame, mirroring a WebSocket 'open' event.
      Promise.resolve().then(() => {
        if (this._open) this._onOpen();
      });
    }

    isOpen() {
      return this._open;
    }

    send(frame) {
      if (this._open && this._engine) this._engine.room.handleFrame(this._conn, frame);
    }

    close() {
      this._open = false;
      // Nothing to reconnect to; app.js returns to the launch screen directly.
    }

    /** Store an uploaded portrait in-process (no HTTP endpoint in-app). */
    async uploadPortrait(o) {
      if (!this._open || !this._engine) return { ok: false, status: 0 };
      try {
        const { mime, base64 } = await fileToBase64(o.file);
        const result = await this._engine.setPortrait(o.channelId, o.userId, mime, base64);
        return result === 'ok'
          ? { ok: true, status: 200 }
          : { ok: false, status: result === 'no-player' ? 409 : 409 };
      } catch {
        return { ok: false, status: 0 };
      }
    }
  }

  globalThis.OmniDMTransport = { RemoteTransport, LocalTransport };
})();
