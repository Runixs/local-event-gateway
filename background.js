const STORAGE_KEY = "local_event_gateway_state";
const BRIDGE_CONFIG_KEY = "local_event_gateway_bridge";
const DEFAULT_BRIDGE = {
  url: "http://127.0.0.1:27123/payload",
  token: "project2chrome-local",
  autoSync: true
};

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
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureBridgeConfig();
  await ensureAutoSyncAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "local-event-gateway.autoSync") {
    return;
  }
  void syncFromBridge().catch(() => {});
});

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
    managedBookmarkIds: {}
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
  const state = raw?.[STORAGE_KEY];
  if (!state || typeof state !== "object") {
    return { managedFolderIds: {}, managedBookmarkIds: {} };
  }
  return {
    managedFolderIds: state.managedFolderIds || {},
    managedBookmarkIds: state.managedBookmarkIds || {}
  };
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
