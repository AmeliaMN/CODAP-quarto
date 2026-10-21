// codap-quarto-bridge.js
// Host-side ES module — uses window.postMessage for cross-origin iframe communication.
// Runs in the Quarto page (or any host page) that embeds CODAP in an iframe.
//
// Message schema:
// ─────────────────────────────────────────────────────────────────────────────
// Outbound (Host -> Plugin via postMessage):
//   { type: "bridge:get",  id: string, resource: string }
//   { type: "bridge:ping", id: string }
//
// Inbound (Plugin -> Host via window.parent.parent.postMessage):
//   { type: "bridge:reply",  id: string, success: boolean, result?: any }
//   { type: "bridge:pong",   id: string | null }
//   { type: "bridge:status", status: "initializing"|"connected"|"error", monitorId?: any, error?: string }
//   { type: "bridge:event",  payload: any }
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT   = 8000;   // ms — per-request timeout for get()
const HANDSHAKE_TIMEOUT = 12000;  // ms — handshake timeout for connect()

let _idCounter = 0;
function makeId() {
  return `bq-${Date.now()}-${++_idCounter}`;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[codap-quarto-bridge] Timeout: ${label} (${ms}ms)`)), ms)
    ),
  ]);
}

export class CodapBridge {
  /**
   * @param {HTMLIFrameElement|string} [iframeTarget] - CODAP <iframe> DOM element or CSS selector (default: "#codap-iframe" or first iframe)
   * @param {object} [options]
   * @param {number} [options.timeout]          - Per-request timeout in ms (default 8000)
   * @param {number} [options.handshakeTimeout] - connect() timeout in ms (default 12000)
   */
  constructor(iframeTarget, { timeout = DEFAULT_TIMEOUT, handshakeTimeout = HANDSHAKE_TIMEOUT } = {}) {
    this._iframeTarget     = iframeTarget;
    this._timeout          = timeout;
    this._handshakeTimeout = handshakeTimeout;
    this._pending          = new Map();   // id -> { resolve, reject }
    this._eventHandlers    = new Set();   // handlers registered via subscribe()
    this._connected        = false;
    this._statusLog        = [];
    this._messageListener  = null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _resolveIframe() {
    if (this._iframeTarget instanceof HTMLIFrameElement) {
      return this._iframeTarget;
    }
    if (typeof this._iframeTarget === "string") {
      return document.querySelector(this._iframeTarget);
    }
    // Default fallback: look for #codap-iframe or any iframe on the page
    return document.getElementById("codap-iframe") || document.querySelector("iframe");
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Listen on window postMessage and handshake with the CODAP plugin.
   * @returns {Promise<void>}
   */
  connect() {
    if (this._connected) return Promise.resolve();

    if (!this._messageListener) {
      this._messageListener = (event) => this._handleMessage(event.data);
      window.addEventListener("message", this._messageListener);
    }

    return withTimeout(
      new Promise((resolve, reject) => {
        this._connectResolve = resolve;
        this._connectReject  = reject;

        // Poll ping every 800ms until handshake resolves or times out
        const pingInterval = setInterval(() => {
          if (this._connected) {
            clearInterval(pingInterval);
            return;
          }
          this._broadcastPing();
        }, 800);

        this._broadcastPing();
      }),
      this._handshakeTimeout,
      "connect()"
    );
  }

  /**
   * Detach message listeners and cancel all pending requests.
   */
  disconnect() {
    if (this._messageListener) {
      window.removeEventListener("message", this._messageListener);
      this._messageListener = null;
    }
    this._connected = false;
    for (const [id, { reject }] of this._pending) {
      reject(new Error("[codap-quarto-bridge] Disconnected before reply received"));
    }
    this._pending.clear();
    this._eventHandlers.clear();
  }

  // ── Core API ───────────────────────────────────────────────────────────────

  /**
   * One-shot read of a CODAP resource.
   *
   * @param {string} resource  - CODAP resource string, e.g. "componentList" or "component[calc1]"
   * @returns {Promise<any>}   - Resolves with result payload
   */
  get(resource) {
    this._assertConnected("get");
    const id = makeId();

    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });

    this._send({ type: "bridge:get", id, resource });

    return withTimeout(promise, this._timeout, `get("${resource}")`).catch((err) => {
      this._pending.delete(id);
      throw err;
    });
  }

  /**
   * Subscribe to CODAP UI events forwarded by the plugin.
   *
   * @param {function} handler  - Called with each bridge:event payload
   * @returns {function}        - Call to unsubscribe
   */
  subscribe(handler) {
    this._eventHandlers.add(handler);
    return () => this._eventHandlers.delete(handler);
  }

  /**
   * Wrap a CODAP resource as an Observable-compatible async generator.
   *
   * @param {string}   resource          - CODAP resource string
   * @param {"poll"|"event"} [mode]      - "poll" re-fetches on every bridge:event; "event" yields raw event
   * @param {number}   [pollInterval]    - Fallback polling interval in ms (0 = disabled)
   * @returns {AsyncGenerator}
   */
  async *observable(resource, mode = "poll", pollInterval = 0) {
    this._assertConnected("observable");

    // Yield initial value immediately
    yield await this.get(resource);

    let resolve;
    const queue = [];

    const unsub = this.subscribe((payload) => {
      if (resolve) {
        resolve(payload);
        resolve = null;
      } else {
        queue.push(payload);
      }
    });

    try {
      while (true) {
        const eventPayload = await Promise.race([
          new Promise((r) => { resolve = r; }),
          ...(pollInterval > 0
            ? [new Promise((r) => setTimeout(r, pollInterval))]
            : []),
        ]);

        if (mode === "event") {
          yield eventPayload ?? null;
        } else {
          yield await this.get(resource);
        }
      }
    } finally {
      unsub();
    }
  }

  // ── Internal Messaging ─────────────────────────────────────────────────────

  _broadcastPing() {
    this._send({ type: "bridge:ping", id: makeId() });
  }

  _send(msg) {
    const iframe = this._resolveIframe();
    if (!iframe || !iframe.contentWindow) {
      console.warn("[codap-quarto-bridge] No CODAP iframe found to send message to");
      return;
    }

    // 1. Post to CODAP iframe
    iframe.contentWindow.postMessage(msg, "*");

    // 2. Post to any nested plugin frames inside CODAP iframe if accessible
    try {
      const frames = iframe.contentWindow.frames;
      for (let i = 0; i < frames.length; i++) {
        frames[i].postMessage(msg, "*");
      }
    } catch (e) {
      // Cross-origin access to sub-frames may throw; post to parent window is sufficient
    }
  }

  _assertConnected(method) {
    if (!this._connected) {
      throw new Error(`[codap-quarto-bridge] Not connected — call connect() before ${method}()`);
    }
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== "object" || !msg.type) return;

    switch (msg.type) {
      case "bridge:status": {
        this._statusLog.push({ ts: Date.now(), ...msg });
        if ((msg.status === "connected" || msg.status === "ready") && this._connectResolve) {
          this._connected = true;
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject  = null;
        } else if (msg.status === "error" && this._connectReject) {
          this._connectReject(new Error(`[codap-quarto-bridge] Plugin error: ${msg.error}`));
          this._connectResolve = null;
          this._connectReject  = null;
        }
        break;
      }

      case "bridge:pong": {
        if (!this._connected && this._connectResolve) {
          this._connected = true;
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject  = null;
        }
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          resolve();
        }
        break;
      }

      case "bridge:reply": {
        const { id, success, result } = msg;
        if (!id || !this._pending.has(id)) return;
        const { resolve, reject } = this._pending.get(id);
        this._pending.delete(id);
        if (success) {
          resolve(result?.values ?? result);
        } else {
          reject(new Error(`[codap-quarto-bridge] CODAP error for id ${id}: ${JSON.stringify(result)}`));
        }
        break;
      }

      case "bridge:event": {
        for (const handler of this._eventHandlers) {
          try {
            handler(msg.payload);
          } catch (e) {
            console.error("[codap-quarto-bridge] Event handler error:", e);
          }
        }
        break;
      }

      default:
        break;
    }
  }
}

// ─── Convenience Factory ─────────────────────────────────────────────────────

export async function createBridge(iframeTarget, options = {}) {
  const bridge = new CodapBridge(iframeTarget, options);
  await bridge.connect();
  return bridge;
}
