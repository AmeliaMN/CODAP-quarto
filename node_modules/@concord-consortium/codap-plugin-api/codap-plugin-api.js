'use strict';

var iframePhone = require('iframe-phone');

// ==========================================================================
//
//  Author:   jsandoe
//
//  Copyright (c) 2016 by The Concord Consortium, Inc. All rights reserved.
//
//  Licensed under the Apache License, Version 2.0 (the "License");
//  you may not use this file except in compliance with the License.
//  You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the License is distributed on an "AS IS" BASIS,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the License for the specific language governing permissions and
//  limitations under the License.
// ==========================================================================
/**
 * This class is intended to provide an abstraction layer for managing
 * a CODAP Data Interactive's connection with CODAP. It is not required. It is
 * certainly possible for a data interactive, for example, to use only the
 * iFramePhone library, which manages the connection at a lower level.
 *
 * This object provides the following services:
 *   1. Initiates the iFramePhone interaction with CODAP.
 *   2. Provides information on the status of the connection.
 *   3. Provides a sendRequest method. It accepts a callback or returns a Promise
 *      for handling the results from CODAP.
 *   4. Provides a subscriber interface to receive selected notifications from
 *      CODAP.
 *   5. Provides automatic handling of Data Interactive State. Prior to saving
 *      a document CODAP requests state from the Data Interactive, where state
 *      is an arbitrary serializable object containing whatever the data
 *      interactive needs to retain. It returns this state when the document
 *      is reopened.
 *   6. Provides a utility to parse a resource selector into its component parts.
 *
 * @type {Object}
 *
 */
/**
 * The CODAP Connection
 * @param {iframePhone.IframePhoneRpcEndpoint}
 *
 * The callback signature spells out both arguments iframe-phone passes. It invokes the callback
 * with the reply alone when CODAP answers, and with `(undefined, Error)` when its own advisory 2s
 * timer expires — the second argument is the only thing distinguishing that probe from CODAP
 * answering with no value, so an annotation taking one argument silently discards the distinction.
 */
let connection = null;
let connectionState = "preinit";
/**
 * How long to wait for a CODAP response before giving up on a request.
 *
 * iframe-phone imposes its own hard-coded 2s deadline on every RPC, but that timer is a liveness
 * probe rather than a completion deadline: it neither cancels the request nor forgets the callback,
 * and it still delivers the real reply to that same callback once CODAP finishes. A request that
 * legitimately takes longer than 2s — creating several thousand items, say — is therefore reported
 * as failed while the result that is about to arrive is discarded. We wait for the real reply
 * instead, bounded by this much longer deadline so that a CODAP which never replies at all (page
 * closed, iframe removed) still can't leave callers awaiting forever.
 */
const kDefaultRequestTimeout = 60000;
/**
 * setTimeout stores its delay in a signed 32-bit int, so a larger delay overflows and the timer
 * fires immediately.
 */
const kMaxRequestTimeout = 2 ** 31 - 1;
/** How much of a request to quote in a failure message. See describeMessage. */
const kMaxDescribedMessage = 500;
let requestTimeout = kDefaultRequestTimeout;
const stats = {
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
let config = null;
let interactiveState = {};
/**
 * A list of subscribers to messages from CODAP
 * @param {[{actionSpec: {RegExp}, resourceSpec: {RegExp}, handler: {function}}]}
 */
const notificationSubscribers = [];
/** Whether init() has already registered its default interactiveState handler. */
let interactiveStateHandlerRegistered = false;
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
    stats.timeCodapLastReq = new Date();
    if (!stats.timeCodapFirstReq) {
        stats.timeCodapFirstReq = stats.timeCodapLastReq;
    }
    if (action === "notify" && !Array.isArray(requestValues)) {
        requestValues = [requestValues];
    }
    let handled = false;
    let success = true;
    if ((action === "get") || (action === "update")) {
        // get assumes only one subscriber because it expects only one response.
        notificationSubscribers.some(function (subscription) {
            let result = false;
            try {
                if ((subscription.actionSpec === action) &&
                    matchResource(resource, subscription.resourceSpec)) {
                    const rtn = subscription.handler(request);
                    if (rtn === null || rtn === void 0 ? void 0 : rtn.success) {
                        stats.countCodapRplSuccess++;
                    }
                    else {
                        stats.countCodapRplFail++;
                    }
                    returnMessage = rtn;
                    result = true;
                }
            }
            catch (ex) {
                // console.log('DI Plugin notification handler exception: ' + ex);
                result = true;
            }
            return result;
        });
        if (!handled) {
            stats.countCodapUnhandledReq++;
        }
    }
    else if (action === "notify") {
        requestValues.forEach(function (value) {
            notificationSubscribers.forEach(function (subscription) {
                // pass this notification to matching subscriptions
                handled = false;
                if ((subscription.actionSpec === action) && matchResource(resource, subscription.resourceSpec) && (!subscription.operation ||
                    (subscription.operation === value.operation) && subscription.handler)) {
                    const rtn = subscription.handler({ action, resource, values: value });
                    if (rtn === null || rtn === void 0 ? void 0 : rtn.success) {
                        stats.countCodapRplSuccess++;
                    }
                    else {
                        stats.countCodapRplFail++;
                    }
                    success = (success && (rtn ? rtn.success : false));
                    handled = true;
                }
            });
            if (!handled) {
                stats.countCodapUnhandledReq++;
            }
        });
    }
    else ;
    return callback(returnMessage);
}
/**
 * Reports an exception thrown by a caller's request callback.
 *
 * By the time the callback runs its request has already settled, so what it throws is not the
 * request's failure and must not escape into the stack that invoked it — iframe-phone's message
 * listener (where a throw skips its own bookkeeping), the deadline timer, or the promise executor
 * (which discards it silently, since the promise has settled). Rethrowing from a microtask keeps it
 * out of all three, since those stacks have unwound by the time it runs, while leaving it an
 * uncaught error that `window.onerror` and error reporters still see: logging it instead would hide
 * a consumer's bug from the monitoring they rely on.
 */
function reportCallbackError(error) {
    queueMicrotask(() => { throw error; });
}
/**
 * Renders a request for inclusion in an error message.
 *
 * `JSON.stringify` throws on a cyclic value and on a BigInt, both of which `postMessage` accepts —
 * so a request carrying either is genuinely sent, and the only thing that fails is describing it.
 * Building a failure message from `JSON.stringify` unguarded would therefore throw while a request
 * was being failed, leaving it settled by nothing at all.
 */
function describeMessage(message) {
    var _a;
    let described;
    try {
        described = (_a = JSON.stringify(message)) !== null && _a !== void 0 ? _a : String(message);
    }
    catch (_b) {
        return "[message could not be serialized]";
    }
    // Truncated because the requests likeliest to reach a failure message are the large ones: the
    // deadline exists for a createItems carrying thousands of items, and serializing that whole
    // payload into an Error -- then again wherever it is logged -- costs most exactly when the plugin
    // is already struggling. The head identifies the request, which is what a reader needs.
    return described.length > kMaxDescribedMessage
        ? described.slice(0, kMaxDescribedMessage) + "… (truncated)"
        : described;
}
/**
 * Runs one of the steps `init()` takes after its handshake has settled, keeping what that step
 * throws out of the handshake.
 *
 * Used both for the caller's own callbacks and for this module's merge of the saved state, which is
 * why it is not named for either: by the time any of them runs the handshake has settled, so a throw
 * is not a failure to connect, and it must not escape into the promise chain the handshake was
 * resolved from — where nothing observes it, and it would be invisible. Reported through
 * `reportCallbackError`, so an uncaught error reaches `window.onerror` either way.
 */
function afterHandshake(step, state) {
    if (!step) {
        return;
    }
    try {
        const result = step(state);
        if (result && typeof result.then === "function") {
            result.then(undefined, reportCallbackError);
        }
    }
    catch (error) {
        reportCallbackError(error);
    }
}
/**
 * Records that CODAP is talking to us. This is the module's only source of positive evidence that
 * CODAP is there, and both inbound paths — replies and notifications — run through it.
 *
 * It exists to serve one rule, which the connection lifecycle rests on:
 *
 *   **Silence is only ever evidence of absence, and anything CODAP has actually done outranks it.**
 *
 * Silence means iframe-phone's advisory 2s timer expiring with no reply, and the only place this
 * module acts on it is `init()`'s handshake. Evidence outranks it in all three senses: by cause,
 * since a failure that is not silence — CODAP declining, answering emptily, a message that could not
 * be sent — is not evidence of absence at all; by state, since a reply or notification already seen
 * means the connection stays open however the handshake ends; and by time, since evidence arriving
 * after silence was acted on reopens the connection rather than being discarded for being late.
 *
 * The exception is `destroy()`, which is the caller deciding rather than this module inferring. It
 * drops the endpoint, so the `connection` check below fails and traffic still arriving — `destroy()`
 * does not unsubscribe from iframe-phone — cannot reopen a connection the caller closed.
 */
function markConnectionActive() {
    if (connection) {
        connectionState = "active";
    }
}
/**
 * Issues a request to CODAP and returns a promise of the response.
 */
function issueRequest(message, options = {}) {
    const { callback, onSilence } = options;
    return new Promise(function (resolve, reject) {
        let isSettled = false;
        let timeoutTimer;
        // A request settles exactly once, and the caller's callback is notified on every outcome:
        // with the response on success, and with `undefined` on failure. Callers may pass a callback
        // and discard the promise — several helpers in this package do — so for them the callback is
        // the only signal that the request is over.
        //
        // Success and failure go through separate entry points rather than one function with an
        // optional callback argument: what the callback receives is then fixed by which one is called,
        // so a path added later cannot resolve the promise correctly while notifying its callback with
        // `undefined`.
        function settle(settleFn, value, callbackResponse) {
            if (isSettled) {
                return;
            }
            isSettled = true;
            if (timeoutTimer !== undefined) {
                clearTimeout(timeoutTimer);
            }
            settleFn(value);
            if (callback) {
                // A callback written for the success case may not expect `undefined`. Whatever it throws
                // must not escape into iframe-phone's listener, the deadline timer, or this executor —
                // see reportCallbackError.
                try {
                    // An async callback reports a throw as a rejected return value, which the catch can't see.
                    // The callback types return `void`, but TypeScript lets a callback in that position return
                    // a value anyway, so an async one arrives here as a promise and has to be observed.
                    //
                    // The response is handed over unnarrowed: `sendRequest` pairs the callback's shape with the
                    // message's, so a batched request's callback is the one that takes an array and a single
                    // request's is the one that takes a result. This code does not need to know which it has.
                    // Calling the union directly would demand an argument satisfying both signatures at once,
                    // which only `undefined` does. Narrowing it to one accepting either response says what is
                    // actually true: `sendRequest` admits only the callback that matches its message's shape,
                    // so whichever is here can read whatever CODAP sent for it.
                    const notify = callback;
                    const callbackResult = notify(callbackResponse, message);
                    if (callbackResult && typeof callbackResult.then === "function") {
                        callbackResult.then(undefined, reportCallbackError);
                    }
                }
                catch (error) {
                    reportCallbackError(error);
                }
            }
        }
        function settleSuccess(response) {
            settle(resolve, response, response);
        }
        /**
         * Fails the request. Rejects with an Error — never a string — so a consumer's `.catch` gets a
         * stack, and so every rejection from this module has one shape to handle. Takes `unknown` so
         * that a caught exception can be passed straight through without each call site repeating the
         * same normalization.
         *
         * Every failure goes through here, which is what lets `countDiReqFailed` account for all of
         * them without each path remembering to count itself.
         */
        function settleFailure(reason) {
            if (!isSettled) {
                stats.countDiReqFailed++;
            }
            settle(reject, reason instanceof Error ? reason : new Error(String(reason)));
        }
        /**
         * @param response CODAP's reply, or `undefined` if there is none yet.
         * @param noReplyYet present only when iframe-phone is reporting that its own advisory 2s timer
         *    expired. That is a liveness probe, not a completion deadline: the request is still in
         *    flight and the real reply will arrive at this same callback. A genuinely empty reply from
         *    CODAP arrives as `undefined` with this argument absent, which is a real answer and settles
         *    the request at once. See `connection`'s type for why this argument has to be declared.
         */
        function handleResponse(response, noReplyYet) {
            // Anything other than the probe is CODAP replying, and a reply is evidence it is there whenever
            // it arrives — including for a request that has already given up on it. Recorded before the
            // settled check, so that evidence is never discarded for arriving late: a CODAP slow to finish
            // iframe-phone's hello exchange answers a handshake that has already been failed for silence,
            // and that answer is what reopens the connection.
            if (!noReplyYet) {
                markConnectionActive();
            }
            // A reply can still arrive after the deadline rejected the request. Returning early keeps it
            // from counting a success, or settling again, against a request the caller has already been
            // told failed.
            if (isSettled) {
                return;
            }
            // `null` is grouped with `undefined` deliberately: it is just as empty an answer, and reading
            // `.success` off it would throw here, inside iframe-phone's message listener, where nothing
            // would settle the request.
            if (response === undefined || response === null) {
                if (noReplyYet) {
                    // Nothing has answered within iframe-phone's advisory 2s. The request is still in flight,
                    // so this is not an outcome — except during the handshake, where silence is the answer.
                    stats.countDiRplTimeout++;
                    if (onSilence) {
                        // This runs inside iframe-phone's message listener, so a throw from a supplied function
                        // must neither leave the request unsettled nor escape into that listener — the failure
                        // this module exists to prevent. Reported rather than rethrown, and the request settles
                        // either way, which is how every other supplied function here is handled.
                        //
                        // Defensive: the only `onSilence` today cannot throw, so there is no test for this. It
                        // is guarded because `onSilence` is a general option, and because a supplied function
                        // running on a listener's stack is exactly where this module has been bitten before.
                        try {
                            onSilence();
                        }
                        catch (error) {
                            reportCallbackError(error);
                        }
                        settleFailure("handleResponse: CODAP request timed out: " + describeMessage(message));
                    }
                    return;
                }
                // CODAP answered, with no value. That is a real answer and settles the request, but there
                // is no result for the caller to read, so it fails rather than resolving with `undefined`
                // and handing the caller something `result.success` throws on.
                settleFailure("handleResponse: CODAP answered with no result: " + describeMessage(message));
                return;
            }
            // A batched request — an array of requests — is answered with an array of results, which has no
            // top-level `success` to read. It counts as the one request it was, and as a success only if
            // every result in it succeeded, so the counters keep reconciling against `countDiReq`. A reply
            // with no results in it counts as a decline rather than a vacuous success, since a batch
            // answered by nothing did not do what was asked.
            const succeeded = Array.isArray(response)
                ? response.length > 0 && response.every(result => result === null || result === void 0 ? void 0 : result.success)
                : response.success;
            if (succeeded) {
                stats.countDiRplSuccess++;
            }
            else {
                stats.countDiRplFail++;
            }
            settleSuccess(response);
        }
        // Counted here rather than beside `connection.call`, so that a request refused before it could
        // be sent still counts as one the caller issued. Counting only the sent ones let the refusal
        // paths increment countDiReqFailed against a countDiReq that had not moved, and the documented
        // in-flight arithmetic then went negative.
        stats.countDiReq++;
        stats.timeDiLastReq = new Date();
        if (!stats.timeDiFirstReq) {
            stats.timeDiFirstReq = stats.timeDiLastReq;
        }
        switch (connectionState) {
            case "closed": // log the message and ignore
                // console.warn('sendRequest on closed CODAP connection: ' + JSON.stringify(message));
                settleFailure("sendRequest on closed CODAP connection: " + describeMessage(message));
                break;
            case "preinit": // warn, but issue request.
            // console.log('sendRequest on not yet initialized CODAP connection: ' +
            // JSON.stringify(message));
            /* falls through */
            default:
                if (connection) {
                    // `call` can throw synchronously — an uncloneable value in the message makes postMessage
                    // raise DataCloneError. Settling here rather than letting the throw escape the executor is
                    // what keeps the callback contract true on this path: an escaped throw rejects the promise
                    // without ever passing through settle(), so the caller's callback would never fire.
                    //
                    // The deadline is armed inside the same `try`, after the call, so a throw skips it: there
                    // is then no timer to outlive a request that has already settled, and no ordering for a
                    // later edit to get wrong. Nothing can settle before the timer exists, because iframe-phone
                    // never invokes the callback synchronously — it stores the callback, arms its own 2s timer,
                    // and posts.
                    try {
                        connection.call(message, handleResponse);
                        // Capture the deadline this request was given, so a later setRequestTimeout() can't
                        // make the reported duration disagree with the timer that actually fired.
                        const timeout = requestTimeout;
                        // Guarded because `settle` can only clear a timer that exists: were `call` ever to
                        // answer synchronously, the request would settle while `timeoutTimer` was still
                        // undefined and this would arm one nothing clears. iframe-phone does not do that today,
                        // and this does not depend on it continuing not to.
                        if (!isSettled) {
                            timeoutTimer = setTimeout(function () {
                                if (isSettled) {
                                    return;
                                }
                                stats.countDiReqDeadlineExceeded++;
                                settleFailure("sendRequest: CODAP request exceeded " + timeout + "ms: " +
                                    describeMessage(message));
                            }, timeout);
                        }
                    }
                    catch (error) {
                        settleFailure(error);
                    }
                }
                else {
                    // Nothing will ever call back, so settle now rather than leaving the caller waiting
                    // forever — the same guarantee the deadline provides once a request is in flight.
                    settleFailure("sendRequest on non-existent CODAP connection: " + describeMessage(message));
                }
        }
    });
}
const codapInterface = {
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
        return new Promise(function (resolve, reject) {
            /**
             * Fails the handshake, leaving the connection as it is.
             *
             * Used when CODAP answered and declined: it is there, and it is listening, so the connection
             * remains usable and the caller is free to try something else.
             */
            function rejectHandshake(reason) {
                reject(reason instanceof Error ? reason : new Error(String(reason)));
                // the callback reports every outcome, as sendRequest's does; there is no state to pass on
                afterHandshake(iCallback, undefined);
            }
            /**
             * Closes the connection, because nothing answered the handshake.
             *
             * Passed as `onSilence`, so this runs when silence is *observed* rather than when the handshake
             * is found to have failed. Every other way it can fail — CODAP declining, CODAP answering
             * emptily, the message failing to post — says nothing about whether CODAP is there, and leaves
             * the connection alone.
             *
             * An endpoint nothing is listening to looks live to `issueRequest`, so left in place every
             * later request would be sent and then wait out the full deadline: a minute apiece for a plugin
             * already told it is not running inside CODAP. Closing it means those are refused at once,
             * which is what `init()` rejecting is supposed to have told the caller, and `init()` can be
             * called again to retry.
             *
             * Silence here is weaker evidence than it looks: iframe-phone arms its 2s timer when `call` is
             * invoked but queues the message until the parent answers its repeated hello, so the window
             * covers that exchange as well as the round trip. Set against that, the handshake asks CODAP
             * for much less work than the requests this deadline handling exists to stop failing: reading
             * the interactive frame is a bare read, though the update half of it does set name, title and
             * dimensions, which makes CODAP resize and reposition the component in a live document. So
             * this is a judgement about relative likelihood, not a proof — which is why anything CODAP has
             * already been seen answering overrides it, above.
             *
             * Only this handshake's own endpoint is closed. Two `init()` calls can overlap — React's
             * StrictMode double-invokes effects, and the README's example initializes in one — and the
             * loser must not close the connection the winner established.
             */
            function closeSilentConnection() {
                // "active" means something from CODAP has already arrived — a reply to any request, or a
                // notification. That is positive evidence it is there, and it outranks this handshake's
                // silence: an ordinary request can be answered while the handshake is still outstanding, and
                // an earlier init() can have been answered on a connection this one has since replaced.
                //
                // `init()` resets the state to "preinit" before each handshake, so what suppresses the close
                // is activity observed since that reset — not necessarily activity on this endpoint, since
                // `markConnectionActive` asks only that some connection exists. A reply to a request issued
                // before an intervening `destroy()` therefore counts. That is deliberate rather than merely
                // tolerated: every endpoint built against `window.parent` shares one iframe-phone singleton,
                // so such a reply really is the parent talking, and the parent is what this is evidence
                // about. A re-init that draws no reply, with nothing else arriving, still closes.
                if (connection === endpoint && connectionState !== "active") {
                    // The state is closed but the endpoint is kept. Requests are refused either way, since the
                    // `case "closed"` branch does not consult it — but keeping it is what lets a reply arriving
                    // later reopen the connection, through `markConnectionActive`. A CODAP merely slow to
                    // finish iframe-phone's hello exchange therefore recovers by itself, rather than being
                    // locked out by a guess made at two seconds. `destroy()` is the deliberate teardown, and
                    // that one does drop the endpoint.
                    connectionState = "closed";
                }
            }
            function getFrameRespHandler(resp) {
                // `resp` is always defined here: a handshake that drew no reply rejects rather than
                // resolving, so it reaches rejectHandshake instead of this function.
                const success = resp && resp[1] && resp[1].success;
                const receivedFrame = success && resp[1].values;
                const savedState = receivedFrame && receivedFrame.savedState;
                if (!connection) {
                    // `destroy()` ran while this handshake was outstanding. Resolving would hand the caller a
                    // connection they have already torn down — state `"closed"`, every request refused — and
                    // merge saved state into a plugin that is going away. What they did outranks what CODAP
                    // said, so this fails instead.
                    rejectHandshake("init: the connection was destroyed before the handshake completed");
                    return;
                }
                if (success) {
                    // Object.assign onto a value that came out of a saved document can throw -- a getter that
                    // throws, a non-writable property -- and before `resolve` that would leave init() pending
                    // forever with the exception discarded into a promise nothing observes. Same reasoning as
                    // the callbacks below, so it settles first and reports the same way.
                    resolve(savedState);
                    afterHandshake(state => this_.updateInteractiveState(state), savedState);
                    // deprecated way of conveying state
                    afterHandshake(iConfig.stateHandler, savedState);
                    afterHandshake(iCallback, savedState);
                }
                else {
                    // CODAP answered and declined, so the connection is alive and stays usable
                    rejectHandshake((resp[1] && resp[1].values && resp[1].values.error) || "unknown failure");
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
            // initialize connection
            const endpoint = new iframePhone.IframePhoneRpcEndpoint(notificationHandler, "data-interactive", window.parent);
            connection = endpoint;
            // Reset the state, so that initializing again after destroy() works. Without this the
            // handshake below would be refused by the `case "closed"` branch in issueRequest, and the
            // connection could never be reestablished.
            connectionState = "preinit";
            // guard against re-registering on a second init(), which would leave a duplicate subscriber
            // behind for every reconnect
            if (!config.customInteractiveStateHandler && !interactiveStateHandlerRegistered) {
                this_.on("get", "interactiveState", function () {
                    return ({ success: true, values: this_.getInteractiveState() });
                }.bind(this_));
                interactiveStateHandlerRegistered = true;
            }
            // console.log('sending interactiveState: ' + JSON.stringify(this_.getInteractiveState));
            // update, then get the interactiveFrame.
            return issueRequest([updateFrameReq, getFrameReq], { onSilence: closeSilentConnection })
                .then(getFrameRespHandler, rejectHandshake);
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
    getConnectionState() { return connectionState; },
    /**
     * How long, in milliseconds, a request waits for a CODAP response before it is rejected.
     * Defaults to 60000. Raise it for plugins that issue requests over very large datasets; lower it
     * if a caller needs to fail fast.
     *
     * This is deliberately much longer than the 2s timer inside iframe-phone, which reports that no
     * reply has arrived yet without cancelling the request — a large request routinely takes longer
     * than that and still succeeds.
     */
    getRequestTimeout() { return requestTimeout; },
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
        requestTimeout = Number.isFinite(timeout) && timeout > 0
            ? Math.min(timeout, kMaxRequestTimeout)
            : kDefaultRequestTimeout;
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
        // TODO: tear down properly. Two things are missing, and both need machinery this does not have.
        //
        // Settle the requests still in flight: each waits out its full deadline instead — a minute in
        // which the caller holds its payload alive after the plugin is gone, ending in a rejection that
        // can surface against a re-initialized instance. They used to fail within iframe-phone's ~2s by
        // accident. Doing it needs a registry of in-flight requests, since `isSettled` and
        // `timeoutTimer` are locals inside each issueRequest executor.
        //
        // A resolution is the sharper case, not a rejection: an outstanding handshake that CODAP answers
        // after teardown would otherwise resolve `init()` against a connection the caller has closed, and
        // merge saved state into a plugin that is going away. `getFrameRespHandler` refuses that
        // explicitly for now; the registry would cover it along with everything else.
        //
        // Unsubscribe from iframe-phone, whose endpoint exposes `disconnect()`: dropping the reference
        // leaves its window message listener installed, so CODAP's notifications still reach
        // notificationHandler after teardown (which is why the inbound paths check `connection` before
        // reporting the connection live) and a reply to a request still in flight is delivered to a
        // callback for a request nobody is waiting on. Calling it needs coverage of what iframe-phone's
        // module-level endpoint singleton does across a disconnect/reconnect, which these unit tests
        // cannot provide against a mocked endpoint.
        connection = null;
        // Report the state the caller put us in, so getConnectionState() is honest after teardown and
        // new requests are refused rather than reaching a null connection. init() resets this.
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
        selectors.forEach(function (selector) {
            let resourceType, resourceName;
            const match = selectorRE.exec(selector);
            if (selectorRE.test(selector) && match) {
                resourceType = match[1];
                resourceName = match[2];
                result[resourceType] = resourceName;
                result.type = resourceType;
            }
            else {
                result.type = selector;
            }
        });
        return result;
    }
};

////////////// internal helper functions //////////////
const ctxStr = (contextName) => `dataContext[${contextName}]`;
const collStr = (collectionName) => `collection[${collectionName}]`;
const createMessage = (action, resource, values) => {
    return {
        action,
        resource,
        values
    };
};
const sendMessage = async (action, resource, values) => {
    const message = createMessage(action, resource, values);
    return await codapInterface.sendRequest(message);
};
// CODAP answers a request with success true or false; it may also not answer at all, in which case
// a callback receives `undefined`. Absence of a response is not a failure response — it licenses no
// conclusion about what CODAP did — so each call site has to decide what not knowing means for it.
//
// Prefer the promise form (`sendMessage`, or `await codapInterface.sendRequest(...)`) in helpers
// that consume the answer: absence then arrives as a rejection, which is noisy if unhandled,
// whereas an unchecked `undefined` yields a plausible-looking wrong answer. The callback form suits
// a fire-and-forget request that nothing depends on — but the promise still rejects on failure
// whether or not anyone is reading it, so such a call needs a `.catch` as well as its callback.
// Some helpers issue a request without awaiting it, so a rejection has nothing attached to observe
// it. Report it rather than letting it surface as an unhandled rejection.
//
// `what` describes the specific thing that went wrong, not just the helper it went wrong in: for a
// fire-and-forget helper this warning is the only diagnostic a plugin author gets, and one that
// cannot say which of several outcomes occurred sends them reading source to find out.
const reportRequestFailure = (what, error) => {
    // eslint-disable-next-line no-console
    console.warn(what, error !== null && error !== void 0 ? error : "");
};
////////////// public API //////////////
const initializePlugin = async (options) => {
    const { pluginName, version, dimensions } = options;
    const interfaceConfig = {
        name: pluginName,
        version,
        dimensions
    };
    return await codapInterface.init(interfaceConfig);
};
////////////// component functions //////////////
const createTable = async (dataContext, datasetName) => {
    const values = {
        type: "caseTable",
        dataContext
    };
    if (datasetName) {
        values.name = datasetName;
    }
    return sendMessage("create", "component", values);
};
// Selects this component. In CODAP this will bring this component to the front.
const selectSelf = () => {
    // Neither request is awaited. A failed request reports an undefined result to its callback.
    const selectComponent = async function (id) {
        return codapInterface.sendRequest({
            action: "notify",
            resource: `component[${id}]`,
            values: { request: "select" }
        }, (result) => {
            // an undefined result means CODAP didn't respond, which the catch below reports
            if (result && !result.success) {
                reportRequestFailure("selectSelf: CODAP declined to select the component");
            }
        }).catch(error => reportRequestFailure("selectSelf: the select request failed", error));
    };
    codapInterface.sendRequest({ action: "get", resource: "interactiveFrame" }, (result) => {
        var _a;
        // an undefined result means CODAP didn't respond, which the catch below reports
        if (!result) {
            return;
        }
        // without the frame's id there is no component to select, and requesting `component[undefined]`
        // would ask CODAP to select something that cannot exist
        if (!result.success) {
            reportRequestFailure("selectSelf: CODAP declined the interactiveFrame lookup");
            return;
        }
        if (((_a = result.values) === null || _a === void 0 ? void 0 : _a.id) === undefined) {
            reportRequestFailure("selectSelf: the interactiveFrame reply carried no id");
            return;
        }
        return selectComponent(result.values.id);
    }).catch(error => reportRequestFailure("selectSelf: the interactiveFrame lookup failed", error));
};
const addComponentListener = (callback) => {
    codapInterface.on("notify", "component", callback);
};
////////////// data context functions //////////////
const getListOfDataContexts = () => {
    return sendMessage("get", "dataContextList");
};
const getDataContext = (dataContextName) => {
    return sendMessage("get", ctxStr(dataContextName));
};
const createDataContext = (dataContextName) => {
    return sendMessage("create", "dataContext", { name: dataContextName });
};
const createDataContextFromURL = (url) => {
    return sendMessage("create", "dataContextFromURL", { "URL": url });
};
const addDataContextsListListener = (callback) => {
    codapInterface.on("notify", "documentChangeNotice", callback);
};
const addDataContextChangeListener = (dataContextName, callback) => {
    codapInterface.on("notify", `dataContextChangeNotice[${dataContextName}]`, callback);
};
////////////// collection functions //////////////
const getCollectionList = (dataContextName) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.collectionList`);
};
const getCollection = (dataContextName, collectionName) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.${collStr(collectionName)}`);
};
const createParentCollection = (dataContextName, collectionName, attrs) => {
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
const createChildCollection = (dataContextName, collectionName, parentCollectionName, attrs) => {
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
const createNewCollection = (dataContextName, collectionName, attrs) => {
    const resource = `${ctxStr(dataContextName)}.collection`;
    const values = {
        "name": collectionName,
        "title": collectionName,
    };
    if (attrs) {
        values.attrs = attrs;
    }
    return sendMessage("create", resource, values);
};
const ensureUniqueCollectionName = async (dataContextName, collectionName, index) => {
    index = index || 0;
    // guard against runaway loops. `> 100` rather than `>= 100` so that the hundredth suffix is still
    // tried: the candidates are `collectionName` through `collectionName100`, and stopping at 99 would
    // report no name available while one still was.
    if (index > 100) {
        return undefined;
    }
    const uniqueName = `${collectionName}${index !== 0 ? index : ""}`;
    const getCollMessage = {
        "action": "get",
        "resource": `${ctxStr(dataContextName)}.collection[${uniqueName}]`
    };
    // sendRequest rejects when CODAP doesn't respond, so awaiting it throws here. Not hearing back
    // says nothing about whether the collection exists, so let that reach the caller rather than
    // concluding the name is free and risking a duplicate.
    const result = await codapInterface.sendRequest(getCollMessage);
    if (result.success) {
        return ensureUniqueCollectionName(dataContextName, collectionName, index + 1);
    }
    else {
        return uniqueName;
    }
};
////////////// attribute functions //////////////
const getAttribute = (dataContextName, collectionName, attributeName) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attribute[${attributeName}]`;
    return sendMessage("get", resource);
};
const getAttributeList = (dataContextName, collectionName) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attributeList`;
    return sendMessage("get", resource);
};
const createNewAttribute = (dataContextName, collectionName, attributeName) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attribute`;
    const values = {
        "name": attributeName,
        "title": attributeName,
    };
    return sendMessage("create", resource, values);
};
const updateAttribute = (dataContextName, collectionName, attributeName, attribute, values) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attribute[${attributeName}]`;
    return sendMessage("update", resource, values);
};
const updateAttributePosition = (dataContextName, collectionName, attrName, newPosition) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.attributeLocation[${attrName}]`;
    return sendMessage("update", resource, {
        "collection": collectionName,
        "position": newPosition
    });
};
// Reorganizes the attribute into its own collection. Each step depends on the answer to the one
// before it, so this follows the promise-form guidance above: it awaits every request and resolves
// with the result of the last step it reached — the attribute move when every step ran, or the step
// CODAP refused. A request that goes unanswered rejects.
//
// Note what the resolved result does and does not tell the caller: that the steps this function
// issued succeeded. It does not report what CODAP did in response, in particular whether the old
// collection was removed once its last attribute left.
const createCollectionFromAttribute = async (dataContextName, oldCollectionName, attr, parent) => {
    var _a, _b;
    // check if a collection for the attribute already exists
    const getCollectionMessage = createMessage("get", `${ctxStr(dataContextName)}.${collStr(attr.name)}`);
    const existingCollection = await codapInterface.sendRequest(getCollectionMessage);
    // Since you can't "re-parent" collections, the attribute gets a new collection of its own and is
    // moved into it. When the attribute is the only one left in its old collection, or is the one the
    // collection is named for, that new collection takes a name derived from the attribute's — and
    // CODAP removes the old collection once it is empty.
    // (a successful lookup for a collection with no attribute list leaves `attrs` undefined, hence `?.`)
    const moveCollection = existingCollection.success &&
        (((_b = (_a = existingCollection.values) === null || _a === void 0 ? void 0 : _a.attrs) === null || _b === void 0 ? void 0 : _b.length) === 1 || attr.name === oldCollectionName);
    const newCollectionName = moveCollection
        ? await ensureUniqueCollectionName(dataContextName, attr.name, 0)
        : attr.name;
    if (newCollectionName === undefined) {
        // no unused name was available, so there is nothing to create the collection under. Nothing was
        // asked of CODAP and nothing went wrong with the connection, so this is a refusal rather than a
        // rejection: report it in the shape CODAP uses for a request it declines, and let the caller
        // read `success` the same way it does for every other step.
        return {
            success: false,
            values: { error: `createCollectionFromAttribute: no unused collection name based on "${attr.name}"` }
        };
    }
    const _parent = parent === "root" ? "_root_" : parent;
    const createCollectionRequest = createMessage("create", `${ctxStr(dataContextName)}.collection`, {
        "name": newCollectionName,
        "title": newCollectionName,
        parent: _parent,
    });
    const createCollectionResult = await codapInterface.sendRequest(createCollectionRequest);
    if (!createCollectionResult.success) {
        // without the new collection there is nowhere to move the attribute to
        return createCollectionResult;
    }
    const moveAttributeRequest = createMessage("update", `${ctxStr(dataContextName)}.${collStr(oldCollectionName)}.attributeLocation[${attr.name}]`, {
        "collection": newCollectionName,
        "position": 0
    });
    // moving the attribute is what makes the new collection the attribute's collection, so this is the
    // result that answers whether the reorganization happened
    return await codapInterface.sendRequest(moveAttributeRequest);
};
////////////// case functions //////////////
const getCaseCount = (dataContextName, collectionName) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseCount`;
    return sendMessage("get", resource);
};
const getCaseByIndex = (dataContextName, collectionName, index) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseByIndex[${index}]`;
    return sendMessage("get", resource);
};
const getCaseByID = (dataContextName, caseID) => {
    const resource = `${ctxStr(dataContextName)}.caseByID[${caseID}]`;
    return sendMessage("get", resource);
};
const getCaseBySearch = (dataContextName, collectionName, search) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseSearch[${search}]`;
    return sendMessage("get", resource);
};
const getCaseByFormulaSearch = (dataContextName, collectionName, search) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.caseFormulaSearch[${search}]`;
    return sendMessage("get", resource);
};
const createSingleOrParentCase = (dataContextName, collectionName, values) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.case`;
    return sendMessage("create", resource, values);
};
const createChildCase = (dataContextName, collectionName, parentCaseID, values) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.case`;
    const valuesWithParent = [
        {
            parent: parentCaseID,
            values
        }
    ];
    return sendMessage("create", resource, valuesWithParent);
};
const updateCaseById = (dataContextName, caseID, values) => {
    const resource = `${ctxStr(dataContextName)}.caseByID[${caseID}]`;
    const updateValues = {
        values
    };
    return sendMessage("update", resource, updateValues);
};
const updateCases = (dataContextName, collectionName, values) => {
    const resource = `${ctxStr(dataContextName)}.${collStr(collectionName)}.case`;
    return sendMessage("update", resource, values);
};
const getSelectionList = (dataContextName) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.selectionList`);
};
const selectCases = (dataContextName, caseIds) => {
    return sendMessage("create", `${ctxStr(dataContextName)}.selectionList`, caseIds);
};
const addCasesToSelection = (dataContextName, caseIds) => {
    return sendMessage("update", `${ctxStr(dataContextName)}.selectionList`, caseIds);
};
////////////// item functions //////////////
const getItemCount = (dataContextName) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.itemCount`);
};
const getAllItems = (dataContextName) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.itemSearch[*]`);
};
const getItemByID = (dataContextName, itemID) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.itemByID[${itemID}]`);
};
const getItemByIndex = (dataContextName, index) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.item[${index}]`);
};
const getItemByCaseID = (dataContextName, caseID) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.itemByCaseID[${caseID}]`);
};
const getItemBySearch = (dataContextName, search) => {
    return sendMessage("get", `${ctxStr(dataContextName)}.itemSearch[${search}]`);
};
const createItems = (dataContextName, items) => {
    return sendMessage("create", `${ctxStr(dataContextName)}.item`, items);
};
const updateItemByID = (dataContextName, itemID, values) => {
    return sendMessage("update", `${ctxStr(dataContextName)}.itemByID[${itemID}]`, values);
};
const updateItemByIndex = (dataContextName, index, values) => {
    return sendMessage("update", `${ctxStr(dataContextName)}.item[${index}]`, values);
};
const updateItemByCaseID = (dataContextName, caseID, values) => {
    return sendMessage("update", `${ctxStr(dataContextName)}.itemByCaseID[${caseID}]`, values);
};

exports.addCasesToSelection = addCasesToSelection;
exports.addComponentListener = addComponentListener;
exports.addDataContextChangeListener = addDataContextChangeListener;
exports.addDataContextsListListener = addDataContextsListListener;
exports.codapInterface = codapInterface;
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
exports.initializePlugin = initializePlugin;
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
//# sourceMappingURL=codap-plugin-api.js.map
