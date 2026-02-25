const STORAGE_KEY = "local_event_gateway_state";
const BRIDGE_CONFIG_KEY = "local_event_gateway_bridge";
const DEFAULT_BRIDGE = {
  url: "http://127.0.0.1:27123/payload",
  token: "project2chrome-local",
  autoSync: true
};

/**
 * Structured audit logger for reverse-sync pipeline events.
 * Emits redact-safe JSON to console — never logs token values or full note content.
 * @param {string} event - event name: 'enqueue' | 'flush' | 'ack' | 'error'
 * @param {object} data - event-specific fields (no token/secret values)
 */
function rsLog(event, data) {
  console.log(JSON.stringify({ ts: Date.now(), event, ...data }));
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
  await ensureAutoSyncAlarm();
  await ensureReverseFlushAlarm();
  scheduleReverseFlushSoon();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureBridgeConfig();
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
  const response = await fetch(config.url, {
    method: "GET",
    headers: {
      "X-Project2Chrome-Token": config.token
    }
  });
  if (!response.ok) {
    throw new Error(`Bridge fetch failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  return syncFromPayload(payload);
}

async function syncFromPayload(payload) {
  const rootFolderName = (payload?.rootFolderName || "Projects").trim() || "Projects";
  const desired = Array.isArray(payload?.desired) ? payload.desired : [];

  const state = await getState();
  const rootId = await ensureRootFolder(rootFolderName, state);
  await clearManagedTree(rootId, state);
  const nextState = {
    managedFolderIds: { __root__: rootId },
    managedBookmarkIds: {},
    reverseQueue: state.reverseQueue,
    bookmarkIdToManagedKey: state.bookmarkIdToManagedKey,
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
 * @returns {{ managedFolderIds: object, managedBookmarkIds: object, reverseQueue: Array, bookmarkIdToManagedKey: object, suppressionState: { applyEpoch: boolean, epochStartedAt: string|null, cooldownUntil: string|null }, importInProgress: boolean }}
 */
function migrateState(raw) {
  const base = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const sup = (base.suppressionState && typeof base.suppressionState === "object" && !Array.isArray(base.suppressionState))
    ? base.suppressionState
    : {};
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
      cooldownUntil: sup.cooldownUntil ?? null
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
  rsLog('flush', { batchId, count });

  const payload = {
    batchId,
    events: coalescedItems.map((item) => item.event),
    sentAt: new Date().toISOString()
  };

  try {
    const response = await fetch(`${bridgeUrl}/reverse-sync`, {
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
  const ackedEventIds = [];
  for (const result of ackResponse.results) {
    rsLog('ack', { batchId: ackResponse.batchId, eventId: result.eventId, status: result.status });
    ackedEventIds.push(result.eventId);
  }
  dequeueAckedEvents(state, ackedEventIds);
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
 * @param {{ suppressionState: { applyEpoch: boolean, epochStartedAt: string|null, cooldownUntil: string|null } }} state
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
  return Boolean(state.bookmarkIdToManagedKey && state.bookmarkIdToManagedKey[id] != null);
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

// ---------------------------------------------------------------------------
// Bookmark import gating
// ---------------------------------------------------------------------------

async function handleImportBegan() {
  const state = await getState();
  state.importInProgress = true;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function handleImportEnded() {
  const state = await getState();
  state.importInProgress = false;
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
  if (state.importInProgress) return;
  const parentManaged = bookmark && isManagedFolderId(state, bookmark.parentId);
  const selfManaged = isManagedBookmarkId(state, id);
  if (!selfManaged && !parentManaged) return;
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_created",
    bookmarkId: id,
    managedKey: (state.bookmarkIdToManagedKey && state.bookmarkIdToManagedKey[id]) || "",
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
  if (!isManagedBookmarkId(state, id)) return;
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_updated",
    bookmarkId: id,
    managedKey: (state.bookmarkIdToManagedKey && state.bookmarkIdToManagedKey[id]) || "",
    title: changeInfo ? changeInfo.title : undefined,
    url: changeInfo ? changeInfo.url : undefined,
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function handleBookmarkRemoved(id, removeInfo) {
  const state = await getState();
  const isBookmark = isManagedBookmarkId(state, id);
  const isFolder = isManagedFolderId(state, id);
  if (!isBookmark && !isFolder) return;
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_deleted",
    bookmarkId: id,
    managedKey: (state.bookmarkIdToManagedKey && state.bookmarkIdToManagedKey[id]) || "",
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function handleBookmarkMoved(id, moveInfo) {
  const state = await getState();
  const isBookmark = isManagedBookmarkId(state, id);
  const isFolder = isManagedFolderId(state, id);
  if (!isBookmark && !isFolder) return;
  const event = {
    batchId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: "bookmark_updated",
    bookmarkId: id,
    managedKey: (state.bookmarkIdToManagedKey && state.bookmarkIdToManagedKey[id]) || "",
    occurredAt: new Date().toISOString(),
    schemaVersion: "1"
  };
  enqueueReverseEvent(state, event);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}
