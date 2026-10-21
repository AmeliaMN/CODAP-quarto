// codap-api-esm.js
// Wraps the CJS codap-plugin-api bundle as named ESM exports.
import api from "./codap-plugin-api.esm.js";

export const codapInterface    = api.codapInterface;
export const initializePlugin  = api.initializePlugin;
export const ClientNotification = api.ClientNotification;
