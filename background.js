const STORAGE_KEY = "local_event_gateway_state";
const BRIDGE_CONFIG_KEY = "local_event_gateway_bridge";
const DEBUG_STATE_KEY = "local_event_gateway_debug";
const DEBUG_MAX_EVENTS = 200;
const DEFAULT_BRIDGE = {
  url: "http://127.0.0.1:27123/payload",
  token: "project2chrome-local",
  autoSync: true
};
const DEFAULT_DEBUG_STATE = {
  enabled: true,
  showInfoBadge: false,
  events: []
};

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
  await ensureAutoSyncAlarm();
  await ensureReverseFlushAlarm();
  scheduleReverseFlushSoon();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureBridgeConfig();
  await ensureDebugState();
  await ensureAutoSyncAlarm();
  await ensureReverseFlushAlarm();
  scheduleReverseFlushSoon();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reverseFlush") {
    void runReverseFlush().catch(() => {});
    return;
  }

  if (alarm.name !== "local-event-gateway.autoSync") {
    return;
  }
  void syncFromBridge().catch(() => {});
});

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
    await flushReverseQueue(state, config.url, config.token);
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
  const config = await getBridgeConfig();
  rsLog("sync_start", { url: config.url });
  const response = await fetch(config.url, {
    method: "GET",
    headers: {
      "X-Project2Chrome-Token": config.token
    }
  });
  if (!response.ok) {
    rsLog("sync_error", { reason: `bridge_http_${response.status}` });
    throw new Error(`Bridge fetch failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const result = await syncFromPayload(payload);
  rsLog("sync_done", { folderCount: Array.isArray(payload?.desired) ? payload.desired.length : 0 });
  return result;
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
    importInProgress: base.importInProgress === true
  };
}

/**
 * Adds a ReverseEvent to the durable reverse queue with retryCount 0.
 * Mutates state in place — caller must persist to chrome.storage.local.
 * @param {{ reverseQueue: Array }} state
 * @param {ReverseEvent} event
 */
function enqueueReverseEvent(state, event) {
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
  const existing = await chrome.storage.local.get(BRIDGE_CONFIG_KEY);
  if (!existing?.[BRIDGE_CONFIG_KEY]) {
    await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: DEFAULT_BRIDGE });
  }
}

async function getBridgeConfig() {
  const raw = await chrome.storage.local.get(BRIDGE_CONFIG_KEY);
  const config = raw?.[BRIDGE_CONFIG_KEY] || DEFAULT_BRIDGE;
  return {
    url: typeof config.url === "string" && config.url.length > 0 ? config.url : DEFAULT_BRIDGE.url,
    token: typeof config.token === "string" && config.token.length > 0 ? config.token : DEFAULT_BRIDGE.token,
    autoSync: Boolean(config.autoSync)
  };
}

async function setBridgeConfig(input) {
  const current = await getBridgeConfig();
  const next = {
    url: typeof input?.url === "string" && input.url.trim().length > 0 ? input.url.trim() : current.url,
    token: typeof input?.token === "string" && input.token.trim().length > 0 ? input.token.trim() : current.token,
    autoSync: typeof input?.autoSync === "boolean" ? input.autoSync : current.autoSync
  };
  await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: next });
  return next;
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
    rsLog("capture_skip", { reason: "missing_managed_key", bookmarkId: id, type: "bookmark_created" });
    return;
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
  if (!bookmarkKey && !folderKey) {
    rsLog("capture_skip", { reason: "unmanaged", bookmarkId: id, type: "bookmark_changed" });
    return;
  }

  const isFolderRename = !bookmarkKey && Boolean(folderKey);
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: isFolderRename ? "folder_renamed" : "bookmark_updated",
    bookmarkId: id,
    managedKey: bookmarkKey || folderKey || "",
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
  if (!managedKey) {
    rsLog("capture_skip", { reason: "unmanaged", bookmarkId: id, type: "bookmark_removed" });
    return;
  }
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_deleted",
    bookmarkId: id,
    managedKey,
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
  if (!managedKey) {
    rsLog("capture_skip", { reason: "unmanaged", bookmarkId: id, type: "bookmark_moved" });
    return;
  }
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_updated",
    bookmarkId: id,
    managedKey,
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}
