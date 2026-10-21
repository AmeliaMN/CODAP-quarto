// bridge-plugin/codap-plugin-bridge.js
// Runs inside the CODAP iframe as part of the hidden plugin.
// Relays messages between the host Quarto page (via BroadcastChannel)
// and CODAP (via @concord-consortium/codap-plugin-api).

import {
  codapInterface,
  initializePlugin,
} from "./codap-api-esm.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const CHANNEL_NAME    = "codap-quarto-bridge";
const PLUGIN_NAME     = "quarto-bridge";
const PLUGIN_VERSION  = "0.1.0";
const DIMENSIONS      = { width: 280, height: 60 };

// ─── State & BroadcastChannel ─────────────────────────────────────────────────

const channel = new BroadcastChannel(CHANNEL_NAME);
let monitorId = null;
let listenerAttached = false;

/**
 * Send a message across BroadcastChannel to the host Quarto document.
 * @param {object} msg
 */
function send(msg) {
  channel.postMessage(msg);
}

// ─── Request Handlers ─────────────────────────────────────────────────────────

/**
 * Execute a CODAP 'get' action and return a structured reply.
 *
 * @param {string} id - Request correlation ID from host
 * @param {string} resource - Target CODAP resource selector
 */
async function handleGet(id, resource) {
  try {
    const response = await codapInterface.sendRequest({
      action: "get",
      resource,
    });

    if (response && response.success === false) {
      send({
        type: "bridge:reply",
        id,
        success: false,
        result: {
          error: response.error || response.values?.error || "CODAP get request failed",
          raw: response,
        },
      });
      return;
    }

    send({
      type: "bridge:reply",
      id,
      success: true,
      result: response?.values ?? response,
    });
  } catch (err) {
    send({
      type: "bridge:reply",
      id,
      success: false,
      result: {
        error: String(err),
      },
    });
  }
}

// ─── Channel Listener ─────────────────────────────────────────────────────────

channel.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "bridge:ping":
      send({
        type: "bridge:pong",
        id: msg.id ?? null,
      });
      break;

    case "bridge:get":
      if (!msg.id || !msg.resource) {
        console.warn("[codap-plugin-bridge] Invalid bridge:get payload:", msg);
        send({
          type: "bridge:reply",
          id: msg.id ?? "unknown",
          success: false,
          result: { error: "Missing required 'id' or 'resource' in bridge:get message" },
        });
        return;
      }
      handleGet(msg.id, msg.resource);
      break;

    default:
      // Unknown or unhandled message type
      break;
  }
};

// ─── UI Notification Layer ────────────────────────────────────────────────────

/**
 * Attach the CODAP notification handler once (guarded against strict mode / HMR).
 */
function attachNotificationListener() {
  if (listenerAttached) return;
  listenerAttached = true;

  codapInterface.on("notify", "uiNotificationNotice", (notification) => {
    send({
      type: "bridge:event",
      payload: notification.values ?? notification,
    });
  });
}

/**
 * Subscribe to all CODAP UI notifications via uiNotificationMonitor.
 */
async function subscribeNotifications() {
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
      console.log(`[codap-plugin-bridge] Subscribed to uiNotificationMonitor (id: ${monitorId})`);
    } else {
      console.warn("[codap-plugin-bridge] uiNotificationMonitor create returned false", response);
    }
  } catch (err) {
    console.warn("[codap-plugin-bridge] Could not create uiNotificationMonitor:", err);
  }
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the CODAP plugin handshake and open communications.
 */
export async function startPluginBridge() {
  send({ type: "bridge:status", status: "initializing" });

  try {
    await initializePlugin({
      pluginName: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      dimensions: DIMENSIONS,
    });

    attachNotificationListener();
    await subscribeNotifications();

    send({
      type: "bridge:status",
      status: "connected",
      monitorId,
    });
    console.log("[codap-plugin-bridge] Plugin bridge initialized and connected");
  } catch (err) {
    const errMsg = `Plugin initialization failed: ${err}`;
    console.error("[codap-plugin-bridge]", errMsg);
    send({
      type: "bridge:status",
      status: "error",
      error: errMsg,
    });
  }
}

// Auto-start when script loads
startPluginBridge();
