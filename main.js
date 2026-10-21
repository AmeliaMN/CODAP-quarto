// bridge-plugin/main.js
// Zero-build ESM — loaded as <script type="module"> from index.html inside CODAP.

import {
  codapInterface,
  initializePlugin,
} from "./codap-plugin-api.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PLUGIN_NAME    = "quarto-bridge";
const PLUGIN_VERSION = "0.1.0";
const DIMENSIONS     = { width: 300, height: 60 };
const HOST_ORIGIN    = "*";

// ─── UI helpers ──────────────────────────────────────────────────────────────

const statusEl = document.getElementById("status");

function setStatus(msg) {
  console.log(`[bridge-plugin] ${msg}`);
  if (statusEl) statusEl.textContent = msg;
}

// ─── CODAP request dispatcher ────────────────────────────────────────────────

async function dispatchGet(id, resource, sourceWindow) {
  try {
    const result = await codapInterface.sendRequest({
      action: "get",
      resource,
    });
    
    // Reply directly back to whoever sent the request
    if (sourceWindow) {
      sourceWindow.postMessage({ type: "bridge:reply", id, success: true, result }, HOST_ORIGIN);
    }
  } catch (err) {
    if (sourceWindow) {
      sourceWindow.postMessage({ type: "bridge:reply", id, success: false, error: String(err) }, HOST_ORIGIN);
    }
  }
}

// ─── Incoming message handler ─────────────────────────────────────────────────

window.addEventListener("message", (event) => {
  const msg = event.data;
  
  // Ignore messages that do not belong to our bridge protocol (e.g. CODAP's iframe-phone internals)
  if (!msg || typeof msg !== "object" || !msg.type || !msg.type.startsWith("bridge:")) {
    return;
  }

  console.log("[bridge-plugin] received bridge message:", msg);

  switch (msg.type) {
    case "bridge:get":
      if (!msg.id || !msg.resource) {
        console.warn("[bridge-plugin] Malformed bridge:get message", msg);
        return;
      }
      dispatchGet(msg.id, msg.resource, event.source);
      break;

    case "bridge:ping":
      // Reply pong directly to the calling window
      if (event.source) {
        send({ type: "bridge:status", status: "connected" });
        event.source.postMessage({ type: "bridge:pong", id: msg.id ?? null }, HOST_ORIGIN);
      }
      break;

    default:
      console.warn("[bridge-plugin] Unknown bridge message type:", msg.type);
  }
});

// ─── UI Notification subscription ────────────────────────────────────────────

let monitorId = null;

async function subscribeToNotifications() {
  try {
    const response = await codapInterface.sendRequest({
      action: "create",
      resource: "uiNotificationMonitor",
      values: {
        clientId: PLUGIN_NAME,
      },
    });

    if (response?.success) {
      monitorId = response.values?.id ?? response.values?.monitorId ?? null;
      setStatus(`Connected (monitor id: ${monitorId})`);
      notifyHost({ type: "bridge:status", status: "connected", monitorId });
    } else {
      setStatus("Connected (no monitor — notifications unavailable)");
      notifyHost({ type: "bridge:status", status: "connected", monitorId: null });
    }
  } catch (err) {
    console.warn("[bridge-plugin] Could not subscribe to notifications:", err);
    setStatus("Connected (notifications unavailable)");
    notifyHost({ type: "bridge:status", status: "connected", monitorId: null });
  }
}

// Helper to push unsolicited events/status upward to host
function notifyHost(msg) {
  const target = window.parent?.parent ?? window.parent;
  if (target) {
    target.postMessage(msg, HOST_ORIGIN);
  }
}

// ─── Notification listener guard ─────────────────────────────────────────────

let listenerAttached = false;

function attachNotificationListener() {
  if (listenerAttached) return;
  listenerAttached = true;

  codapInterface.on("notify", "uiNotificationNotice", (notification) => {
    notifyHost({ type: "bridge:event", payload: notification.values ?? notification });
  });
}

// ─── Initialise ──────────────────────────────────────────────────────────────

async function init() {
  setStatus("Initializing…");
  notifyHost({ type: "bridge:status", status: "initializing" });

  try {
    await initializePlugin({
      pluginName: PLUGIN_NAME,
      version:    PLUGIN_VERSION,
      dimensions: DIMENSIONS,
    });
  } catch (err) {
    const msg = `initializePlugin failed: ${err}`;
    setStatus(msg);
    notifyHost({ type: "bridge:status", status: "error", error: msg });
    return;
  }

  attachNotificationListener();
  await subscribeToNotifications();

  // ✅ ADD THIS LINE — announce to host page that we're ready
    send({ type: "bridge:status", status: "connected" });
    setStatus("Connected");
}

init();
