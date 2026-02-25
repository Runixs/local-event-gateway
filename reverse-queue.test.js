"use strict";

const assert = require("node:assert/strict");
const { describe, it, before } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Load background.js into a VM context with a minimal mock chrome global.
// This avoids any real chrome.* calls while making all pure functions visible.
//
// NOTE on cross-realm safety: values produced inside the VM (arrays, objects)
// have VM-realm prototypes. assert.deepStrictEqual checks prototype chains, so
// comparing VM-realm [] with main-realm [] would fail. All assertions below
// use realm-safe checks (length, indexing, JSON.stringify, scalar equality).
// ---------------------------------------------------------------------------

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
        get() { return Promise.resolve({}); },
        set() { return Promise.resolve(); }
      }
    },
    bookmarks: {}
  };
}

/** @type {Record<string, Function>} */
let bg;

before(() => {
  const src = readFileSync(path.join(__dirname, "background.js"), "utf8");
  const ctx = { chrome: makeMockChrome(), console };
  runInNewContext(src, ctx);
  bg = ctx;
});

// Realm-safe helpers
function keys(obj) { return Object.keys(obj); }
function toJSON(v) { return JSON.stringify(v); }

// ---------------------------------------------------------------------------
// migrateState
// ---------------------------------------------------------------------------

describe("migrateState – legacy state migration", () => {
  it("preserves managedFolderIds from old state without data loss", () => {
    const old = {
      managedFolderIds: { __root__: "10", "folder:Projects/Alpha": "11" },
      managedBookmarkIds: { "note:Projects/Alpha/Foo": "99" }
    };
    const result = bg.migrateState(old);
    assert.equal(result.managedFolderIds["__root__"], "10");
    assert.equal(result.managedFolderIds["folder:Projects/Alpha"], "11");
  });

  it("preserves managedBookmarkIds from old state without data loss", () => {
    const old = { managedFolderIds: {}, managedBookmarkIds: { "note:Projects/Alpha/Foo": "99" } };
    const result = bg.migrateState(old);
    assert.equal(result.managedBookmarkIds["note:Projects/Alpha/Foo"], "99");
  });

  it("adds reverseQueue as empty array when field is absent", () => {
    const result = bg.migrateState({ managedFolderIds: {}, managedBookmarkIds: {} });
    assert.ok(Array.isArray(result.reverseQueue), "reverseQueue should be an array");
    assert.equal(result.reverseQueue.length, 0);
  });

  it("adds bookmarkIdToManagedKey as empty object when field is absent", () => {
    const result = bg.migrateState({ managedFolderIds: {}, managedBookmarkIds: {} });
    assert.equal(typeof result.bookmarkIdToManagedKey, "object");
    assert.equal(result.bookmarkIdToManagedKey === null, false);
    assert.equal(keys(result.bookmarkIdToManagedKey).length, 0);
  });

  it("adds suppressionState with applyEpoch=false, null timestamps when absent", () => {
    const result = bg.migrateState({ managedFolderIds: {}, managedBookmarkIds: {} });
    assert.equal(result.suppressionState.applyEpoch, false);
    assert.equal(result.suppressionState.epochStartedAt, null);
    assert.equal(result.suppressionState.cooldownUntil, null);
  });

  it("does not overwrite existing reverseQueue items", () => {
    const existing = [{ event: { eventId: "e1" }, retryCount: 0, enqueuedAt: "2026-01-01T00:00:00.000Z" }];
    const result = bg.migrateState({ reverseQueue: existing });
    assert.equal(result.reverseQueue.length, 1);
    assert.equal(result.reverseQueue[0].event.eventId, "e1");
  });

  it("does not overwrite existing bookmarkIdToManagedKey entries", () => {
    const result = bg.migrateState({ bookmarkIdToManagedKey: { "bk42": "note:Projects/Foo" } });
    assert.equal(result.bookmarkIdToManagedKey["bk42"], "note:Projects/Foo");
  });

  it("handles null input without throwing", () => {
    const result = bg.migrateState(null);
    assert.equal(keys(result.managedFolderIds).length, 0);
    assert.equal(keys(result.managedBookmarkIds).length, 0);
    assert.equal(result.reverseQueue.length, 0);
    assert.equal(result.suppressionState.applyEpoch, false);
    assert.equal(result.suppressionState.epochStartedAt, null);
  });

  it("handles undefined input without throwing", () => {
    const result = bg.migrateState(undefined);
    assert.equal(result.reverseQueue.length, 0);
    assert.equal(keys(result.managedFolderIds).length, 0);
  });

  it("handles a plain string input without throwing", () => {
    const result = bg.migrateState("corrupted");
    assert.equal(keys(result.managedFolderIds).length, 0);
    assert.equal(result.reverseQueue.length, 0);
  });

  it("handles array input (corrupted state) without throwing", () => {
    const result = bg.migrateState([{ foo: "bar" }]);
    assert.equal(keys(result.managedFolderIds).length, 0);
    assert.equal(result.reverseQueue.length, 0);
  });

  it("treats managedFolderIds: null as empty object", () => {
    const result = bg.migrateState({ managedFolderIds: null, managedBookmarkIds: null });
    assert.equal(keys(result.managedFolderIds).length, 0);
    assert.equal(keys(result.managedBookmarkIds).length, 0);
  });

  it("treats reverseQueue: null as empty array", () => {
    const result = bg.migrateState({ reverseQueue: null });
    assert.ok(Array.isArray(result.reverseQueue));
    assert.equal(result.reverseQueue.length, 0);
  });

  it("preserves partial suppressionState fields safely", () => {
    const result = bg.migrateState({
      suppressionState: { applyEpoch: true, epochStartedAt: "2026-02-25T10:00:00.000Z" }
    });
    assert.equal(result.suppressionState.applyEpoch, true);
    assert.equal(result.suppressionState.epochStartedAt, "2026-02-25T10:00:00.000Z");
    assert.equal(result.suppressionState.cooldownUntil, null);
  });
});

// ---------------------------------------------------------------------------
// enqueueReverseEvent
// ---------------------------------------------------------------------------

describe("enqueueReverseEvent", () => {
  function makeEvent(overrides) {
    return Object.assign({
      batchId: "batch-1",
      eventId: "evt-1",
      type: "bookmark_created",
      bookmarkId: "bk1",
      managedKey: "note:Projects/Alpha",
      occurredAt: "2026-02-25T00:00:00.000Z",
      schemaVersion: "1"
    }, overrides);
  }

  it("adds item with retryCount 0 and enqueuedAt ISO timestamp", () => {
    const state = bg.migrateState(null);
    const event = makeEvent({ eventId: "evt-10" });
    const before = Date.now();
    bg.enqueueReverseEvent(state, event);
    const after = Date.now();

    assert.equal(state.reverseQueue.length, 1);
    const item = state.reverseQueue[0];
    assert.equal(item.retryCount, 0);
    assert.equal(item.event.eventId, "evt-10");
    const ts = new Date(item.enqueuedAt).getTime();
    assert.ok(ts >= before && ts <= after, "enqueuedAt should be a recent ISO timestamp");
  });

  it("appends multiple events in order", () => {
    const state = bg.migrateState(null);
    bg.enqueueReverseEvent(state, makeEvent({ eventId: "evt-a" }));
    bg.enqueueReverseEvent(state, makeEvent({ eventId: "evt-b" }));
    bg.enqueueReverseEvent(state, makeEvent({ eventId: "evt-c" }));
    assert.equal(state.reverseQueue.length, 3);
    assert.equal(state.reverseQueue[0].event.eventId, "evt-a");
    assert.equal(state.reverseQueue[2].event.eventId, "evt-c");
  });

  it("stores the full event object intact", () => {
    const state = bg.migrateState(null);
    const event = makeEvent({ eventId: "evt-full", title: "My Bookmark", url: "https://example.com", parentId: "fld1" });
    bg.enqueueReverseEvent(state, event);
    const stored = state.reverseQueue[0].event;
    assert.equal(stored.eventId, "evt-full");
    assert.equal(stored.title, "My Bookmark");
    assert.equal(stored.url, "https://example.com");
    assert.equal(stored.parentId, "fld1");
    assert.equal(stored.managedKey, "note:Projects/Alpha");
  });
});

// ---------------------------------------------------------------------------
// dequeueAckedEvents
// ---------------------------------------------------------------------------

describe("dequeueAckedEvents", () => {
  function seedQueue(state, ids) {
    for (const id of ids) {
      state.reverseQueue.push({ event: { eventId: id }, retryCount: 0, enqueuedAt: "" });
    }
  }

  it("removes only events with matching eventIds", () => {
    const state = bg.migrateState(null);
    seedQueue(state, ["e1", "e2", "e3", "e4"]);
    bg.dequeueAckedEvents(state, ["e1", "e3"]);
    assert.equal(state.reverseQueue.length, 2);
    assert.equal(state.reverseQueue[0].event.eventId, "e2");
    assert.equal(state.reverseQueue[1].event.eventId, "e4");
  });

  it("leaves queue unchanged when no ids match", () => {
    const state = bg.migrateState(null);
    seedQueue(state, ["e1", "e2"]);
    bg.dequeueAckedEvents(state, ["e9", "e99"]);
    assert.equal(state.reverseQueue.length, 2);
  });

  it("clears entire queue when all ids are acked", () => {
    const state = bg.migrateState(null);
    seedQueue(state, ["e1", "e2", "e3"]);
    bg.dequeueAckedEvents(state, ["e1", "e2", "e3"]);
    assert.equal(state.reverseQueue.length, 0);
  });

  it("handles empty ackedEventIds without error", () => {
    const state = bg.migrateState(null);
    seedQueue(state, ["e1"]);
    bg.dequeueAckedEvents(state, []);
    assert.equal(state.reverseQueue.length, 1);
  });

  it("handles empty queue without error", () => {
    const state = bg.migrateState(null);
    bg.dequeueAckedEvents(state, ["e1"]);
    assert.equal(state.reverseQueue.length, 0);
  });

  it("removes all items sharing the same eventId when that id is acked", () => {
    const state = bg.migrateState(null);
    seedQueue(state, ["e1", "e1", "e2"]);
    bg.dequeueAckedEvents(state, ["e1"]);
    assert.equal(state.reverseQueue.length, 1);
    assert.equal(state.reverseQueue[0].event.eventId, "e2");
  });
});

// ---------------------------------------------------------------------------
// updateBookmarkKeyMapping
// ---------------------------------------------------------------------------

describe("updateBookmarkKeyMapping", () => {
  it("stores bookmarkId -> managedKey in the reverse lookup map", () => {
    const state = bg.migrateState(null);
    bg.updateBookmarkKeyMapping(state, "bk42", "note:Projects/Alpha");
    assert.equal(state.bookmarkIdToManagedKey["bk42"], "note:Projects/Alpha");
  });

  it("overwrites an existing entry for the same bookmarkId", () => {
    const state = bg.migrateState(null);
    bg.updateBookmarkKeyMapping(state, "bk42", "note:Projects/Alpha");
    bg.updateBookmarkKeyMapping(state, "bk42", "note:Projects/Beta");
    assert.equal(state.bookmarkIdToManagedKey["bk42"], "note:Projects/Beta");
  });

  it("stores multiple independent mappings", () => {
    const state = bg.migrateState(null);
    bg.updateBookmarkKeyMapping(state, "bk1", "note:A");
    bg.updateBookmarkKeyMapping(state, "bk2", "note:B");
    assert.equal(state.bookmarkIdToManagedKey["bk1"], "note:A");
    assert.equal(state.bookmarkIdToManagedKey["bk2"], "note:B");
  });

  it("does not mutate unrelated state fields", () => {
    const state = bg.migrateState({ managedFolderIds: { __root__: "5" } });
    bg.updateBookmarkKeyMapping(state, "bk1", "note:X");
    assert.equal(state.managedFolderIds["__root__"], "5");
    assert.equal(keys(state.managedFolderIds).length, 1);
  });
});

// ---------------------------------------------------------------------------
// setApplyEpoch
// ---------------------------------------------------------------------------

describe("setApplyEpoch", () => {
  it("sets applyEpoch=true and records epochStartedAt when activated", () => {
    const state = bg.migrateState(null);
    const before = Date.now();
    bg.setApplyEpoch(state, true);
    const after = Date.now();

    assert.equal(state.suppressionState.applyEpoch, true);
    assert.notEqual(state.suppressionState.epochStartedAt, null);
    const ts = new Date(state.suppressionState.epochStartedAt).getTime();
    assert.ok(ts >= before && ts <= after, "epochStartedAt should be a recent timestamp");
  });

  it("sets applyEpoch=false and clears epochStartedAt when deactivated", () => {
    const state = bg.migrateState(null);
    bg.setApplyEpoch(state, true);
    bg.setApplyEpoch(state, false);

    assert.equal(state.suppressionState.applyEpoch, false);
    assert.equal(state.suppressionState.epochStartedAt, null);
  });

  it("also clears cooldownUntil when deactivated", () => {
    const state = bg.migrateState({
      suppressionState: {
        applyEpoch: true,
        epochStartedAt: "2026-02-25T10:00:00.000Z",
        cooldownUntil: "2026-02-25T10:05:00.000Z"
      }
    });
    bg.setApplyEpoch(state, false);
    assert.equal(state.suppressionState.cooldownUntil, null);
  });

  it("does not clear cooldownUntil when activating", () => {
    const state = bg.migrateState({
      suppressionState: {
        applyEpoch: false,
        epochStartedAt: null,
        cooldownUntil: "2026-02-25T10:05:00.000Z"
      }
    });
    bg.setApplyEpoch(state, true);
    assert.equal(state.suppressionState.cooldownUntil, "2026-02-25T10:05:00.000Z");
  });

  it("calling activate twice overwrites epochStartedAt with a fresh timestamp", (_, done) => {
    const state = bg.migrateState(null);
    bg.setApplyEpoch(state, true);
    const first = state.suppressionState.epochStartedAt;
    setTimeout(() => {
      bg.setApplyEpoch(state, true);
      const second = state.suppressionState.epochStartedAt;
      assert.ok(new Date(second).getTime() >= new Date(first).getTime());
      done();
    }, 2);
  });

  it("does not mutate unrelated state fields", () => {
    const state = bg.migrateState({ managedFolderIds: { __root__: "7" } });
    bg.setApplyEpoch(state, true);
    assert.equal(state.managedFolderIds["__root__"], "7");
  });
});
