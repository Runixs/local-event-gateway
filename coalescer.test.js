"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STORAGE_KEY = "local_event_gateway_state";
const SRC = readFileSync(path.join(__dirname, "background.js"), "utf8");

function createHarness() {
  const storageWrites = [];
  const logs = [];
  const stateStore = { state: null };

  const chrome = {
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
          if (key === STORAGE_KEY) {
            return Promise.resolve({ [STORAGE_KEY]: stateStore.state });
          }
          return Promise.resolve({});
        },
        set(obj) {
          storageWrites.push(obj);
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

  const fetchCalls = [];
  let fetchImpl = async () => ({ ok: true, json: async () => ({ batchId: "x", results: [] }) });

  const ctx = {
    chrome,
    crypto: { randomUUID },
    console: {
      log(message) {
        logs.push(String(message));
      }
    },
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetchImpl(...args);
    },
    setTimeout,
    clearTimeout
  };

  runInNewContext(SRC, ctx);

  return {
    bg: ctx,
    logs,
    fetchCalls,
    storageWrites,
    stateStore,
    setFetch(nextImpl) {
      fetchImpl = nextImpl;
    }
  };
}

function queueItem(eventId, bookmarkId, retryCount) {
  return {
    event: {
      batchId: "batch-seed",
      eventId,
      type: "bookmark_updated",
      bookmarkId,
      managedKey: "note:Projects/Foo",
      occurredAt: "2026-02-25T00:00:00.000Z",
      schemaVersion: "1"
    },
    retryCount: retryCount || 0,
    enqueuedAt: "2026-02-25T00:00:00.000Z"
  };
}

describe("coalesceQueue", () => {
  let h;

  beforeEach(() => {
    h = createHarness();
  });

  it("keeps only the last event for same bookmarkId", () => {
    const queue = [
      queueItem("e1", "b1"),
      queueItem("e2", "b1"),
      queueItem("e3", "b1")
    ];
    const result = h.bg.coalesceQueue(queue);

    assert.equal(result.length, 1);
    assert.equal(result[0].event.eventId, "e3");
  });

  it("keeps all events for different bookmarkIds", () => {
    const queue = [
      queueItem("e1", "b1"),
      queueItem("e2", "b2"),
      queueItem("e3", "b3")
    ];
    const result = h.bg.coalesceQueue(queue);

    assert.equal(result.length, 3);
    assert.equal(result[0].event.eventId, "e1");
    assert.equal(result[1].event.eventId, "e2");
    assert.equal(result[2].event.eventId, "e3");
  });

  it("returns empty array for empty queue", () => {
    const result = h.bg.coalesceQueue([]);
    assert.equal(Array.isArray(result), true);
    assert.equal(result.length, 0);
  });
});

describe("flushReverseQueue", () => {
  let h;

  beforeEach(() => {
    h = createHarness();
  });

  it("dequeues acked events after successful POST", async () => {
    const state = h.bg.migrateState({
      reverseQueue: [queueItem("e1", "b1"), queueItem("e2", "b2")]
    });

    h.setFetch(async () => ({
      ok: true,
      json: async () => ({
        batchId: "batch-ack",
        results: [
          { eventId: "e1", status: "applied" },
          { eventId: "e2", status: "applied" }
        ]
      })
    }));

    await h.bg.flushReverseQueue(state, "http://127.0.0.1:27123", "token-1");

    assert.equal(h.fetchCalls.length, 1);
    assert.equal(state.reverseQueue.length, 0);
    assert.equal(h.storageWrites.length, 1);
  });

  it("retains events and increments retryCount on 503", async () => {
    const state = h.bg.migrateState({
      reverseQueue: [queueItem("e1", "b1", 0), queueItem("e2", "b2", 1)]
    });

    h.setFetch(async () => ({
      ok: false,
      status: 503,
      json: async () => ({})
    }));

    await h.bg.flushReverseQueue(state, "http://127.0.0.1:27123", "token-1");

    assert.equal(state.reverseQueue.length, 2);
    assert.equal(state.reverseQueue[0].retryCount, 1);
    assert.equal(state.reverseQueue[1].retryCount, 2);
  });

  it("quarantines events when retryCount reaches 3", async () => {
    const state = h.bg.migrateState({
      reverseQueue: [queueItem("e1", "b1", 2)]
    });

    h.setFetch(async () => ({
      ok: false,
      status: 503,
      json: async () => ({})
    }));

    await h.bg.flushReverseQueue(state, "http://127.0.0.1:27123", "token-1");

    assert.equal(state.reverseQueue.length, 0);
    const sawQuarantine = h.logs.some((line) => line.includes('"event":"quarantine"'));
    assert.equal(sawQuarantine, true);
  });
});
