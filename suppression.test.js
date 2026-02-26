"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SRC = readFileSync(path.join(__dirname, "background.js"), "utf8");
const STORAGE_KEY = "local_event_gateway_state";

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
      onImportEnded: { addListener() {} }
    }
  };
}

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

function loadBackground() {
  const ctx = {
    chrome: makeMockChrome(),
    console,
    crypto: { randomUUID },
    fetch: () => Promise.reject(new Error("mock: fetch unavailable in test"))
  };
  runInNewContext(SRC, ctx);
  return ctx;
}

describe("suppression around payload apply and reverse writeback", () => {
  let bg;

  beforeEach(() => {
    bg = loadBackground();
  });

  it("does not enqueue bookmark event during applyEpoch=true", async () => {
    stateStore.state = managedState({
      suppressionState: { applyEpoch: true, epochStartedAt: "2026-02-25T10:00:00.000Z", cooldownUntil: null }
    });

    await bg.handleBookmarkChanged("bk1", {
      title: "Updated",
      url: "https://example.com/updated"
    });

    assert.equal(stateStore.state.reverseQueue.length, 0);
  });

  it("enqueues bookmark event when applyEpoch=false", async () => {
    stateStore.state = managedState({
      suppressionState: { applyEpoch: false, epochStartedAt: null, cooldownUntil: null }
    });

    await bg.handleBookmarkChanged("bk1", {
      title: "Updated",
      url: "https://example.com/updated"
    });

    assert.equal(stateStore.state.reverseQueue.length, 1);
    assert.equal(stateStore.state.reverseQueue[0].event.type, "bookmark_updated");
  });

  it("does not enqueue bookmark event during cooldown window", async () => {
    stateStore.state = managedState({
      suppressionState: { applyEpoch: false, epochStartedAt: null, cooldownUntil: Date.now() + 2500 }
    });

    await bg.handleBookmarkChanged("bk1", {
      title: "Updated",
      url: "https://example.com/updated"
    });

    assert.equal(stateStore.state.reverseQueue.length, 0);
  });

  it("enqueues bookmark event after cooldown expires", async () => {
    stateStore.state = managedState({
      suppressionState: { applyEpoch: false, epochStartedAt: null, cooldownUntil: Date.now() - 1 }
    });

    await bg.handleBookmarkChanged("bk1", {
      title: "Updated",
      url: "https://example.com/updated"
    });

    assert.equal(stateStore.state.reverseQueue.length, 1);
    assert.equal(stateStore.state.reverseQueue[0].event.type, "bookmark_updated");
  });

  it("setApplyEpoch(false) clears applyEpoch and timestamps", () => {
    const state = bg.migrateState({
      suppressionState: {
        applyEpoch: true,
        epochStartedAt: "2026-02-25T10:00:00.000Z",
        cooldownUntil: Date.now() + 5000
      }
    });

    bg.setApplyEpoch(state, false);

    assert.equal(state.suppressionState.applyEpoch, false);
    assert.equal(state.suppressionState.epochStartedAt, null);
    assert.equal(state.suppressionState.cooldownUntil, null);
  });

  it("migrateState defaults applyEpoch=false when suppression state is absent", () => {
    const migrated = bg.migrateState({});
    assert.equal(migrated.suppressionState.applyEpoch, false);
  });
});
