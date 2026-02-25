"use strict";

const assert = require("node:assert/strict");
const { describe, it, before } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// ---------------------------------------------------------------------------
// Load background.js into a VM context with a minimal mock chrome global.
// Storage reads/writes use a shared mutable stateStore so each test can set
// the initial state before invoking a handler.
//
// NOTE on cross-realm safety: values produced inside the VM (arrays, objects)
// have VM-realm prototypes. assert.deepStrictEqual checks prototype chains, so
// comparing VM-realm [] with main-realm [] would fail. All assertions below
// use realm-safe checks (length, indexing, scalar equality).
// ---------------------------------------------------------------------------

const SRC = readFileSync(path.join(__dirname, "background.js"), "utf8");
const STORAGE_KEY = "local_event_gateway_state";

/** Shared mutable store — set .state before each test */
const stateStore = { state: null };

function makeMockChrome() {
  return {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    alarms: {
      onAlarm: { addListener() {} },
      clear() { return Promise.resolve(); },
      create() { return Promise.resolve(); }
    },
    storage: {
      local: {
        get(key) {
          const k = typeof key === "string" ? key : Object.keys(key)[0];
          if (k === STORAGE_KEY) {
            return Promise.resolve({ [STORAGE_KEY]: stateStore.state });
          }
          // All other keys (e.g. bridge config) return empty → caller uses defaults
          return Promise.resolve({});
        },
        set(obj) {
          if (Object.prototype.hasOwnProperty.call(obj, STORAGE_KEY)) {
            stateStore.state = obj[STORAGE_KEY];
          }
          return Promise.resolve();
        }
      }
    },
    bookmarks: {
      onCreated: { addListener() {} },
      onChanged: { addListener() {} },
      onRemoved: { addListener() {} },
      onMoved: { addListener() {} },
      onImportBegan: { addListener() {} },
      onImportEnded: { addListener() {} },
      get() { return Promise.resolve([]); },
      getChildren() { return Promise.resolve([]); },
      getTree() { return Promise.resolve([{ children: [{ id: "1", children: [] }] }]); }
    }
  };
}

/** @type {Record<string, Function>} */
let bg;

before(() => {
  const ctx = {
    chrome: makeMockChrome(),
    console,
    crypto: { randomUUID },
    // Prevent syncFromBridge() from making real HTTP calls in handleImportEnded;
    // the void .catch(() => {}) in handleImportEnded swallows this rejection.
    fetch: () => Promise.reject(new Error("mock: fetch unavailable in test"))
  };
  runInNewContext(SRC, ctx);
  bg = ctx;
});

// ---------------------------------------------------------------------------
// Helper: build a typical managed state object (main-realm, migrateState-safe)
// ---------------------------------------------------------------------------
function managedState(overrides) {
  return Object.assign(
    {
      managedFolderIds: { "__root__": "100", "folder:Projects": "101" },
      managedBookmarkIds: { "note:Projects/Alpha": "bk1" },
      bookmarkIdToManagedKey: { "bk1": "note:Projects/Alpha" },
      reverseQueue: [],
      suppressionState: { applyEpoch: false, epochStartedAt: null, cooldownUntil: null },
      importInProgress: false
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// handleBookmarkCreated
// ---------------------------------------------------------------------------

describe("handleBookmarkCreated – managed parent folder", () => {
  it("enqueues bookmark_created event with correct shape when parent is a managed folder", async () => {
    stateStore.state = managedState();

    await bg.handleBookmarkCreated("bk-new", {
      title: "New Link",
      url: "https://example.com/new",
      parentId: "101"
    });

    assert.equal(stateStore.state.reverseQueue.length, 1);
    const item = stateStore.state.reverseQueue[0];
    assert.equal(item.event.type, "bookmark_created");
    assert.equal(item.event.bookmarkId, "bk-new");
    assert.equal(item.event.title, "New Link");
    assert.equal(item.event.url, "https://example.com/new");
    assert.equal(item.event.schemaVersion, "1");
    assert.ok(typeof item.event.batchId === "string" && item.event.batchId.length > 0,
      "batchId should be a non-empty string");
    assert.ok(typeof item.event.eventId === "string" && item.event.eventId.length > 0,
      "eventId should be a non-empty string");
    assert.ok(typeof item.event.occurredAt === "string" && item.event.occurredAt.length > 0,
      "occurredAt should be a non-empty ISO string");
    assert.equal(item.retryCount, 0);
  });

  it("does NOT enqueue when parent folder is unmanaged", async () => {
    stateStore.state = managedState();

    await bg.handleBookmarkCreated("bk-unmanaged", {
      title: "Unrelated",
      url: "https://example.com/other",
      parentId: "999"   // not in managedFolderIds values
    });

    assert.equal(stateStore.state.reverseQueue.length, 0);
  });

  it("does NOT enqueue during active import window (importInProgress = true)", async () => {
    stateStore.state = managedState({ importInProgress: true });

    await bg.handleBookmarkCreated("bk-import", {
      title: "Import Bookmark",
      url: "https://example.com/import",
      parentId: "101"
    });

    assert.equal(stateStore.state.reverseQueue.length, 0);
  });
});

// ---------------------------------------------------------------------------
// handleBookmarkChanged
// ---------------------------------------------------------------------------

describe("handleBookmarkChanged – managed bookmark", () => {
  it("enqueues bookmark_updated event for managed bookmark id", async () => {
    stateStore.state = managedState();

    await bg.handleBookmarkChanged("bk1", {
      title: "Updated Title",
      url: "https://example.com/updated"
    });

    assert.equal(stateStore.state.reverseQueue.length, 1);
    const item = stateStore.state.reverseQueue[0];
    assert.equal(item.event.type, "bookmark_updated");
    assert.equal(item.event.bookmarkId, "bk1");
    assert.equal(item.event.managedKey, "note:Projects/Alpha");
    assert.equal(item.event.schemaVersion, "1");
  });

  it("does NOT enqueue for unmanaged bookmark id", async () => {
    stateStore.state = managedState();

    await bg.handleBookmarkChanged("bk-unmanaged-99", {
      title: "Other",
      url: "https://other.com"
    });

    assert.equal(stateStore.state.reverseQueue.length, 0);
  });
});

// ---------------------------------------------------------------------------
// handleBookmarkRemoved
// ---------------------------------------------------------------------------

describe("handleBookmarkRemoved – managed bookmark", () => {
  it("enqueues bookmark_deleted event for managed bookmark id", async () => {
    stateStore.state = managedState();

    await bg.handleBookmarkRemoved("bk1", { parentId: "101", index: 0 });

    assert.equal(stateStore.state.reverseQueue.length, 1);
    const item = stateStore.state.reverseQueue[0];
    assert.equal(item.event.type, "bookmark_deleted");
    assert.equal(item.event.bookmarkId, "bk1");
    assert.equal(item.event.managedKey, "note:Projects/Alpha");
    assert.equal(item.event.schemaVersion, "1");
  });

  it("does NOT enqueue for unmanaged id", async () => {
    stateStore.state = managedState();

    await bg.handleBookmarkRemoved("bk-not-managed", {});

    assert.equal(stateStore.state.reverseQueue.length, 0);
  });
});

// ---------------------------------------------------------------------------
// handleImportBegan / handleImportEnded
// ---------------------------------------------------------------------------

describe("handleImportBegan", () => {
  it("sets importInProgress = true in persisted state", async () => {
    stateStore.state = managedState({ importInProgress: false });

    await bg.handleImportBegan();

    assert.equal(stateStore.state.importInProgress, true);
  });
});

describe("handleImportEnded", () => {
  it("clears importInProgress to false in persisted state", async () => {
    stateStore.state = managedState({ importInProgress: true });

    await bg.handleImportEnded();

    assert.equal(stateStore.state.importInProgress, false);
  });
});
