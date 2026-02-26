const STORAGE_KEY = "local_event_gateway_state";
const BRIDGE_CONFIG_KEY = "local_event_gateway_bridge";
const DEBUG_STATE_KEY = "local_event_gateway_debug";
const WS_SESSION_KEY = "local_event_gateway_ws";
const DEBUG_MAX_EVENTS = 200;
const DEFAULT_BRIDGE_PROFILE = {
  clientId: "project2chrome",
  url: "http://127.0.0.1:27123/payload",
  wsUrl: "ws://127.0.0.1:27123/ws",
  token: "project2chrome-local",
  enabled: true,
  priority: 100
};
const DEFAULT_BRIDGE = {
  autoSync: true,
  activeClientId: DEFAULT_BRIDGE_PROFILE.clientId,
  profiles: [DEFAULT_BRIDGE_PROFILE]
};
const DEFAULT_DEBUG_STATE = {
  enabled: true,
  showInfoBadge: false,
  events: []
};

const DEFAULT_WS_SESSION = {
  status: "disconnected",
  activeClientId: DEFAULT_BRIDGE_PROFILE.clientId,
  wsUrl: DEFAULT_BRIDGE_PROFILE.wsUrl,
  reconnectAttempt: 0,
  lastConnectedAt: null,
  lastError: null,
  heartbeatMs: 30000,
  queuedInbound: 0,
  queuedOutbound: 0
};

let wsClient = null;
let wsHeartbeatTimer = null;
let wsReconnectTimer = null;
let wsSessionId = null;
let wsOutboundQueue = [];
let wsInboundQueue = [];

/**
 * Structured audit logger for reverse-sync pipeline events.
 * Emits redact-safe JSON to console — never logs token values or full note content.
 * @param {string} event - event name: 'enqueue' | 'flush' | 'ack' | 'error'
 * @param {object} data - event-specific fields (no token/secret values)
 */
function rsLog(event, data) {
  const payload = { ts: Date.now(), event, ...data };
  console.log(JSON.stringify(payload));
  void recordDebugEvent(payload);
}

async function ensureDebugState() {
  const raw = await chrome.storage.local.get(DEBUG_STATE_KEY);
  const next = sanitizeDebugState(raw?.[DEBUG_STATE_KEY]);
  await chrome.storage.local.set({ [DEBUG_STATE_KEY]: next });
}

async function getDebugState() {
  const raw = await chrome.storage.local.get(DEBUG_STATE_KEY);
  return sanitizeDebugState(raw?.[DEBUG_STATE_KEY]);
}

async function setDebugOptions(input) {
  const current = await getDebugState();
  const next = {
    ...current,
    enabled: typeof input?.enabled === "boolean" ? input.enabled : current.enabled,
    showInfoBadge: typeof input?.showInfoBadge === "boolean" ? input.showInfoBadge : current.showInfoBadge
  };
  await chrome.storage.local.set({ [DEBUG_STATE_KEY]: next });
  if (!next.enabled) {
    await clearActionDebugIndicator();
  }
  return next;
}

async function clearDebugEvents() {
  const current = await getDebugState();
  const next = {
    ...current,
    events: []
  };
  await chrome.storage.local.set({ [DEBUG_STATE_KEY]: next });
  await clearActionDebugIndicator();
  return next;
}

function sanitizeDebugState(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawEvents = Array.isArray(base.events) ? base.events : [];
  const events = rawEvents
    .filter((entry) => entry && typeof entry === "object")
    .slice(-DEBUG_MAX_EVENTS)
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : String(Math.random()),
      ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
      level: entry.level === "error" || entry.level === "warn" ? entry.level : "info",
      event: typeof entry.event === "string" ? entry.event : "unknown",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      data: entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {}
    }));

  return {
    enabled: typeof base.enabled === "boolean" ? base.enabled : DEFAULT_DEBUG_STATE.enabled,
    showInfoBadge: typeof base.showInfoBadge === "boolean" ? base.showInfoBadge : DEFAULT_DEBUG_STATE.showInfoBadge,
    events
  };
}

async function recordDebugEvent(payload) {
  try {
    const state = await getDebugState();
    if (!state.enabled) {
      return;
    }

    const entry = toDebugEventEntry(payload);
    const nextEvents = [...state.events, entry];
    if (nextEvents.length > DEBUG_MAX_EVENTS) {
      nextEvents.splice(0, nextEvents.length - DEBUG_MAX_EVENTS);
    }

    const nextState = {
      ...state,
      events: nextEvents
    };

    await chrome.storage.local.set({ [DEBUG_STATE_KEY]: nextState });
    await updateActionDebugIndicator(entry, nextState);
  } catch {}
}

function toDebugEventEntry(payload) {
  const level = resolveDebugLevel(payload);
  return {
    id: typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    ts: Date.now(),
    level,
    event: String(payload.event || "unknown"),
    summary: summarizeDebugPayload(payload),
    data: payload
  };
}

function resolveDebugLevel(payload) {
  if (payload.event === "error" || payload.event === "quarantine") {
    return "error";
  }
  if (payload.event === "warn" || payload.event === "skip") {
    return "warn";
  }
  return "info";
}

function summarizeDebugPayload(payload) {
  const status = payload.status ? ` status=${payload.status}` : "";
  const reason = payload.reason ? ` reason=${payload.reason}` : "";
  const eventId = payload.eventId ? ` eventId=${payload.eventId}` : "";
  const batchId = payload.batchId ? ` batchId=${payload.batchId}` : "";
  return `${payload.event}${status}${reason}${eventId}${batchId}`.trim();
}

async function updateActionDebugIndicator(entry, state) {
  if (!chrome.action?.setTitle || !chrome.action?.setBadgeText || !chrome.action?.setBadgeBackgroundColor) {
    return;
  }

  const when = new Date(entry.ts).toLocaleTimeString();
  await chrome.action.setTitle({
    title: `Local Event Gateway\n[${entry.level.toUpperCase()}] ${when} ${entry.summary}`
  });

  if (entry.level === "error") {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: "ERR" });
    return;
  }

  if (entry.level === "warn") {
    await chrome.action.setBadgeBackgroundColor({ color: "#f29900" });
    await chrome.action.setBadgeText({ text: "WRN" });
    return;
  }

  if (!state.showInfoBadge) {
    return;
  }

  let text = "";
  let color = "#1a73e8";
  if (entry.event === "enqueue") {
    text = "Q";
  } else if (entry.event === "ack" && entry.data.status === "applied") {
    text = "ACK";
    color = "#188038";
  } else if (entry.event === "flush") {
    text = "UP";
  }

  if (!text) {
    return;
  }

  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

async function clearActionDebugIndicator() {
  if (!chrome.action?.setBadgeText || !chrome.action?.setTitle) {
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Local Event Gateway" });
}

async function ensureWebSocketSession() {
  const raw = await chrome.storage.local.get(WS_SESSION_KEY);
  const next = sanitizeWebSocketSession(raw?.[WS_SESSION_KEY]);
  await chrome.storage.local.set({ [WS_SESSION_KEY]: next });
}

async function getWebSocketSession() {
  const raw = await chrome.storage.local.get(WS_SESSION_KEY);
  return sanitizeWebSocketSession(raw?.[WS_SESSION_KEY]);
}

async function patchWebSocketSession(patch) {
  const current = await getWebSocketSession();
  const next = sanitizeWebSocketSession({
    ...current,
    ...patch
  });
  await chrome.storage.local.set({ [WS_SESSION_KEY]: next });
  return next;
}

function sanitizeWebSocketSession(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const status = readWsStatus(base.status);
  const reconnectAttempt = Number.isFinite(base.reconnectAttempt) ? Math.max(0, Math.trunc(base.reconnectAttempt)) : 0;
  const heartbeatMs = Number.isFinite(base.heartbeatMs) ? clampHeartbeatMs(base.heartbeatMs) : 30000;
  const queuedInbound = Number.isFinite(base.queuedInbound) ? Math.max(0, Math.trunc(base.queuedInbound)) : 0;
  const queuedOutbound = Number.isFinite(base.queuedOutbound) ? Math.max(0, Math.trunc(base.queuedOutbound)) : 0;
  return {
    status,
    activeClientId: readBridgeString(base.activeClientId) || DEFAULT_WS_SESSION.activeClientId,
    wsUrl: readBridgeString(base.wsUrl) || DEFAULT_WS_SESSION.wsUrl,
    reconnectAttempt,
    lastConnectedAt: readOptionalTimestamp(base.lastConnectedAt),
    lastError: readBridgeString(base.lastError) || null,
    heartbeatMs,
    queuedInbound,
    queuedOutbound
  };
}

function readWsStatus(value) {
  if (value === "connecting" || value === "connected" || value === "reconnecting") {
    return value;
  }
  return "disconnected";
}

function clampHeartbeatMs(value) {
  const n = Math.trunc(value);
  if (n < 1000) {
    return 1000;
  }
  if (n > 120000) {
    return 120000;
  }
  return n;
}

function readOptionalTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

function resolveWebSocketUrl(profile) {
  const explicit = readBridgeString(profile?.wsUrl);
  if (explicit) {
    return explicit;
  }
  const rawHttp = readBridgeString(profile?.url);
  if (!rawHttp) {
    return DEFAULT_BRIDGE_PROFILE.wsUrl;
  }

  try {
    const url = new URL(rawHttp);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return DEFAULT_BRIDGE_PROFILE.wsUrl;
  }
}

function createWsEventId() {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}


/**
 * Reverse sync contract docs shared with the plugin repository.
 * Backward compatibility strategy: parser may normalize legacy events that omit
 * `schemaVersion` or per-event `batchId` by falling back to schema v1 and the
 * envelope `batchId`.
 *
 * @typedef {"bookmark_created" | "bookmark_updated" | "bookmark_deleted" | "folder_renamed"} ReverseEventType
 */

/**
 * @typedef {Object} ReverseEvent
 * @property {string} batchId
 * @property {string} eventId
 * @property {ReverseEventType} type
 * @property {string} bookmarkId
 * @property {string} managedKey
 * @property {string=} parentId
 * @property {number=} moveIndex
 * @property {string=} title
 * @property {string=} url
 * @property {string} occurredAt ISO timestamp
 * @property {string} schemaVersion
 */

/**
 * @typedef {Object} ReverseBatch
 * @property {string} batchId
 * @property {ReverseEvent[]} events
 * @property {string} sentAt ISO timestamp
 */

/**
 * @typedef {"applied" | "skipped_ambiguous" | "skipped_unmanaged" | "rejected_invalid" | "duplicate"} AckStatus
 */

/**
 * @typedef {Object} EventAck
 * @property {string} eventId
 * @property {AckStatus} status
 * @property {string=} resolvedPath
 * @property {string=} resolvedKey
 * @property {string=} reason
 */

/**
 * @typedef {Object} BatchAckResponse
 * @property {string} batchId
 * @property {EventAck[]} results
 */

chrome.runtime.onInstalled.addListener(async () => {
  await ensureBridgeConfig();
  await ensureDebugState();
  await ensureWebSocketSession();
  await ensureAutoSyncAlarm();
  await ensureReverseFlushAlarm();
  await ensureWebSocketConnection("installed");
  scheduleReverseFlushSoon();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureBridgeConfig();
  await ensureDebugState();
  await ensureWebSocketSession();
  await ensureAutoSyncAlarm();
  await ensureReverseFlushAlarm();
  await ensureWebSocketConnection("startup");
  scheduleReverseFlushSoon();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reverseFlush") {
    void runReverseFlush().catch(() => {});
    return;
  }

  if (alarm.name === "local-event-gateway.wsReconnect") {
    void ensureWebSocketConnection("alarm_reconnect").catch(() => {});
    return;
  }

  if (alarm.name !== "local-event-gateway.autoSync") {
    return;
  }
  void syncFromBridge().catch(() => {});
});

async function ensureWebSocketConnection(reason = "manual") {
  const config = await getBridgeConfig();
  const profile = resolveActiveProfile(config.profiles, config.activeClientId);
  if (!profile || profile.enabled === false) {
    await patchWebSocketSession({
      status: "disconnected",
      activeClientId: config.activeClientId,
      lastError: "active_profile_disabled"
    });
    return;
  }

  const wsUrl = resolveWebSocketUrl(profile);
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    return;
  }
  if (wsClient && wsClient.readyState === WebSocket.CONNECTING) {
    return;
  }

  if (wsReconnectTimer !== null) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  wsSessionId = createWsEventId();
  const currentSession = await getWebSocketSession();
  await patchWebSocketSession({
    status: currentSession.reconnectAttempt > 0 ? "reconnecting" : "connecting",
    activeClientId: profile.clientId,
    wsUrl,
    lastError: null
  });
  rsLog("ws_connecting", {
    clientId: profile.clientId,
    reason,
    wsUrl
  });

  if (typeof WebSocket !== "function") {
    await patchWebSocketSession({
      status: "disconnected",
      lastError: "websocket_unavailable"
    });
    return;
  }

  try {
    wsClient = new WebSocket(wsUrl);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    await markWebSocketDisconnected("constructor_error", message, true);
    return;
  }

  wsClient.onopen = () => {
    void handleWebSocketOpen(profile).catch(() => {});
  };
  wsClient.onmessage = (event) => {
    void handleWebSocketMessage(event.data).catch(() => {});
  };
  wsClient.onerror = () => {
  };
  wsClient.onclose = (event) => {
    void handleWebSocketClose(event.code, event.reason || "closed").catch(() => {});
  };
}

async function handleWebSocketOpen(profile) {
  const heartbeatMs = 30000;
  await patchWebSocketSession({
    status: "connected",
    activeClientId: profile.clientId,
    wsUrl: resolveWebSocketUrl(profile),
    reconnectAttempt: 0,
    heartbeatMs,
    lastConnectedAt: new Date().toISOString(),
    lastError: null,
    queuedInbound: wsInboundQueue.length,
    queuedOutbound: wsOutboundQueue.length
  });

  sendWsEnvelope({
    type: "handshake",
    eventId: createWsEventId(),
    clientId: profile.clientId,
    occurredAt: new Date().toISOString(),
    schemaVersion: "1.0",
    sessionId: wsSessionId || createWsEventId(),
    token: profile.token,
    capabilities: ["action", "ack", "heartbeat"]
  });

  if (wsHeartbeatTimer !== null) {
    clearInterval(wsHeartbeatTimer);
  }
  wsHeartbeatTimer = setInterval(() => {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
      return;
    }
    sendWsEnvelope({
      type: "heartbeat_ping",
      eventId: createWsEventId(),
      clientId: profile.clientId,
      occurredAt: new Date().toISOString(),
      schemaVersion: "1.0"
    });
  }, Math.min(heartbeatMs, 25000));
  if (typeof wsHeartbeatTimer?.unref === "function") {
    wsHeartbeatTimer.unref();
  }

  await flushWsOutboundQueue();
  rsLog("ws_connected", {
    clientId: profile.clientId
  });
}

async function handleWebSocketMessage(rawMessage) {
  let parsed;
  try {
    parsed = JSON.parse(typeof rawMessage === "string" ? rawMessage : String(rawMessage));
  } catch {
    rsLog("ws_invalid_message", { reason: "json_parse_failed" });
    return;
  }

  const envelope = parseWsEnvelope(parsed);
  if (!envelope) {
    rsLog("ws_invalid_message", { reason: "schema_rejected" });
    return;
  }

  if (envelope.type === "handshake_ack") {
    rsLog("ws_handshake_ack", {
      accepted: String(envelope.accepted)
    });
    if (typeof envelope.heartbeatMs === "number") {
      await patchWebSocketSession({ heartbeatMs: clampHeartbeatMs(envelope.heartbeatMs) });
    }
    return;
  }

  if (envelope.type === "heartbeat_ping") {
    sendWsEnvelope({
      type: "heartbeat_pong",
      eventId: createWsEventId(),
      clientId: envelope.clientId,
      occurredAt: new Date().toISOString(),
      schemaVersion: "1.0",
      correlationId: envelope.eventId
    });
    return;
  }

  if (envelope.type === "heartbeat_pong") {
    return;
  }

  if (envelope.type === "ack") {
    const state = await getState();
    processReverseAckResponse(state, {
      batchId: envelope.idempotencyKey || envelope.correlationId || "ws",
      results: [
        {
          eventId: envelope.correlationId || envelope.eventId,
          status: mapWsAckToLegacyStatus(envelope.status, envelope.legacyStatus),
          reason: envelope.reason,
          resolvedPath: envelope.resolvedPath,
          resolvedKey: envelope.resolvedKey
        }
      ]
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return;
  }

  if (envelope.type === "error") {
    rsLog("ws_error", { reason: envelope.code || envelope.message || "unknown" });
    return;
  }

  if (envelope.type === "action") {
    const state = await getState();
    const inboundDedupeKey = envelope.idempotencyKey || envelope.eventId;
    if (!recordAndCheckDedupe(state, envelope.clientId, inboundDedupeKey)) {
      rsLog("ws_action_skip", {
        reason: "duplicate_inbound_event",
        eventId: envelope.eventId,
        clientId: envelope.clientId
      });
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
      return;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    wsInboundQueue.push(envelope);
    await patchWebSocketSession({ queuedInbound: wsInboundQueue.length });
    await flushWsInboundQueue();
  }
}

function parseWsEnvelope(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const type = readBridgeString(body.type);
  const eventId = readBridgeString(body.eventId);
  const clientId = readBridgeString(body.clientId);
  const occurredAt = readBridgeString(body.occurredAt);
  const schemaVersion = readBridgeString(body.schemaVersion);
  if (!type || !eventId || !clientId || !occurredAt || !schemaVersion) {
    return null;
  }

  if (type === "action") {
    const op = readBridgeString(body.op);
    const target = readBridgeString(body.target);
    const idempotencyKey = readBridgeString(body.idempotencyKey);
    if (!op || !target || !idempotencyKey) {
      return null;
    }
  }

  if (type === "ack") {
    const status = readBridgeString(body.status);
    if (!status) {
      return null;
    }
  }

  return body;
}

async function flushWsInboundQueue() {
  while (wsInboundQueue.length > 0) {
    const envelope = wsInboundQueue.shift();
    if (!envelope) {
      break;
    }

    if (envelope.op === "snapshot") {
      await syncFromPayload(envelope.payload || {});
      sendWsEnvelope({
        type: "ack",
        eventId: createWsEventId(),
        clientId: envelope.clientId,
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        correlationId: envelope.eventId,
        idempotencyKey: envelope.idempotencyKey,
        status: "applied",
        legacyStatus: "applied"
      });
      continue;
    }

    const ack = await applyInboundActionEvent(envelope);
    sendWsEnvelope({
      type: "ack",
      eventId: createWsEventId(),
      clientId: envelope.clientId,
      occurredAt: new Date().toISOString(),
      schemaVersion: "1.0",
      correlationId: envelope.eventId,
      idempotencyKey: envelope.idempotencyKey,
      status: mapLegacyAckStatus(ack.status),
      legacyStatus: ack.status,
      reason: ack.reason,
      resolvedKey: ack.resolvedKey,
      resolvedPath: ack.resolvedPath
    });
  }
  await patchWebSocketSession({ queuedInbound: wsInboundQueue.length });
}

async function applyInboundActionEvent(envelope) {
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const bookmarkId = readBridgeString(payload.bookmarkId) || readBridgeString(envelope.target);
  const title = payload.title;
  const url = payload.url;
  const parentId = readBridgeString(payload.parentId);

  try {
    if (envelope.op === "bookmark_created") {
      if (!parentId) {
        return { eventId: envelope.eventId, status: "rejected_invalid", reason: "missing_parent_id" };
      }
      const created = await chrome.bookmarks.create({
        parentId,
        title: typeof title === "string" ? title : "",
        url: typeof url === "string" ? url : undefined
      });
      return {
        eventId: envelope.eventId,
        status: "applied",
        resolvedKey: readBridgeString(payload.managedKey) || readBridgeString(envelope.target) || created.id
      };
    }

    if (envelope.op === "bookmark_updated") {
      if (!bookmarkId) {
        return { eventId: envelope.eventId, status: "rejected_invalid", reason: "missing_bookmark_id" };
      }
      await chrome.bookmarks.update(bookmarkId, {
        title: typeof title === "string" ? title : undefined,
        url: typeof url === "string" ? url : undefined
      });
      return {
        eventId: envelope.eventId,
        status: "applied",
        resolvedKey: readBridgeString(payload.managedKey) || readBridgeString(envelope.target) || bookmarkId
      };
    }

    if (envelope.op === "bookmark_deleted") {
      if (!bookmarkId) {
        return { eventId: envelope.eventId, status: "rejected_invalid", reason: "missing_bookmark_id" };
      }
      await chrome.bookmarks.remove(bookmarkId);
      return {
        eventId: envelope.eventId,
        status: "applied"
      };
    }

    if (envelope.op === "folder_renamed") {
      if (!bookmarkId) {
        return { eventId: envelope.eventId, status: "rejected_invalid", reason: "missing_folder_id" };
      }
      await chrome.bookmarks.update(bookmarkId, {
        title: typeof title === "string" ? title : ""
      });
      return {
        eventId: envelope.eventId,
        status: "applied"
      };
    }

    if (envelope.op === "bookmark_moved") {
      if (!bookmarkId || !parentId) {
        return { eventId: envelope.eventId, status: "rejected_invalid", reason: "missing_move_fields" };
      }
      const nextIndex = Number.isInteger(payload.index) ? payload.index : undefined;
      await chrome.bookmarks.move(bookmarkId, {
        parentId,
        index: typeof nextIndex === "number" ? nextIndex : undefined
      });
      return {
        eventId: envelope.eventId,
        status: "applied"
      };
    }
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    return {
      eventId: envelope.eventId,
      status: "skipped_ambiguous",
      reason: message
    };
  }

  return {
    eventId: envelope.eventId,
    status: "rejected_invalid",
    reason: "unsupported_action"
  };
}

async function flushWsOutboundQueue() {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
    return;
  }
  while (wsOutboundQueue.length > 0) {
    const next = wsOutboundQueue.shift();
    if (!next) {
      break;
    }
    sendWsEnvelope(next);
  }
  await patchWebSocketSession({ queuedOutbound: wsOutboundQueue.length });
}

async function handleWebSocketClose(code, reason) {
  if (wsHeartbeatTimer !== null) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  wsClient = null;
  await markWebSocketDisconnected(`close_${String(code)}`, String(reason || "closed"), true);
}

async function markWebSocketDisconnected(statusReason, detail, scheduleReconnect) {
  const current = await getWebSocketSession();
  const nextAttempt = current.reconnectAttempt + 1;
  await patchWebSocketSession({
    status: "disconnected",
    reconnectAttempt: nextAttempt,
    lastError: `${statusReason}:${detail}`
  });
  rsLog("ws_disconnected", {
    reason: statusReason,
    detail
  });

  if (!scheduleReconnect) {
    return;
  }

  const delayMs = Math.min(30000, 500 * (2 ** Math.min(nextAttempt, 6)));
  if (wsReconnectTimer !== null) {
    clearTimeout(wsReconnectTimer);
  }
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    void ensureWebSocketConnection("timer_backoff").catch(() => {});
  }, delayMs);
  if (typeof wsReconnectTimer?.unref === "function") {
    wsReconnectTimer.unref();
  }
  await chrome.alarms.create("local-event-gateway.wsReconnect", {
    when: Date.now() + delayMs
  });
}

function sendWsEnvelope(envelope) {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
    wsOutboundQueue.push(envelope);
    void patchWebSocketSession({ queuedOutbound: wsOutboundQueue.length });
    return;
  }

  try {
    wsClient.send(JSON.stringify(envelope));
  } catch {
    wsOutboundQueue.push(envelope);
    void patchWebSocketSession({ queuedOutbound: wsOutboundQueue.length });
  }
}

function mapWsAckToLegacyStatus(wsStatus, legacyStatus) {
  if (typeof legacyStatus === "string" && legacyStatus.length > 0) {
    return legacyStatus;
  }
  if (wsStatus === "applied") {
    return "applied";
  }
  if (wsStatus === "duplicate") {
    return "duplicate";
  }
  if (wsStatus === "skipped") {
    return "skipped_ambiguous";
  }
  return "rejected_invalid";
}

function mapLegacyAckStatus(status) {
  if (status === "applied") {
    return "applied";
  }
  if (status === "duplicate") {
    return "duplicate";
  }
  if (status === "skipped_ambiguous" || status === "skipped_unmanaged") {
    return "skipped";
  }
  return "rejected";
}

let reverseFlushTimer = null;
let reverseFlushInFlight = false;

function scheduleReverseFlushSoon() {
  if (typeof setTimeout !== "function") {
    return;
  }
  if (reverseFlushTimer !== null) {
    clearTimeout(reverseFlushTimer);
  }
  reverseFlushTimer = setTimeout(() => {
    reverseFlushTimer = null;
    void runReverseFlush().catch(() => {});
  }, 2000);
}

async function runReverseFlush() {
  if (reverseFlushInFlight) {
    return;
  }

  reverseFlushInFlight = true;
  try {
    const state = await getState();
    const config = await getBridgeConfig();
    await ensureWebSocketConnection("reverse_flush");
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      await flushReverseQueueOverWebSocket(state, config.activeClientId || config.clientId || "project2chrome");
    } else {
      rsLog("ws_flush_skip", {
        reason: "socket_not_connected",
        queued: String(state.reverseQueue.length)
      });
    }
  } finally {
    reverseFlushInFlight = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "gateway.syncFromBridge") {
    void syncFromBridge()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "gateway.getBridgeConfig") {
    void getBridgeConfig().then((config) => sendResponse({ ok: true, config }));
    return true;
  }

  if (message.type === "gateway.getDebugState") {
    void getDebugState().then((debug) => sendResponse({ ok: true, debug }));
    return true;
  }

  if (message.type === "gateway.getWebSocketSession") {
    void getWebSocketSession().then((session) => sendResponse({ ok: true, session }));
    return true;
  }

  if (message.type === "gateway.setDebugOptions") {
    void setDebugOptions(message.options)
      .then((debug) => sendResponse({ ok: true, debug }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "gateway.clearDebugEvents") {
    void clearDebugEvents()
      .then((debug) => sendResponse({ ok: true, debug }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "gateway.setBridgeConfig") {
    void setBridgeConfig(message.config)
      .then(async (config) => {
        if (config.autoSync) {
          await ensureAutoSyncAlarm();
        } else {
          await chrome.alarms.clear("local-event-gateway.autoSync");
        }
        await ensureWebSocketConnection("config_change");
        sendResponse({ ok: true, config });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

chrome.bookmarks.onCreated.addListener(handleBookmarkCreated);
chrome.bookmarks.onChanged.addListener(handleBookmarkChanged);
chrome.bookmarks.onRemoved.addListener(handleBookmarkRemoved);
chrome.bookmarks.onMoved.addListener(handleBookmarkMoved);
chrome.bookmarks.onImportBegan.addListener(handleImportBegan);
chrome.bookmarks.onImportEnded.addListener(handleImportEnded);

async function syncFromBridge() {
  await ensureWebSocketConnection("manual_sync");
  const wsSession = await getWebSocketSession();
  if (wsSession.status === "connected") {
    return {
      mode: "websocket",
      status: wsSession.status,
      activeClientId: wsSession.activeClientId
    };
  }

  rsLog("sync_error", {
    reason: "websocket_not_connected",
    activeClientId: wsSession.activeClientId || "unknown"
  });
  throw new Error("Bridge websocket is not connected");
}

async function syncFromPayload(payload) {
  const rootFolderName = (payload?.rootFolderName || "Projects").trim() || "Projects";
  const desired = Array.isArray(payload?.desired) ? payload.desired : [];

  const state = await getState();
  setApplyEpoch(state, true);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });

  try {
    const rootId = await ensureRootFolder(rootFolderName, state);
    await clearManagedTree(rootId, state);
    const nextState = {
      managedFolderIds: { __root__: rootId },
      managedBookmarkIds: {},
      reverseQueue: state.reverseQueue,
      bookmarkIdToManagedKey: {},
      suppressionState: state.suppressionState,
      importInProgress: state.importInProgress
    };

    const rootOrder = [];
    for (const folder of desired) {
      const folderId = await applyFolder(folder, rootId, nextState);
      rootOrder.push(folderId);
    }

    await reorderChildren(rootId, rootOrder);
    await chrome.storage.local.set({ [STORAGE_KEY]: nextState });
    return nextState;
  } finally {
    const resetState = await getState();
    setApplyEpoch(resetState, false);
    setCooldown(resetState, 3000);
    await chrome.storage.local.set({ [STORAGE_KEY]: resetState });
  }
}

async function getState() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return migrateState(raw?.[STORAGE_KEY]);
}

/**
 * Migrates raw storage state to the current shape, adding new fields with safe
 * defaults when missing. Preserves all existing fields without data loss.
 * Safe to call with null, undefined, or any non-object value.
 * @param {unknown} raw
 * @returns {{ managedFolderIds: object, managedBookmarkIds: object, reverseQueue: Array, bookmarkIdToManagedKey: object, suppressionState: { applyEpoch: boolean, epochStartedAt: string|null, cooldownUntil: number|null }, importInProgress: boolean }}
 */
function migrateState(raw) {
  const base = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const sup = (base.suppressionState && typeof base.suppressionState === "object" && !Array.isArray(base.suppressionState))
    ? base.suppressionState
    : {};
  let cooldownUntil = null;
  if (typeof sup.cooldownUntil === "number" && Number.isFinite(sup.cooldownUntil)) {
    cooldownUntil = sup.cooldownUntil;
  } else if (typeof sup.cooldownUntil === "string") {
    const parsed = Date.parse(sup.cooldownUntil);
    cooldownUntil = Number.isNaN(parsed) ? null : parsed;
  }
  return {
    managedFolderIds: (base.managedFolderIds && typeof base.managedFolderIds === "object" && !Array.isArray(base.managedFolderIds))
      ? base.managedFolderIds
      : {},
    managedBookmarkIds: (base.managedBookmarkIds && typeof base.managedBookmarkIds === "object" && !Array.isArray(base.managedBookmarkIds))
      ? base.managedBookmarkIds
      : {},
    reverseQueue: Array.isArray(base.reverseQueue) ? base.reverseQueue : [],
    bookmarkIdToManagedKey: (base.bookmarkIdToManagedKey && typeof base.bookmarkIdToManagedKey === "object" && !Array.isArray(base.bookmarkIdToManagedKey))
      ? base.bookmarkIdToManagedKey
      : {},
    suppressionState: {
      applyEpoch: sup.applyEpoch === true,
      epochStartedAt: sup.epochStartedAt ?? null,
      cooldownUntil
    },
    importInProgress: base.importInProgress === true,
    wsDedupe: migrateWsDedupe(base.wsDedupe)
  };
}

function migrateWsDedupe(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const byClient = base.byClient && typeof base.byClient === "object" && !Array.isArray(base.byClient)
    ? base.byClient
    : {};
  return {
    byClient,
    updatedAt: typeof base.updatedAt === "string" ? base.updatedAt : new Date().toISOString()
  };
}

/**
 * Adds a ReverseEvent to the durable reverse queue with retryCount 0.
 * Mutates state in place — caller must persist to chrome.storage.local.
 * @param {{ reverseQueue: Array }} state
 * @param {ReverseEvent} event
 */
function enqueueReverseEvent(state, event) {
  const dedupeKey = `outbound:${event.eventId}`;
  if (!recordAndCheckDedupe(state, "outbound", dedupeKey)) {
    rsLog("capture_skip", { reason: "duplicate_outbound_event", eventId: event.eventId, type: event.type });
    return;
  }
  state.reverseQueue.push({
    event,
    retryCount: 0,
    enqueuedAt: new Date().toISOString()
  });
  rsLog('enqueue', { batchId: event.batchId, eventId: event.eventId, type: event.type });
  scheduleReverseFlushSoon();
}

/**
 * Removes queue items whose eventId appears in ackedEventIds.
 * Non-matching items are preserved. Mutates state in place.
 * Caller must persist to chrome.storage.local.
 * @param {{ reverseQueue: Array }} state
 * @param {string[]} ackedEventIds
 */
function dequeueAckedEvents(state, ackedEventIds) {
  const idSet = new Set(ackedEventIds);
  state.reverseQueue = state.reverseQueue.filter((item) => !idSet.has(item.event.eventId));
}

function coalesceQueue(queue) {
  if (!Array.isArray(queue) || queue.length === 0) {
    return [];
  }

  const lastIndexByBookmarkId = {};
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    const bookmarkId = item && item.event ? item.event.bookmarkId : undefined;
    if (typeof bookmarkId === "string" && bookmarkId.length > 0) {
      lastIndexByBookmarkId[bookmarkId] = i;
    }
  }

  const result = [];
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    const bookmarkId = item && item.event ? item.event.bookmarkId : undefined;
    if (typeof bookmarkId !== "string" || bookmarkId.length === 0) {
      result.push(item);
      continue;
    }
    if (lastIndexByBookmarkId[bookmarkId] === i) {
      result.push(item);
    }
  }

  return result;
}

async function flushReverseQueue(state, bridgeUrl, bridgeToken) {
  const coalescedItems = coalesceQueue(state.reverseQueue);
  const count = coalescedItems.length;
  if (count === 0) {
    return;
  }

  const batchId = crypto.randomUUID();
  const reverseSyncUrl = resolveReverseSyncUrl(bridgeUrl);
  rsLog('flush', { batchId, count });

  const payload = {
    batchId,
    events: coalescedItems.map((item) => item.event),
    sentAt: new Date().toISOString()
  };

  try {
    const response = await fetch(reverseSyncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Project2Chrome-Token": bridgeToken
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const reason = `http_${response.status}`;
      markFlushFailures(state, coalescedItems, reason);
      rsLog('error', { batchId, reason });
      return;
    }

    const ackResponse = await response.json();
    processReverseAckResponse(state, ackResponse);
    removeSupersededCoalescedEvents(state, coalescedItems);
  } catch (error) {
    markFlushFailures(state, coalescedItems, "network_error");
    rsLog('error', {
      batchId,
      reason: 'network_error',
      message: error && error.message ? String(error.message) : String(error)
    });
  } finally {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }
}

async function flushReverseQueueOverWebSocket(state, clientId) {
  const coalescedItems = coalesceQueue(state.reverseQueue);
  if (coalescedItems.length === 0) {
    return;
  }

  for (const item of coalescedItems) {
    const event = item.event;
    sendWsEnvelope({
      type: "action",
      eventId: event.eventId,
      clientId,
      occurredAt: event.occurredAt,
      schemaVersion: "1.0",
      idempotencyKey: event.batchId,
      op: event.type,
      target: event.managedKey || event.bookmarkId,
      payload: {
        bookmarkId: event.bookmarkId,
        managedKey: event.managedKey,
        parentId: event.parentId,
        moveIndex: event.moveIndex,
        title: event.title,
        url: event.url
      }
    });
  }

  await patchWebSocketSession({ queuedOutbound: wsOutboundQueue.length });
}

function resolveReverseSyncUrl(bridgeUrl) {
  const raw = String(bridgeUrl || "").trim();
  if (!raw) {
    return "/reverse-sync";
  }

  const withoutHash = raw.split("#", 1)[0];
  const withoutQuery = withoutHash.split("?", 1)[0];
  const normalized = withoutQuery.replace(/\/+$/, "");

  if (normalized.endsWith("/payload")) {
    return `${normalized.slice(0, -"/payload".length)}/reverse-sync`;
  }

  return `${normalized}/reverse-sync`;
}

function removeSupersededCoalescedEvents(state, coalescedItems) {
  const coalescedBookmarkIds = new Set();
  const coalescedEventIds = new Set();

  for (const item of coalescedItems) {
    const eventId = item.event.eventId;
    const bookmarkId = item.event.bookmarkId;
    coalescedEventIds.add(eventId);
    if (typeof bookmarkId === "string" && bookmarkId.length > 0) {
      coalescedBookmarkIds.add(bookmarkId);
    }
  }

  state.reverseQueue = state.reverseQueue.filter((item) => {
    const eventId = item.event.eventId;
    const bookmarkId = item.event.bookmarkId;
    if (typeof bookmarkId !== "string" || bookmarkId.length === 0) {
      return true;
    }
    if (!coalescedBookmarkIds.has(bookmarkId)) {
      return true;
    }
    return coalescedEventIds.has(eventId);
  });
}

function markFlushFailures(state, failedItems, reason) {
  const failedIds = new Set(failedItems.map((item) => item.event.eventId));
  const nextQueue = [];

  for (const item of state.reverseQueue) {
    const eventId = item.event.eventId;
    if (!failedIds.has(eventId)) {
      nextQueue.push(item);
      continue;
    }

    const nextRetryCount = Number(item.retryCount || 0) + 1;
    if (nextRetryCount >= 3) {
      rsLog('quarantine', {
        eventId,
        bookmarkId: item.event.bookmarkId,
        retryCount: nextRetryCount,
        reason
      });
      continue;
    }

    item.retryCount = nextRetryCount;
    nextQueue.push(item);
  }

  state.reverseQueue = nextQueue;
}

/**
 * Process a BatchAckResponse from the plugin bridge and emit per-event ack logs.
 * Dequeues acked events from state. Caller must persist state to chrome.storage.local.
 * @param {{ reverseQueue: Array }} state
 * @param {{ batchId: string, results: Array<{ eventId: string, status: string }> }} ackResponse
 */
function processReverseAckResponse(state, ackResponse) {
  // Snapshot eventId -> queue item BEFORE mutations so bookmarkId is available for resolvedKey updates.
  const queueItemByEventId = {};
  for (const item of state.reverseQueue) {
    if (item && item.event && typeof item.event.eventId === 'string') {
      queueItemByEventId[item.event.eventId] = item;
    }
  }

  for (const result of ackResponse.results) {
    const eventId = result.eventId;
    const status = result.status;

    if (status === 'applied') {
      rsLog('ack', { batchId: ackResponse.batchId, eventId, status });
      if (typeof result.resolvedKey === 'string' && result.resolvedKey.length > 0) {
        const queueItem = queueItemByEventId[eventId];
        if (queueItem) {
          const bookmarkId = queueItem.event.bookmarkId;
          if (typeof bookmarkId === 'string' && bookmarkId.length > 0) {
            updateBookmarkKeyMapping(state, bookmarkId, result.resolvedKey);
          }
        }
      }
      dequeueAckedEvents(state, [eventId]);
    } else if (status === 'duplicate') {
      rsLog('ack', { batchId: ackResponse.batchId, eventId, status });
      dequeueAckedEvents(state, [eventId]);
    } else if (status === 'skipped_ambiguous' || status === 'skipped_unmanaged') {
      rsLog('skip', { batchId: ackResponse.batchId, eventId, status, reason: result.reason });
      dequeueAckedEvents(state, [eventId]);
    } else if (status === 'rejected_invalid') {
      rsLog('error', { batchId: ackResponse.batchId, eventId, status, reason: result.reason });
      dequeueAckedEvents(state, [eventId]);
    } else {
      // Unknown/future status — log warning, keep in queue for retry.
      rsLog('warn', { batchId: ackResponse.batchId, eventId, status, reason: 'unknown_status' });
    }
  }
}

/**
 * Records a bookmarkId -> managedKey reverse lookup mapping.
 * Mutates state in place — caller must persist to chrome.storage.local.
 * @param {{ bookmarkIdToManagedKey: object }} state
 * @param {string} bookmarkId
 * @param {string} managedKey
 */
function updateBookmarkKeyMapping(state, bookmarkId, managedKey) {
  state.bookmarkIdToManagedKey[bookmarkId] = managedKey;
}

/**
 * Sets or clears the apply-epoch suppression flag.
 * When active=true, records epochStartedAt timestamp.
 * When active=false, clears both epochStartedAt and cooldownUntil.
 * Mutates state in place — caller must persist to chrome.storage.local.
 * @param {{ suppressionState: { applyEpoch: boolean, epochStartedAt: string|null, cooldownUntil: number|null } }} state
 * @param {boolean} active
 */
function setApplyEpoch(state, active) {
  state.suppressionState.applyEpoch = active;
  if (active) {
    state.suppressionState.epochStartedAt = new Date().toISOString();
  } else {
    state.suppressionState.epochStartedAt = null;
    state.suppressionState.cooldownUntil = null;
  }
}

function setCooldown(state, durationMs) {
  state.suppressionState.cooldownUntil = Date.now() + durationMs;
}

function shouldSuppressReverseEnqueue(state) {
  if (state.suppressionState.applyEpoch === true) {
    return true;
  }
  const cooldownUntil = state.suppressionState.cooldownUntil;
  if (typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && Date.now() < cooldownUntil) {
    return true;
  }
  return false;
}

function recordAndCheckDedupe(state, clientId, key) {
  const dedupe = migrateWsDedupe(state.wsDedupe);
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000;
  const clientBucket = dedupe.byClient[clientId] && typeof dedupe.byClient[clientId] === "object"
    ? dedupe.byClient[clientId]
    : {};

  for (const candidate of Object.keys(clientBucket)) {
    const ts = Number(clientBucket[candidate]);
    if (!Number.isFinite(ts) || (now - ts) > ttlMs) {
      delete clientBucket[candidate];
    }
  }

  if (Object.prototype.hasOwnProperty.call(clientBucket, key)) {
    state.wsDedupe = {
      ...dedupe,
      byClient: {
        ...dedupe.byClient,
        [clientId]: clientBucket
      },
      updatedAt: new Date(now).toISOString()
    };
    return false;
  }

  clientBucket[key] = now;
  state.wsDedupe = {
    ...dedupe,
    byClient: {
      ...dedupe.byClient,
      [clientId]: clientBucket
    },
    updatedAt: new Date(now).toISOString()
  };
  return true;
}

async function ensureRootFolder(name, state) {
  const oldId = state.managedFolderIds?.__root__;
  if (oldId) {
    const existing = await getNode(oldId);
    if (existing && !existing.url) {
      if (existing.title !== name) {
        await chrome.bookmarks.update(oldId, { title: name });
      }
      return oldId;
    }
  }

  const [treeRoot] = await chrome.bookmarks.getTree();
  const bar = treeRoot?.children?.[0];
  if (!bar) {
    throw new Error("Bookmarks bar root not found");
  }

  const children = await chrome.bookmarks.getChildren(bar.id);
  const found = children.find((child) => !child.url && child.title === name);
  if (found) {
    return found.id;
  }
  const created = await chrome.bookmarks.create({ parentId: bar.id, title: name });
  return created.id;
}

async function applyFolder(folder, parentId, nextState) {
  const children = await chrome.bookmarks.getChildren(parentId);
  let folderNode = children.find((child) => !child.url && child.title === folder.name);
  if (!folderNode) {
    folderNode = await chrome.bookmarks.create({ parentId, title: folder.name });
  }

  nextState.managedFolderIds[folder.key] = folderNode.id;

  const orderedChildIds = [];

  for (const link of folder.links || []) {
    const bookmark = await chrome.bookmarks.create({
      parentId: folderNode.id,
      title: link.title,
      url: link.url
    });
    nextState.managedBookmarkIds[link.key] = bookmark.id;
    nextState.bookmarkIdToManagedKey[bookmark.id] = link.key;
    orderedChildIds.push(bookmark.id);
  }

  for (const child of folder.children || []) {
    const childFolderId = await applyFolder(child, folderNode.id, nextState);
    orderedChildIds.push(childFolderId);
  }

  await reorderChildren(folderNode.id, orderedChildIds);
  return folderNode.id;
}

async function reorderChildren(parentId, desiredOrderIds) {
  for (const [targetIndex, id] of desiredOrderIds.entries()) {
    const children = await chrome.bookmarks.getChildren(parentId);
    const currentIndex = children.findIndex((child) => child.id === id);
    if (currentIndex === -1 || currentIndex === targetIndex) {
      continue;
    }
    await chrome.bookmarks.move(id, { parentId, index: targetIndex });
  }
}

async function clearManagedTree(rootId, state) {
  for (const id of Object.values(state.managedBookmarkIds || {})) {
    await removeBookmarkSafe(id);
  }

  const folderEntries = Object.entries(state.managedFolderIds || {}).filter(([key]) => key !== "__root__");
  for (const [, id] of folderEntries) {
    await removeFolderSafe(id, rootId);
  }
}

async function removeBookmarkSafe(id) {
  const node = await getNode(id);
  if (!node || !node.url) {
    return;
  }
  await chrome.bookmarks.remove(id);
}

async function removeFolderSafe(id, rootId) {
  if (id === rootId) {
    return;
  }
  const node = await getNode(id);
  if (!node || node.url) {
    return;
  }
  await chrome.bookmarks.removeTree(id);
}

async function getNode(id) {
  try {
    const result = await chrome.bookmarks.get(id);
    return result[0] || null;
  } catch {
    return null;
  }
}

async function ensureBridgeConfig() {
  const raw = await chrome.storage.local.get(BRIDGE_CONFIG_KEY);
  const next = sanitizeBridgeConfig(raw?.[BRIDGE_CONFIG_KEY]);
  await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: next });
}

async function getBridgeConfig() {
  const raw = await chrome.storage.local.get(BRIDGE_CONFIG_KEY);
  const config = sanitizeBridgeConfig(raw?.[BRIDGE_CONFIG_KEY]);
  const activeProfile = resolveActiveProfile(config.profiles, config.activeClientId);
  const merged = {
    ...config,
    activeClientId: activeProfile.clientId,
    url: activeProfile.url,
    wsUrl: resolveWebSocketUrl(activeProfile),
    token: activeProfile.token
  };
  await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: config });
  return merged;
}

async function setBridgeConfig(input) {
  const currentRaw = await chrome.storage.local.get(BRIDGE_CONFIG_KEY);
  const current = sanitizeBridgeConfig(currentRaw?.[BRIDGE_CONFIG_KEY]);
  const currentActive = resolveActiveProfile(current.profiles, current.activeClientId);
  const base = {
    autoSync: typeof input?.autoSync === "boolean" ? input.autoSync : current.autoSync,
    activeClientId: readBridgeString(input?.activeClientId) || current.activeClientId,
    profiles: Array.isArray(input?.profiles)
      ? normalizeBridgeProfiles(input.profiles, currentActive.url, currentActive.token)
      : current.profiles
  };

  const preferredClientId = readBridgeString(input?.clientId);
  if (preferredClientId) {
    base.activeClientId = preferredClientId;
  }

  const nextProfiles = ensureProfileForSet(base.profiles, base.activeClientId, currentActive.url, currentActive.token);
  const activeProfile = resolveActiveProfile(nextProfiles, base.activeClientId);
  const nextUrl = readBridgeString(input?.url) || activeProfile.url;
  const nextWsUrl = readBridgeString(input?.wsUrl) || resolveWebSocketUrl(activeProfile);
  const nextToken = readBridgeString(input?.token) || activeProfile.token;

  const rewrittenProfiles = nextProfiles.map((profile) => {
    if (profile.clientId !== activeProfile.clientId) {
      return profile;
    }
    return {
      ...profile,
      url: nextUrl,
      wsUrl: nextWsUrl,
      token: nextToken,
      enabled: profile.enabled !== false
    };
  });

  const sanitized = sanitizeBridgeConfig({
    autoSync: base.autoSync,
    activeClientId: activeProfile.clientId,
    profiles: rewrittenProfiles
  });

  await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: sanitized });
  const mergedActive = resolveActiveProfile(sanitized.profiles, sanitized.activeClientId);
  return {
    ...sanitized,
    activeClientId: mergedActive.clientId,
    url: mergedActive.url,
    wsUrl: resolveWebSocketUrl(mergedActive),
    token: mergedActive.token
  };
}

function sanitizeBridgeConfig(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const legacyUrl = readBridgeString(base.url);
  const legacyToken = readBridgeString(base.token);
  const profiles = normalizeBridgeProfiles(base.profiles, legacyUrl || DEFAULT_BRIDGE_PROFILE.url, legacyToken || DEFAULT_BRIDGE_PROFILE.token);
  const preferredActiveClientId = readBridgeString(base.activeClientId) || DEFAULT_BRIDGE.activeClientId;
  const activeProfile = resolveActiveProfile(profiles, preferredActiveClientId);

  return {
    autoSync: typeof base.autoSync === "boolean" ? base.autoSync : DEFAULT_BRIDGE.autoSync,
    activeClientId: activeProfile.clientId,
    profiles
  };
}

function normalizeBridgeProfiles(rawProfiles, fallbackUrl, fallbackToken) {
  if (!Array.isArray(rawProfiles)) {
    return [createDefaultBridgeProfile(fallbackUrl, fallbackToken)];
  }

  const out = [];
  const seenClientIds = new Set();
  for (const entry of rawProfiles) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const clientId = readBridgeString(entry.clientId);
    if (!clientId || seenClientIds.has(clientId)) {
      continue;
    }

    const url = readBridgeString(entry.url) || fallbackUrl || DEFAULT_BRIDGE_PROFILE.url;
    const wsUrl = readBridgeString(entry.wsUrl) || resolveWebSocketUrl({ url });
    const token = readBridgeString(entry.token) || fallbackToken || DEFAULT_BRIDGE_PROFILE.token;
    const priority = normalizeProfilePriority(entry.priority);
    out.push({
      clientId,
      url,
      wsUrl,
      token,
      enabled: entry.enabled !== false,
      priority
    });
    seenClientIds.add(clientId);
  }

  if (out.length > 0) {
    return out;
  }

  return [createDefaultBridgeProfile(fallbackUrl, fallbackToken)];
}

function ensureProfileForSet(profiles, activeClientId, fallbackUrl, fallbackToken) {
  const exists = profiles.some((profile) => profile.clientId === activeClientId);
  if (exists) {
    return profiles;
  }

  const created = {
    clientId: activeClientId || DEFAULT_BRIDGE_PROFILE.clientId,
    url: fallbackUrl || DEFAULT_BRIDGE_PROFILE.url,
    wsUrl: resolveWebSocketUrl({ url: fallbackUrl || DEFAULT_BRIDGE_PROFILE.url }),
    token: fallbackToken || DEFAULT_BRIDGE_PROFILE.token,
    enabled: true,
    priority: 100
  };
  return [...profiles, created];
}

function resolveActiveProfile(profiles, preferredClientId) {
  const requested = readBridgeString(preferredClientId);
  if (requested) {
    const requestedProfile = profiles.find((profile) => profile.clientId === requested && profile.enabled !== false);
    if (requestedProfile) {
      return requestedProfile;
    }
  }

  const enabledProfiles = profiles.filter((profile) => profile.enabled !== false);
  if (enabledProfiles.length > 0) {
    enabledProfiles.sort((a, b) => b.priority - a.priority);
    return enabledProfiles[0];
  }

  return profiles[0] || createDefaultBridgeProfile(DEFAULT_BRIDGE_PROFILE.url, DEFAULT_BRIDGE_PROFILE.token);
}

function createDefaultBridgeProfile(url, token) {
  return {
    clientId: DEFAULT_BRIDGE_PROFILE.clientId,
    url: readBridgeString(url) || DEFAULT_BRIDGE_PROFILE.url,
    wsUrl: resolveWebSocketUrl({ url: readBridgeString(url) || DEFAULT_BRIDGE_PROFILE.url }),
    token: readBridgeString(token) || DEFAULT_BRIDGE_PROFILE.token,
    enabled: true,
    priority: 100
  };
}

function readBridgeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeProfilePriority(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const n = Math.trunc(value);
  if (n < -1000) {
    return -1000;
  }
  if (n > 1000) {
    return 1000;
  }
  return n;
}

async function ensureAutoSyncAlarm() {
  const config = await getBridgeConfig();
  if (!config.autoSync) {
    await chrome.alarms.clear("local-event-gateway.autoSync");
    return;
  }
  await chrome.alarms.create("local-event-gateway.autoSync", {
    periodInMinutes: 1
  });
}

async function ensureReverseFlushAlarm() {
  await chrome.alarms.create("reverseFlush", {
    periodInMinutes: 0.05
  });
}


// ---------------------------------------------------------------------------
// Managed-ID helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given chrome bookmark id is tracked as a managed bookmark.
 * @param {{ bookmarkIdToManagedKey: object }} state
 * @param {string} id
 * @returns {boolean}
 */
function isManagedBookmarkId(state, id) {
  return getManagedBookmarkKeyById(state, id) !== null;
}

function getManagedBookmarkKeyById(state, id) {
  if (state.bookmarkIdToManagedKey && state.bookmarkIdToManagedKey[id] != null) {
    return state.bookmarkIdToManagedKey[id];
  }

  const mids = state.managedBookmarkIds;
  if (!mids || typeof mids !== "object" || Array.isArray(mids)) {
    return null;
  }

  for (const key in mids) {
    if (mids[key] === id) {
      return key;
    }
  }

  return null;
}

/**
 * Returns true if the given chrome id is tracked as a managed folder.
 * @param {{ managedFolderIds: object }} state
 * @param {string} id
 * @returns {boolean}
 */
function isManagedFolderId(state, id) {
  const fids = state.managedFolderIds;
  if (!fids || typeof fids !== "object" || Array.isArray(fids)) return false;
  for (const key in fids) {
    if (fids[key] === id) return true;
  }
  return false;
}

function getManagedFolderKeyById(state, id) {
  const fids = state.managedFolderIds;
  if (!fids || typeof fids !== "object" || Array.isArray(fids)) {
    return null;
  }
  for (const key in fids) {
    if (key !== "__root__" && fids[key] === id) {
      return key;
    }
  }
  return null;
}

async function resolveFolderNameFromBookmarkId(id) {
  if (!id) {
    return "";
  }

  try {
    const nodes = await chrome.bookmarks.get(id);
    const node = Array.isArray(nodes) ? nodes[0] : undefined;
    if (!node || typeof node.title !== "string") {
      return "";
    }
    return node.title.trim();
  } catch {
    return "";
  }
}

async function resolveLinkIndexWithinParent(parentId, bookmarkId) {
  if (!parentId || !bookmarkId) {
    return undefined;
  }

  try {
    const children = await chrome.bookmarks.getChildren(parentId);
    if (!Array.isArray(children)) {
      return undefined;
    }

    let linkIndex = 0;
    for (const child of children) {
      if (!child || typeof child.id !== "string") {
        continue;
      }

      if (child.url) {
        if (child.id === bookmarkId) {
          return linkIndex;
        }
        linkIndex += 1;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Bookmark import gating
// ---------------------------------------------------------------------------

async function handleImportBegan() {
  const state = await getState();
  state.importInProgress = true;
  rsLog("import_begin", {});
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function handleImportEnded() {
  const state = await getState();
  state.importInProgress = false;
  rsLog("import_end", {});
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  const config = await getBridgeConfig();
  if (config.autoSync) {
    void syncFromBridge().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Bookmark change handlers — filter to managed subtree only
// ---------------------------------------------------------------------------

async function handleBookmarkCreated(id, bookmark) {
  const state = await getState();
  if (state.importInProgress) {
    rsLog("capture_skip", { reason: "import_in_progress", bookmarkId: id, type: "bookmark_created" });
    return;
  }
  if (shouldSuppressReverseEnqueue(state)) {
    rsLog("capture_skip", { reason: "suppressed", bookmarkId: id, type: "bookmark_created" });
    return;
  }
  const parentManaged = bookmark && isManagedFolderId(state, bookmark.parentId);
  const selfManaged = isManagedBookmarkId(state, id);

  let managedKey = getManagedBookmarkKeyById(state, id) || "";
  if (!managedKey && bookmark) {
    const parentKey = getManagedFolderKeyById(state, bookmark.parentId);
    if (parentKey && parentKey.startsWith("note:")) {
      const sourcePath = parentKey.slice("note:".length).trim();
      const createdIndex = Number.isInteger(bookmark.index) && bookmark.index >= 0 ? bookmark.index : 0;
      managedKey = `${sourcePath}|${String(createdIndex)}`;
      updateBookmarkKeyMapping(state, id, managedKey);
    } else if (parentKey && parentKey.startsWith("folder:")) {
      managedKey = parentKey;
      updateBookmarkKeyMapping(state, id, managedKey);
    } else {
      const parentName = await resolveFolderNameFromBookmarkId(bookmark.parentId);
      if (parentName) {
        managedKey = `folder:${parentName}`;
        updateBookmarkKeyMapping(state, id, managedKey);
      }
    }
  }

  if (!managedKey) {
    managedKey = `bookmark:${id}`;
  }

  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_created",
    bookmarkId: id,
    managedKey,
    title: bookmark ? bookmark.title : undefined,
    url: bookmark ? bookmark.url : undefined,
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function handleBookmarkChanged(id, changeInfo) {
  const state = await getState();
  if (shouldSuppressReverseEnqueue(state)) {
    rsLog("capture_skip", { reason: "suppressed", bookmarkId: id, type: "bookmark_changed" });
    return;
  }
  const bookmarkKey = getManagedBookmarkKeyById(state, id);
  const folderKey = getManagedFolderKeyById(state, id);
  const fallbackKey = !bookmarkKey && !folderKey ? `bookmark:${id}` : "";

  const isFolderRename = !bookmarkKey && Boolean(folderKey);
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: isFolderRename ? "folder_renamed" : "bookmark_updated",
    bookmarkId: id,
    managedKey: bookmarkKey || folderKey || fallbackKey,
    title: changeInfo ? changeInfo.title : undefined,
    url: isFolderRename ? undefined : (changeInfo ? changeInfo.url : undefined),
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function handleBookmarkRemoved(id, removeInfo) {
  const state = await getState();
  if (shouldSuppressReverseEnqueue(state)) {
    rsLog("capture_skip", { reason: "suppressed", bookmarkId: id, type: "bookmark_removed" });
    return;
  }
  const managedKey = getManagedBookmarkKeyById(state, id);
  const resolvedManagedKey = managedKey || `bookmark:${id}`;
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_deleted",
    bookmarkId: id,
    managedKey: resolvedManagedKey,
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function handleBookmarkMoved(id, moveInfo) {
  const state = await getState();
  if (shouldSuppressReverseEnqueue(state)) {
    rsLog("capture_skip", { reason: "suppressed", bookmarkId: id, type: "bookmark_moved" });
    return;
  }
  const managedKey = getManagedBookmarkKeyById(state, id);
  const resolvedManagedKey = managedKey || `bookmark:${id}`;
  const sameParentMove = Boolean(
    moveInfo
    && typeof moveInfo.parentId === "string"
    && typeof moveInfo.oldParentId === "string"
    && moveInfo.parentId === moveInfo.oldParentId
  );
  const moveIndex = sameParentMove
    ? await resolveLinkIndexWithinParent(moveInfo.parentId, id)
    : undefined;
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_updated",
    bookmarkId: id,
    managedKey: resolvedManagedKey,
    parentId: moveInfo ? moveInfo.parentId : undefined,
    moveIndex,
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}
