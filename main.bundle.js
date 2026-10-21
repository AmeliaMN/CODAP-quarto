var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/iframe-phone/lib/structured-clone.js
var require_structured_clone = __commonJS({
  "node_modules/iframe-phone/lib/structured-clone.js"(exports) {
    var featureSupported = {
      "structuredClones": 0
    };
    (function() {
      var result = 0;
      if (!!window.postMessage) {
        try {
          window.postMessage(document.createElement("a"), "*");
        } catch (e) {
          result = e.DATA_CLONE_ERR || e.message === "Cannot post cyclic structures." ? 1 : 0;
          featureSupported = {
            "structuredClones": result
          };
        }
      }
    })();
    exports.supported = function supported() {
      return featureSupported && featureSupported.structuredClones > 0;
    };
  }
});

// node_modules/iframe-phone/lib/parent-endpoint.js
var require_parent_endpoint = __commonJS({
  "node_modules/iframe-phone/lib/parent-endpoint.js"(exports, module) {
    var structuredClone = require_structured_clone();
    module.exports = function ParentEndpoint(targetWindowOrIframeEl, targetOrigin, afterConnectedCallback) {
      var postMessageQueue = [];
      var connected = false;
      var handlers = {};
      var targetWindowIsIframeElement;
      function getIframeOrigin(iframe) {
        return iframe.src.match(/(.*?\/\/.*?)\//)[1];
      }
      function post(type, content) {
        var message;
        if (arguments.length === 1 && typeof type === "object" && typeof type.type === "string") {
          message = type;
        } else {
          message = {
            type,
            content
          };
        }
        if (connected) {
          var tWindow = getTargetWindow();
          if (structuredClone.supported()) {
            tWindow.postMessage(message, targetOrigin);
          } else {
            tWindow.postMessage(JSON.stringify(message), targetOrigin);
          }
        } else {
          postMessageQueue.push(message);
        }
      }
      function addListener(messageName, func) {
        handlers[messageName] = func;
      }
      function removeListener(messageName) {
        delete handlers[messageName];
      }
      function removeAllListeners() {
        handlers = {};
      }
      function getTargetWindow() {
        if (targetWindowIsIframeElement) {
          var tWindow = targetWindowOrIframeEl.contentWindow;
          if (!tWindow) {
            throw "IFrame element needs to be added to DOM before communication can be started (.contentWindow is not available)";
          }
          return tWindow;
        }
        return targetWindowOrIframeEl;
      }
      function receiveMessage(message) {
        var messageData;
        if (message.source === getTargetWindow() && (targetOrigin === "*" || message.origin === targetOrigin)) {
          messageData = message.data;
          if (typeof messageData === "string") {
            try {
              messageData = JSON.parse(messageData);
            } catch (e) {
              console.warn("iframe-phone: ParentEndpoint ignoring non-JSON message:", messageData);
              return;
            }
          }
          if (handlers[messageData.type]) {
            handlers[messageData.type](messageData.content);
          } else {
            console.warn("iframe-phone: ParentEndpoint ignoring unrecognized message type:", messageData.type);
          }
        }
      }
      function disconnect() {
        connected = false;
        removeAllListeners();
        window.removeEventListener("message", receiveMessage);
      }
      try {
        targetWindowIsIframeElement = targetWindowOrIframeEl.constructor === HTMLIFrameElement;
      } catch (e) {
        targetWindowIsIframeElement = false;
      }
      if (targetWindowIsIframeElement) {
        if (!targetOrigin || targetOrigin.constructor === Function) {
          afterConnectedCallback = targetOrigin;
          targetOrigin = getIframeOrigin(targetWindowOrIframeEl);
        }
      }
      if (targetOrigin === "file://") {
        targetOrigin = "*";
      }
      addListener("hello", function() {
        connected = true;
        post({
          type: "hello",
          // `origin` property isn't used by IframeEndpoint anymore (>= 1.2.0), but it's being sent to be
          // backward compatible with old IframeEndpoint versions (< v1.2.0).
          origin: window.location.href.match(/(.*?\/\/.*?)\//)[1]
        });
        if (afterConnectedCallback && typeof afterConnectedCallback === "function") {
          afterConnectedCallback();
        }
        while (postMessageQueue.length > 0) {
          post(postMessageQueue.shift());
        }
      });
      window.addEventListener("message", receiveMessage, false);
      return {
        post,
        addListener,
        removeListener,
        removeAllListeners,
        disconnect,
        getTargetWindow,
        targetOrigin
      };
    };
  }
});

// node_modules/iframe-phone/lib/iframe-endpoint.js
var require_iframe_endpoint = __commonJS({
  "node_modules/iframe-phone/lib/iframe-endpoint.js"(exports, module) {
    var structuredClone = require_structured_clone();
    var HELLO_INTERVAL_LENGTH = 200;
    var HELLO_TIMEOUT_LENGTH = 6e4;
    function IFrameEndpoint() {
      var listeners = {};
      var isInitialized = false;
      var connected = false;
      var postMessageQueue = [];
      var helloInterval;
      function postToParent(message) {
        if (structuredClone.supported()) {
          window.parent.postMessage(message, "*");
        } else {
          window.parent.postMessage(JSON.stringify(message), "*");
        }
      }
      function post(type, content) {
        var message;
        if (arguments.length === 1 && typeof type === "object" && typeof type.type === "string") {
          message = type;
        } else {
          message = {
            type,
            content
          };
        }
        if (connected) {
          postToParent(message);
        } else {
          postMessageQueue.push(message);
        }
      }
      function postHello() {
        postToParent({
          type: "hello"
        });
      }
      function addListener(type, fn) {
        listeners[type] = fn;
      }
      function removeListener(type) {
        delete listeners[type];
      }
      function removeAllListeners() {
        listeners = {};
      }
      function getListenerNames() {
        return Object.keys(listeners);
      }
      function messageListener(message) {
        if (message.source !== window.parent) return;
        var messageData = message.data;
        if (typeof messageData === "string") {
          try {
            messageData = JSON.parse(messageData);
          } catch (e) {
            console.warn("iframe-phone: IFrameEndpoint ignoring non-JSON message:", messageData);
            return;
          }
        }
        if (!connected && messageData.type === "hello") {
          connected = true;
          stopPostingHello();
          while (postMessageQueue.length > 0) {
            post(postMessageQueue.shift());
          }
        }
        if (connected && listeners[messageData.type]) {
          listeners[messageData.type](messageData.content);
        }
      }
      function disconnect() {
        connected = false;
        stopPostingHello();
        removeAllListeners();
        window.removeEventListener("message", messageListener);
      }
      function initialize() {
        if (isInitialized) {
          return;
        }
        isInitialized = true;
        if (window.parent === window) return;
        startPostingHello();
        window.addEventListener("message", messageListener, false);
      }
      function startPostingHello() {
        if (helloInterval) {
          stopPostingHello();
        }
        helloInterval = window.setInterval(postHello, HELLO_INTERVAL_LENGTH);
        window.setTimeout(stopPostingHello, HELLO_TIMEOUT_LENGTH);
        postHello();
      }
      function stopPostingHello() {
        window.clearInterval(helloInterval);
        helloInterval = null;
      }
      return {
        initialize,
        getListenerNames,
        addListener,
        removeListener,
        removeAllListeners,
        disconnect,
        post
      };
    }
    var instance = null;
    module.exports = function getIFrameEndpoint() {
      if (!instance) {
        instance = new IFrameEndpoint();
      }
      return instance;
    };
  }
});

// node_modules/iframe-phone/lib/iframe-phone-rpc-endpoint.js
var require_iframe_phone_rpc_endpoint = __commonJS({
  "node_modules/iframe-phone/lib/iframe-phone-rpc-endpoint.js"(exports, module) {
    var ParentEndpoint = require_parent_endpoint();
    var getIFrameEndpoint = require_iframe_endpoint();
    function getPseudoUUID() {
      var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      var len = chars.length;
      var ret = [];
      for (var i = 0; i < 10; i++) {
        ret.push(chars[Math.floor(Math.random() * len)]);
      }
      return ret.join("");
    }
    module.exports = function IframePhoneRpcEndpoint(handler, namespace, targetWindow, targetOrigin, phone) {
      var pendingCallbacks = /* @__PURE__ */ Object.create({});
      if (handler && typeof handler === "object") {
        namespace = handler.namespace;
        targetWindow = handler.targetWindow;
        targetOrigin = handler.targetOrigin;
        phone = handler.phone;
        handler = handler.handler;
      }
      if (!phone) {
        if (targetWindow === window.parent) {
          phone = getIFrameEndpoint();
          phone.initialize();
        } else {
          phone = new ParentEndpoint(targetWindow, targetOrigin);
        }
      }
      phone.addListener(namespace, function(message) {
        var callbackObj;
        if (message.messageType === "call" && typeof this.handler === "function") {
          this.handler.call(void 0, message.value, function(returnValue) {
            phone.post(namespace, {
              messageType: "returnValue",
              uuid: message.uuid,
              value: returnValue
            });
          });
        } else if (message.messageType === "returnValue") {
          callbackObj = pendingCallbacks[message.uuid];
          if (callbackObj) {
            window.clearTimeout(callbackObj.timeout);
            if (callbackObj.callback) {
              callbackObj.callback.call(void 0, message.value);
            }
            pendingCallbacks[message.uuid] = null;
          }
        }
      }.bind(this));
      function call(message, callback) {
        var uuid = getPseudoUUID();
        pendingCallbacks[uuid] = {
          callback,
          timeout: window.setTimeout(function() {
            if (callback) {
              callback(void 0, new Error("IframePhone timed out waiting for reply"));
            }
          }, 2e3)
        };
        phone.post(namespace, {
          messageType: "call",
          uuid,
          value: message
        });
      }
      function disconnect() {
        phone.disconnect();
      }
      this.handler = handler;
      this.call = call.bind(this);
      this.disconnect = disconnect.bind(this);
    };
  }
});

// node_modules/iframe-phone/main.js
var require_main = __commonJS({
  "node_modules/iframe-phone/main.js"(exports, module) {
    var iframePhone = {
      /**
       * Allows communication with an iframe.
       */
      ParentEndpoint: require_parent_endpoint(),
      /**
       * Allows communication with a parent page.
       * IFrameEndpoint is a singleton, as iframe can't have multiple parents anyway.
       */
      getIFrameEndpoint: require_iframe_endpoint(),
      structuredClone: require_structured_clone(),
      IframePhoneRpcEndpoint: require_iframe_phone_rpc_endpoint()
    };
    module.exports = iframePhone;
  }
});

// codap-plugin-api.js
var require_codap_plugin_api = __commonJS({
  "codap-plugin-api.js"(exports) {
    "use strict";
    var iframePhone = require_main();
    var connection = null;
    var connectionState = "preinit";
    var kDefaultRequestTimeout = 6e4;
    var kMaxRequestTimeout = 2 ** 31 - 1;
    var kMaxDescribedMessage = 500;
    var requestTimeout = kDefaultRequestTimeout;
    var stats = {
      /**
       * How many requests the caller issued.
       *
       * Counted when `sendRequest` is called, not when the request reaches CODAP, so a request refused
       * before it could be sent — no connection, or a closed one — is included. That is what makes the
       * arithmetic on `countDiReqFailed` below hold; counting only the ones that got as far as CODAP
       * left the refusals incrementing a failure count against a total that had not moved.
       */
      countDiReq: 0,
      /** How many requests CODAP answered with `{success: true}`. */
      countDiRplSuccess: 0,
      /**
       * How many requests CODAP answered with `{success: false}` — that is, answered and declined.
       * These are outcomes, not failures: the request's promise resolves with the response. For
       * requests that failed, see `countDiReqFailed`.
       */
      countDiRplFail: 0,
      /**
       * How many requests failed, and so rejected: no connection to send on, no answer within the
       * deadline, an answer carrying no result, the send itself throwing, or — for `init()`'s handshake
       * alone — nothing answering within iframe-phone's advisory window.
       *
       * `countDiReq - countDiRplSuccess - countDiRplFail - countDiReqFailed` is the number still in
       * flight. `countDiReqDeadlineExceeded` counts the subset that ran out of time.
       */
      countDiReqFailed: 0,
      /**
       * How many times iframe-phone's advisory 2s timer has reported that no reply has arrived yet.
       *
       * This counts probes, not failures. A request slower than 2s that goes on to succeed normally
       * increments it, so on a plugin doing bulk work a high count is expected and says nothing is
       * wrong. For requests that actually ran out of time, see `countDiReqDeadlineExceeded`.
       */
      countDiRplTimeout: 0,
      /**
       * How many requests were rejected for exceeding their deadline. See `setRequestTimeout`. A subset
       * of `countDiReqFailed`.
       */
      countDiReqDeadlineExceeded: 0,
      countCodapReq: 0,
      countCodapUnhandledReq: 0,
      countCodapRplSuccess: 0,
      countCodapRplFail: 0,
      timeDiFirstReq: null,
      timeDiLastReq: null,
      timeCodapFirstReq: null,
      timeCodapLastReq: null
    };
    var config = null;
    var interactiveState = {};
    var notificationSubscribers = [];
    var interactiveStateHandlerRegistered = false;
    function matchResource(resourceName, resourceSpec) {
      return resourceSpec === "*" || resourceName === resourceSpec;
    }
    function notificationHandler(request, callback) {
      const action = request.action;
      const resource = request.resource;
      let requestValues = request.values;
      let returnMessage = { success: true };
      markConnectionActive();
      stats.countCodapReq += 1;
      stats.timeCodapLastReq = /* @__PURE__ */ new Date();
      if (!stats.timeCodapFirstReq) {
        stats.timeCodapFirstReq = stats.timeCodapLastReq;
      }
      if (action === "notify" && !Array.isArray(requestValues)) {
        requestValues = [requestValues];
      }
      let handled = false;
      let success = true;
      if (action === "get" || action === "update") {
        notificationSubscribers.some(function(subscription) {
          let result = false;
          try {
            if (subscription.actionSpec === action && matchResource(resource, subscription.resourceSpec)) {
              const rtn = subscription.handler(request);
              if (rtn === null || rtn === void 0 ? void 0 : rtn.success) {
                stats.countCodapRplSuccess++;
              } else {
                stats.countCodapRplFail++;
              }
              returnMessage = rtn;
              result = true;
            }
          } catch (ex) {
            result = true;
          }
          return result;
        });
        if (!handled) {
          stats.countCodapUnhandledReq++;
        }
      } else if (action === "notify") {
        requestValues.forEach(function(value) {
          notificationSubscribers.forEach(function(subscription) {
            handled = false;
            if (subscription.actionSpec === action && matchResource(resource, subscription.resourceSpec) && (!subscription.operation || subscription.operation === value.operation && subscription.handler)) {
              const rtn = subscription.handler({ action, resource, values: value });
              if (rtn === null || rtn === void 0 ? void 0 : rtn.success) {
                stats.countCodapRplSuccess++;
              } else {
                stats.countCodapRplFail++;
              }
              success = success && (rtn ? rtn.success : false);
              handled = true;
            }
          });
          if (!handled) {
            stats.countCodapUnhandledReq++;
          }
        });
      } else ;
      return callback(returnMessage);
    }
    function reportCallbackError(error) {
      queueMicrotask(() => {
        throw error;
      });
    }
    function describeMessage(message) {
      var _a;
      let described;
      try {
        described = (_a = JSON.stringify(message)) !== null && _a !== void 0 ? _a : String(message);
      } catch (_b) {
        return "[message could not be serialized]";
      }
      return described.length > kMaxDescribedMessage ? described.slice(0, kMaxDescribedMessage) + "\u2026 (truncated)" : described;
    }
    function afterHandshake(step, state) {
      if (!step) {
        return;
      }
      try {
        const result = step(state);
        if (result && typeof result.then === "function") {
          result.then(void 0, reportCallbackError);
        }
      } catch (error) {
        reportCallbackError(error);
      }
    }
    function markConnectionActive() {
      if (connection) {
        connectionState = "active";
      }
    }
    function issueRequest(message, options = {}) {
      const { callback, onSilence } = options;
      return new Promise(function(resolve, reject) {
        let isSettled = false;
        let timeoutTimer;
        function settle(settleFn, value, callbackResponse) {
          if (isSettled) {
            return;
          }
          isSettled = true;
          if (timeoutTimer !== void 0) {
            clearTimeout(timeoutTimer);
          }
          settleFn(value);
          if (callback) {
            try {
              const notify = callback;
              const callbackResult = notify(callbackResponse, message);
              if (callbackResult && typeof callbackResult.then === "function") {
                callbackResult.then(void 0, reportCallbackError);
              }
            } catch (error) {
              reportCallbackError(error);
            }
          }
        }
        function settleSuccess(response) {
          settle(resolve, response, response);
        }
        function settleFailure(reason) {
          if (!isSettled) {
            stats.countDiReqFailed++;
          }
          settle(reject, reason instanceof Error ? reason : new Error(String(reason)));
        }
        function handleResponse(response, noReplyYet) {
          if (!noReplyYet) {
            markConnectionActive();
          }
          if (isSettled) {
            return;
          }
          if (response === void 0 || response === null) {
            if (noReplyYet) {
              stats.countDiRplTimeout++;
              if (onSilence) {
                try {
                  onSilence();
                } catch (error) {
                  reportCallbackError(error);
                }
                settleFailure("handleResponse: CODAP request timed out: " + describeMessage(message));
              }
              return;
            }
            settleFailure("handleResponse: CODAP answered with no result: " + describeMessage(message));
            return;
          }
          const succeeded = Array.isArray(response) ? response.length > 0 && response.every((result) => result === null || result === void 0 ? void 0 : result.success) : response.success;
          if (succeeded) {
            stats.countDiRplSuccess++;
          } else {
            stats.countDiRplFail++;
          }
          settleSuccess(response);
        }
        stats.countDiReq++;
        stats.timeDiLastReq = /* @__PURE__ */ new Date();
        if (!stats.timeDiFirstReq) {
          stats.timeDiFirstReq = stats.timeDiLastReq;
        }
        switch (connectionState) {
          case "closed":
            settleFailure("sendRequest on closed CODAP connection: " + describeMessage(message));
            break;
          case "preinit":
          // warn, but issue request.
          // console.log('sendRequest on not yet initialized CODAP connection: ' +
          // JSON.stringify(message));
          /* falls through */
          default:
            if (connection) {
              try {
                connection.call(message, handleResponse);
                const timeout = requestTimeout;
                if (!isSettled) {
                  timeoutTimer = setTimeout(function() {
                    if (isSettled) {
                      return;
                    }
                    stats.countDiReqDeadlineExceeded++;
                    settleFailure("sendRequest: CODAP request exceeded " + timeout + "ms: " + describeMessage(message));
                  }, timeout);
                }
              } catch (error) {
                settleFailure(error);
              }
            } else {
              settleFailure("sendRequest on non-existent CODAP connection: " + describeMessage(message));
            }
        }
      });
    }
    var codapInterface2 = {
      /**
       * Connection statistics
       */
      stats,
      /**
       * Initialize connection.
       *
       * Start connection. Request interactiveFrame to get prior state, if any.
       * Update interactive frame to set name and dimensions and other configuration
       * information.
       *
       * Resolves with the interactive state CODAP had saved for this plugin, or rejects with an `Error`
       * if the handshake does not succeed. The callback is invoked either way, as `sendRequest`'s is:
       * with the saved state on success, and with `undefined` on failure.
       *
       * **When nothing answers the handshake the connection is marked closed**, so requests issued
       * afterwards are refused at once rather than each waiting out `getRequestTimeout()`. The trigger is
       * iframe-phone's own 2 second advisory window, which is not proof that CODAP is absent: a CODAP
       * that is alive but slow to complete the underlying "hello" exchange looks the same from here.
       * That guess is not final, though — if CODAP answers after all, the connection reopens by itself
       * and requests resume.
       *
       * The reopen recovers the connection, not the handshake: this promise stays rejected, and the saved
       * state that late reply carried is **not** delivered, so `getInteractiveState()` is still empty. A
       * plugin that restores state should call `init()` again rather than rely on the reopen — otherwise
       * it will answer CODAP's next request for its state with nothing, overwriting what was stored.
       *
       * Any other failure leaves the connection usable and fails only the handshake, since none of them
       * says anything about whether CODAP is there: CODAP answering and declining, CODAP answering with
       * no value, and the request failing to send are all in this group. So is a handshake that goes
       * silent after CODAP has already answered something else.
       *
       * @param iConfig {object} Configuration. Optional properties: title {string},
       *                        version {string}, dimensions {object}
       *
       * @param iCallback {function(interactiveState)} Optional. Receives the saved state, or `undefined`
       *                        if the handshake failed.
       * @return {Promise} Promise of interactiveState;
       */
      init(iConfig, iCallback) {
        const this_ = this;
        return new Promise(function(resolve, reject) {
          function rejectHandshake(reason) {
            reject(reason instanceof Error ? reason : new Error(String(reason)));
            afterHandshake(iCallback, void 0);
          }
          function closeSilentConnection() {
            if (connection === endpoint && connectionState !== "active") {
              connectionState = "closed";
            }
          }
          function getFrameRespHandler(resp) {
            const success = resp && resp[1] && resp[1].success;
            const receivedFrame = success && resp[1].values;
            const savedState = receivedFrame && receivedFrame.savedState;
            if (!connection) {
              rejectHandshake("init: the connection was destroyed before the handshake completed");
              return;
            }
            if (success) {
              resolve(savedState);
              afterHandshake((state) => this_.updateInteractiveState(state), savedState);
              afterHandshake(iConfig.stateHandler, savedState);
              afterHandshake(iCallback, savedState);
            } else {
              rejectHandshake(resp[1] && resp[1].values && resp[1].values.error || "unknown failure");
            }
          }
          const getFrameReq = { action: "get", resource: "interactiveFrame" };
          const newFrame = {
            name: iConfig.name,
            title: iConfig.title,
            version: iConfig.version,
            dimensions: iConfig.dimensions,
            preventBringToFront: iConfig.preventBringToFront,
            preventDataContextReorg: iConfig.preventDataContextReorg
          };
          const updateFrameReq = {
            action: "update",
            resource: "interactiveFrame",
            values: newFrame
          };
          config = iConfig;
          const endpoint = new iframePhone.IframePhoneRpcEndpoint(notificationHandler, "data-interactive", window.parent);
          connection = endpoint;
          connectionState = "preinit";
          if (!config.customInteractiveStateHandler && !interactiveStateHandlerRegistered) {
            this_.on("get", "interactiveState", function() {
              return { success: true, values: this_.getInteractiveState() };
            }.bind(this_));
            interactiveStateHandlerRegistered = true;
          }
          return issueRequest([updateFrameReq, getFrameReq], { onSilence: closeSilentConnection }).then(getFrameRespHandler, rejectHandshake);
        }.bind(this));
      },
      /**
       * Current known state of the connection. One of three values:
       *
       * - `"preinit"` — no handshake has completed yet, either before the first `init()` or during one.
       * - `"active"` — CODAP has been heard from: it answered a request, or sent a notification.
       * - `"closed"` — requests are refused without being sent. Two causes, which behave differently:
       *   `destroy()`, which is final until `init()` is called again; and a handshake that nothing
       *   answered, which reverts to `"active"` by itself if CODAP answers after all.
       *
       * This is the only way to observe either of those, since neither raises an event.
       *
       * @returns {'preinit' | 'active' | 'closed'}
       */
      getConnectionState() {
        return connectionState;
      },
      /**
       * How long, in milliseconds, a request waits for a CODAP response before it is rejected.
       * Defaults to 60000. Raise it for plugins that issue requests over very large datasets; lower it
       * if a caller needs to fail fast.
       *
       * This is deliberately much longer than the 2s timer inside iframe-phone, which reports that no
       * reply has arrived yet without cancelling the request — a large request routinely takes longer
       * than that and still succeeds.
       */
      getRequestTimeout() {
        return requestTimeout;
      },
      /**
       * Sets how long, in milliseconds, a request waits for a CODAP response before it is rejected.
       * Applies to requests issued after the call; requests already in flight keep the value they
       * were given.
       *
       * A non-finite or non-positive value falls back to the default of 60000, and larger values are
       * clamped: setTimeout treats NaN and negative delays as 0 and overflows above its 32-bit
       * ceiling, either of which would silently make every subsequent request fail at once.
       */
      setRequestTimeout(timeout) {
        requestTimeout = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, kMaxRequestTimeout) : kDefaultRequestTimeout;
      },
      getStats() {
        return stats;
      },
      getConfig() {
        return config;
      },
      /**
       * Returns the interactive state.
       *
       * @returns {object}
       */
      getInteractiveState() {
        return interactiveState;
      },
      /**
       * Updates the interactive state.
       * @param iInteractiveState {Object}
       */
      updateInteractiveState(iInteractiveState) {
        if (!iInteractiveState) {
          return;
        }
        interactiveState = Object.assign(interactiveState, iInteractiveState);
      },
      /**
       * Tears down the connection to CODAP. Requests issued afterwards are refused rather than sent;
       * `init()` can be called again to reconnect.
       */
      destroy() {
        connection = null;
        connectionState = "closed";
      },
      /**
       * Sends a request to CODAP. The format of the message is as defined in
       * {@link https://github.com/concord-consortium/codap/wiki/CODAP-Data-Interactive-API}.
       *
       * A request waits up to `getRequestTimeout()` milliseconds (60 seconds by default) for CODAP to
       * answer. It settles exactly once, and both the promise and the callback report every outcome:
       *
       * - **CODAP answered:** the promise resolves with the response and the callback receives it. That
       *   includes `{success: false}`, which means CODAP answered and declined — a resolved promise, not
       *   a rejected one.
       * - **The request failed:** the promise rejects with an `Error` and the callback is invoked with
       *   `undefined`. Every way a request can fail reports this way — exceeding the deadline, there
       *   being no connection to send on (before `initializePlugin()` or after `destroy()`), CODAP
       *   answering with no value at all, and the send itself throwing.
       *
       * The callback is invoked exactly once, synchronously after the promise is resolved or rejected —
       * that is, before any `.then` or `await` continuation runs, since those are microtasks. A callback
       * written as `result.success` therefore has to handle the `undefined` it receives on failure. Note that the
       * promise rejects whether or not a callback is passed, so it still needs a `.catch` to avoid an
       * unhandled rejection. An exception thrown by the callback itself is rethrown as an uncaught error
       * rather than failing the request, which has already settled by then.
       *
       * @param message {Object} The request, as in the Data Interactive API.
       * @param callback {RequestCallback} Optional. Receives the response, or `undefined` if the request
       *    failed, followed by the original request. Its parameter has to admit `undefined`: a callback
       *    typed for the response alone does not compile, because it is the one that throws when a
       *    request fails.
       *
       * @return {Promise} The promise of the response from CODAP.
       */
      sendRequest(message, callback) {
        return issueRequest(message, { callback });
      },
      /**
       * Registers a handler to respond to CODAP-initiated requests and
       * notifications. See {@link https://github.com/concord-consortium/codap/wiki/CODAP-Data-Interactive-API#codap-initiated-actions}
       *
       * @param actionSpec {'get' || 'notify'} (optional) Action to handle. Defaults to 'notify'.
       * @param resourceSpec {String} A resource string.
       * @param operation {String} (optional) name of operation, e.g. 'create', 'delete',
       *   'move', 'resize', .... If not specified, all operations will be reported.
       * @param handler {Function} A handler to receive the notifications.
       */
      on(actionSpec, resourceSpec, operation, handler) {
        let as = "notify", rs, os, hn;
        const args = Array.prototype.slice.call(arguments);
        if (["get", "update", "notify"].indexOf(args[0]) >= 0) {
          as = args.shift();
        }
        rs = args.shift();
        if (typeof args[0] !== "function") {
          os = args.shift();
        }
        hn = args.shift();
        const subscriber = {
          actionSpec: as,
          resourceSpec: rs,
          operation: os,
          handler: hn
        };
        notificationSubscribers.push(subscriber);
      },
      /**
       * Parses a resource selector returning a hash of named resource names to
       * resource values. The last clause is identified as the resource type.
       * E.g. converts 'dataContext[abc].collection[def].case'
       * to {dataContext: 'abc', collection: 'def', type: 'case'}
       *
       * @param {String} iResource
       * @return {Object}
       */
      parseResourceSelector(iResource) {
        const selectorRE = /([A-Za-z0-9_-]+)\[([^\]]+)]/;
        const result = {};
        const selectors = iResource.split(".");
        selectors.forEach(function(selector) {
          let resourceType, resourceName;
          const match = selectorRE.exec(selector);
          if (selectorRE.test(selector) && match) {
            resourceType = match[1];
            resourceName = match[2];
            result[resourceType] = resourceName;
            result.type = resourceType;
          } else {
            result.type = selector;
          }
        });
        return result;
      }
    };
    var ctxStr = (contextName) => `dataContext[${contextName}]`;
    var collStr = (collectionName) => `collection[${collectionName}]`;
    var createMessage = (action, resource, values) => {
      return {
        action,
        resource,
        values
      };
    };
    var sendMessage = async (action, resource, values) => {
      const message = createMessage(action, resource, values);
      return await codapInterface2.sendRequest(message);
    };
    var reportRequestFailure = (what, error) => {
      console.warn(what, error !== null && error !== void 0 ? error : "");
    };
    var initializePlugin2 = async (options) => {
      const { pluginName, version, dimensions } = options;
      const interfaceConfig = {
        name: pluginName,
        version,
        dimensions
      };
      return await codapInterface2.init(interfaceConfig);
    };
    var createTable = async (dataContext, datasetName) => {
      const values = {
        type: "caseTable",
        dataContext
      };
      if (datasetName) {
        values.name = datasetName;
      }
      return sendMessage("create", "component", values);
    };
    var selectSelf = () => {
      const selectComponent = async function(id) {
        return codapInterface2.sendRequest({
          action: "notify",
          resource: `component[${id}]`,
          values: { request: "select" }
        }, (result) => {
          if (result && !result.success) {
            reportRequestFailure("selectSelf: CODAP declined to select the component");
          }
        }).catch((error) => reportRequestFailure("selectSelf: the select request failed", error));
      };
      codapInterface2.sendRequest({ action: "get", resource: "interactiveFrame" }, (result) => {
        var _a;
        if (!result) {
          return;
        }
        if (!result.success) {
          reportRequestFailure("selectSelf: CODAP declined the interactiveFrame lookup");
          return;
        }
        if (((_a = result.values) === null || _a === void 0 ? void 0 : _a.id) === void 0) {
          reportRequestFailure("selectSelf: the interactiveFrame reply carried no id");
          return;
        }
        return selectComponent(result.values.id);
      }).catch((error) => reportRequestFailure("selectSelf: the interactiveFrame lookup failed", error));
    };
    var addComponentListener = (callback) => {
      codapInterface2.on("notify", "component", callback);
    };
    var getListOfDataContexts = () => {
      return sendMessage("get", "dataContextList");
    };
    var getDataContext = (dataContextName) => {
      return sendMessage("get", ctxStr(dataContextName));
    };
    var createDataContext = (dataContextName) => {
      return sendMessage("create", "dataContext", { name: dataContextName });
    };
    var createDataContextFromURL = (url) => {
      return sendMessage("create", "dataContextFromURL", { "URL": url });
    };
    var addDataContextsListListener = (callback) => {
      codapInterface2.on("notify", "documentChangeNotice", callback);
    };
    var addDataContextChangeListener = (dataContextName, callback) => {
      codapInterface2.on("notify", `dataContextChangeNotice[${dataContextName}]`, callback);
    };
    var getCollectionList = (dataContextName) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.collectionList`);
    };
    var getCollection = (dataContextName, collectionName) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.${collStr(collectionName)}`);
    };
    var createParentCollection = (dataContextName, collectionName, attrs) => {
      const resource = `${ctxStr(dataContextName)}.collection`;
      const values = {
        "name": collectionName,
        "title": collectionName,
        "parent": "_root_"
      };
      if (attrs) {
        values.attrs = attrs;
      }
      return sendMessage("create", resource, values);
    };
    var createChildCollection = (dataContextName, collectionName, parentCollectionName, attrs) => {
      const resource = `${ctxStr(dataContextName)}.collection`;
      const values = {
        "name": collectionName,
        "title": collectionName,
        "parent": parentCollectionName
      };
      if (attrs) {
        values.attrs = attrs;
      }
      return sendMessage("create", resource, values);
    };
    var createNewCollection = (dataContextName, collectionName, attrs) => {
      const resource = `${ctxStr(dataContextName)}.collection`;
      const values = {
        "name": collectionName,
        "title": collectionName
      };
      if (attrs) {
        values.attrs = attrs;
      }
      return sendMessage("create", resource, values);
    };
    var ensureUniqueCollectionName = async (dataContextName, collectionName, index) => {
      index = index || 0;
      if (index > 100) {
        return void 0;
      }
      const uniqueName = `${collectionName}${index !== 0 ? index : ""}`;
      const getCollMessage = {
        "action": "get",
        "resource": `${ctxStr(dataContextName)}.collection[${uniqueName}]`
      };
      const result = await codapInterface2.sendRequest(getCollMessage);
      if (result.success) {
        return ensureUniqueCollectionName(dataContextName, collectionName, index + 1);
      } else {
        return uniqueName;
      }
    };
    var getAttribute = (dataContextName, collectionName, attributeName) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attribute[${attributeName}]`;
      return sendMessage("get", resource);
    };
    var getAttributeList = (dataContextName, collectionName) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attributeList`;
      return sendMessage("get", resource);
    };
    var createNewAttribute = (dataContextName, collectionName, attributeName) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attribute`;
      const values = {
        "name": attributeName,
        "title": attributeName
      };
      return sendMessage("create", resource, values);
    };
    var updateAttribute = (dataContextName, collectionName, attributeName, attribute, values) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attribute[${attributeName}]`;
      return sendMessage("update", resource, values);
    };
    var updateAttributePosition = (dataContextName, collectionName, attrName, newPosition) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attributeLocation[${attrName}]`;
      return sendMessage("update", resource, {
        "collection": collectionName,
        "position": newPosition
      });
    };
    var createCollectionFromAttribute = async (dataContextName, oldCollectionName, attr, parent) => {
      var _a, _b;
      const getCollectionMessage = createMessage("get", `${ctxStr(dataContextName)}.${collStr(attr.name)}`);
      const existingCollection = await codapInterface2.sendRequest(getCollectionMessage);
      const moveCollection = existingCollection.success && (((_b = (_a = existingCollection.values) === null || _a === void 0 ? void 0 : _a.attrs) === null || _b === void 0 ? void 0 : _b.length) === 1 || attr.name === oldCollectionName);
      const newCollectionName = moveCollection ? await ensureUniqueCollectionName(dataContextName, attr.name, 0) : attr.name;
      if (newCollectionName === void 0) {
        return {
          success: false,
          values: { error: `createCollectionFromAttribute: no unused collection name based on "${attr.name}"` }
        };
      }
      const _parent = parent === "root" ? "_root_" : parent;
      const createCollectionRequest = createMessage("create", `${ctxStr(dataContextName)}.collection`, {
        "name": newCollectionName,
        "title": newCollectionName,
        parent: _parent
      });
      const createCollectionResult = await codapInterface2.sendRequest(createCollectionRequest);
      if (!createCollectionResult.success) {
        return createCollectionResult;
      }
      const moveAttributeRequest = createMessage("update", `${ctxStr(dataContextName)}.${collStr(oldCollectionName)}.attributeLocation[${attr.name}]`, {
        "collection": newCollectionName,
        "position": 0
      });
      return await codapInterface2.sendRequest(moveAttributeRequest);
    };
    var getCaseCount = (dataContextName, collectionName) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseCount`;
      return sendMessage("get", resource);
    };
    var getCaseByIndex = (dataContextName, collectionName, index) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseByIndex[${index}]`;
      return sendMessage("get", resource);
    };
    var getCaseByID = (dataContextName, caseID) => {
      const resource = `${ctxStr(dataContextName)}.caseByID[${caseID}]`;
      return sendMessage("get", resource);
    };
    var getCaseBySearch = (dataContextName, collectionName, search) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseSearch[${search}]`;
      return sendMessage("get", resource);
    };
    var getCaseByFormulaSearch = (dataContextName, collectionName, search) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseFormulaSearch[${search}]`;
      return sendMessage("get", resource);
    };
    var createSingleOrParentCase = (dataContextName, collectionName, values) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.case`;
      return sendMessage("create", resource, values);
    };
    var createChildCase = (dataContextName, collectionName, parentCaseID, values) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.case`;
      const valuesWithParent = [
        {
          parent: parentCaseID,
          values
        }
      ];
      return sendMessage("create", resource, valuesWithParent);
    };
    var updateCaseById = (dataContextName, caseID, values) => {
      const resource = `${ctxStr(dataContextName)}.caseByID[${caseID}]`;
      const updateValues = {
        values
      };
      return sendMessage("update", resource, updateValues);
    };
    var updateCases = (dataContextName, collectionName, values) => {
      const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.case`;
      return sendMessage("update", resource, values);
    };
    var getSelectionList = (dataContextName) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.selectionList`);
    };
    var selectCases = (dataContextName, caseIds) => {
      return sendMessage("create", `${ctxStr(dataContextName)}.selectionList`, caseIds);
    };
    var addCasesToSelection = (dataContextName, caseIds) => {
      return sendMessage("update", `${ctxStr(dataContextName)}.selectionList`, caseIds);
    };
    var getItemCount = (dataContextName) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.itemCount`);
    };
    var getAllItems = (dataContextName) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.itemSearch[*]`);
    };
    var getItemByID = (dataContextName, itemID) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.itemByID[${itemID}]`);
    };
    var getItemByIndex = (dataContextName, index) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.item[${index}]`);
    };
    var getItemByCaseID = (dataContextName, caseID) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.itemByCaseID[${caseID}]`);
    };
    var getItemBySearch = (dataContextName, search) => {
      return sendMessage("get", `${ctxStr(dataContextName)}.itemSearch[${search}]`);
    };
    var createItems = (dataContextName, items) => {
      return sendMessage("create", `${ctxStr(dataContextName)}.item`, items);
    };
    var updateItemByID = (dataContextName, itemID, values) => {
      return sendMessage("update", `${ctxStr(dataContextName)}.itemByID[${itemID}]`, values);
    };
    var updateItemByIndex = (dataContextName, index, values) => {
      return sendMessage("update", `${ctxStr(dataContextName)}.item[${index}]`, values);
    };
    var updateItemByCaseID = (dataContextName, caseID, values) => {
      return sendMessage("update", `${ctxStr(dataContextName)}.itemByCaseID[${caseID}]`, values);
    };
    exports.addCasesToSelection = addCasesToSelection;
    exports.addComponentListener = addComponentListener;
    exports.addDataContextChangeListener = addDataContextChangeListener;
    exports.addDataContextsListListener = addDataContextsListListener;
    exports.codapInterface = codapInterface2;
    exports.createChildCase = createChildCase;
    exports.createChildCollection = createChildCollection;
    exports.createCollectionFromAttribute = createCollectionFromAttribute;
    exports.createDataContext = createDataContext;
    exports.createDataContextFromURL = createDataContextFromURL;
    exports.createItems = createItems;
    exports.createNewAttribute = createNewAttribute;
    exports.createNewCollection = createNewCollection;
    exports.createParentCollection = createParentCollection;
    exports.createSingleOrParentCase = createSingleOrParentCase;
    exports.createTable = createTable;
    exports.ensureUniqueCollectionName = ensureUniqueCollectionName;
    exports.getAllItems = getAllItems;
    exports.getAttribute = getAttribute;
    exports.getAttributeList = getAttributeList;
    exports.getCaseByFormulaSearch = getCaseByFormulaSearch;
    exports.getCaseByID = getCaseByID;
    exports.getCaseByIndex = getCaseByIndex;
    exports.getCaseBySearch = getCaseBySearch;
    exports.getCaseCount = getCaseCount;
    exports.getCollection = getCollection;
    exports.getCollectionList = getCollectionList;
    exports.getDataContext = getDataContext;
    exports.getItemByCaseID = getItemByCaseID;
    exports.getItemByID = getItemByID;
    exports.getItemByIndex = getItemByIndex;
    exports.getItemBySearch = getItemBySearch;
    exports.getItemCount = getItemCount;
    exports.getListOfDataContexts = getListOfDataContexts;
    exports.getSelectionList = getSelectionList;
    exports.initializePlugin = initializePlugin2;
    exports.selectCases = selectCases;
    exports.selectSelf = selectSelf;
    exports.sendMessage = sendMessage;
    exports.updateAttribute = updateAttribute;
    exports.updateAttributePosition = updateAttributePosition;
    exports.updateCaseById = updateCaseById;
    exports.updateCases = updateCases;
    exports.updateItemByCaseID = updateItemByCaseID;
    exports.updateItemByID = updateItemByID;
    exports.updateItemByIndex = updateItemByIndex;
  }
});

// main.js
var import_codap_plugin_api = __toESM(require_codap_plugin_api());
var PLUGIN_NAME = "quarto-bridge";
var PLUGIN_VERSION = "0.1.0";
var DIMENSIONS = { width: 300, height: 60 };
var HOST_ORIGIN = "*";
var statusEl = document.getElementById("status");
function setStatus(msg) {
  console.log(`[bridge-plugin] ${msg}`);
  if (statusEl) statusEl.textContent = msg;
}
async function dispatchGet(id, resource, sourceWindow) {
  try {
    const result = await import_codap_plugin_api.codapInterface.sendRequest({
      action: "get",
      resource
    });
    if (sourceWindow) {
      sourceWindow.postMessage({ type: "bridge:reply", id, success: true, result }, HOST_ORIGIN);
    }
  } catch (err) {
    if (sourceWindow) {
      sourceWindow.postMessage({ type: "bridge:reply", id, success: false, error: String(err) }, HOST_ORIGIN);
    }
  }
}
window.addEventListener("message", (event) => {
  const msg = event.data;
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
      if (event.source) {
        send({ type: "bridge:status", status: "connected" });
        event.source.postMessage({ type: "bridge:pong", id: msg.id ?? null }, HOST_ORIGIN);
      }
      break;
    default:
      console.warn("[bridge-plugin] Unknown bridge message type:", msg.type);
  }
});
var monitorId = null;
async function subscribeToNotifications() {
  try {
    const response = await import_codap_plugin_api.codapInterface.sendRequest({
      action: "create",
      resource: "uiNotificationMonitor",
      values: {
        clientId: PLUGIN_NAME
      }
    });
    if (response?.success) {
      monitorId = response.values?.id ?? response.values?.monitorId ?? null;
      setStatus(`Connected (monitor id: ${monitorId})`);
      notifyHost({ type: "bridge:status", status: "connected", monitorId });
    } else {
      setStatus("Connected (no monitor \u2014 notifications unavailable)");
      notifyHost({ type: "bridge:status", status: "connected", monitorId: null });
    }
  } catch (err) {
    console.warn("[bridge-plugin] Could not subscribe to notifications:", err);
    setStatus("Connected (notifications unavailable)");
    notifyHost({ type: "bridge:status", status: "connected", monitorId: null });
  }
}
function notifyHost(msg) {
  const target = window.parent?.parent ?? window.parent;
  if (target) {
    target.postMessage(msg, HOST_ORIGIN);
  }
}
var listenerAttached = false;
function attachNotificationListener() {
  if (listenerAttached) return;
  listenerAttached = true;
  import_codap_plugin_api.codapInterface.on("notify", "uiNotificationNotice", (notification) => {
    notifyHost({ type: "bridge:event", payload: notification.values ?? notification });
  });
}
async function init() {
  setStatus("Initializing\u2026");
  notifyHost({ type: "bridge:status", status: "initializing" });
  try {
    await (0, import_codap_plugin_api.initializePlugin)({
      pluginName: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      dimensions: DIMENSIONS
    });
  } catch (err) {
    const msg = `initializePlugin failed: ${err}`;
    setStatus(msg);
    notifyHost({ type: "bridge:status", status: "error", error: msg });
    return;
  }
  attachNotificationListener();
  await subscribeToNotifications();
  send({ type: "bridge:status", status: "connected" });
  setStatus("Connected");
}
init();
