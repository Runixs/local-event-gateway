"use strict";

const assert = require("node:assert/strict");
const { describe, it, before } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Load background.js into a VM context with a minimal mock chrome global.
// Realm-safe checks are used throughout: scalar equality, length, indexing.
// (VM-realm prototypes differ from main-realm — deepStrictEqual with empty
// literals fails. See reverse-queue.test.js for detailed note.)
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

/** @type {Record<string, Function>} */
let bg;

before(() => {
  const src = readFileSync(path.join(__dirname, "background.js"), "utf8");
  const ctx = { chrome: makeMockChrome(), console };
  runInNewContext(src, ctx);
  bg = ctx;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState() {
  return bg.migrateState(null);
}

function makeQueueItem(eventId, bookmarkId, type) {
  return {
    event: {
      batchId: "batch-1",
      eventId: eventId,
      type: type || "bookmark_created",
      bookmarkId: bookmarkId || "bk1",
      managedKey: "",
      occurredAt: "2026-02-25T00:00:00.000Z",
      schemaVersion: "1"
    },
    retryCount: 0,
    enqueuedAt: "2026-02-25T00:00:00.000Z"
  };
}

function seedQueue(state, items) {
  for (const item of items) {
    state.reverseQueue.push(item);
  }
}

function makeAck(batchId, results) {
  return { batchId: batchId || "batch-1", results: results };
}

// ---------------------------------------------------------------------------
// applied
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – applied", () => {
  it("applied: removes event from queue", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk1"), makeQueueItem("evt-2", "bk2")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied" }
    ]));
    assert.equal(state.reverseQueue.length, 1);
    assert.equal(state.reverseQueue[0].event.eventId, "evt-2");
  });

  it("applied with resolvedKey: updates bookmarkIdToManagedKey", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk42")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied", resolvedKey: "note:Projects/Foo" }
    ]));
    assert.equal(state.bookmarkIdToManagedKey["bk42"], "note:Projects/Foo");
    assert.equal(state.reverseQueue.length, 0);
  });

  it("applied without resolvedKey: does not add null/undefined to mapping", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk42")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied" }
    ]));
    assert.equal(state.bookmarkIdToManagedKey["bk42"], undefined);
  });

  it("applied with resolvedKey: does not overwrite existing stable mapping with empty key", () => {
    const state = makeState();
    state.bookmarkIdToManagedKey["bk99"] = "note:Projects/Stable";
    seedQueue(state, [makeQueueItem("evt-1", "bk99")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied" }  // no resolvedKey
    ]));
    assert.equal(state.bookmarkIdToManagedKey["bk99"], "note:Projects/Stable");
  });
});

// ---------------------------------------------------------------------------
// duplicate
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – duplicate", () => {
  it("duplicate: removes event from queue (idempotent, already processed)", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk1"), makeQueueItem("evt-2", "bk2")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "duplicate" }
    ]));
    assert.equal(state.reverseQueue.length, 1);
    assert.equal(state.reverseQueue[0].event.eventId, "evt-2");
  });

  it("duplicate: does not update bookmarkIdToManagedKey even if resolvedKey present", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk1")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "duplicate", resolvedKey: "note:Projects/Foo" }
    ]));
    // duplicate path does not call updateBookmarkKeyMapping
    assert.equal(state.bookmarkIdToManagedKey["bk1"], undefined);
  });
});

// ---------------------------------------------------------------------------
// skipped_ambiguous
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – skipped_ambiguous", () => {
  it("skipped_ambiguous: removes event from queue (final, not retried)", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk1"), makeQueueItem("evt-2", "bk2")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "skipped_ambiguous", reason: "multiple_matches" }
    ]));
    assert.equal(state.reverseQueue.length, 1);
    assert.equal(state.reverseQueue[0].event.eventId, "evt-2");
  });
});

// ---------------------------------------------------------------------------
// skipped_unmanaged
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – skipped_unmanaged", () => {
  it("skipped_unmanaged: removes event from queue (final, not retried)", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk1"), makeQueueItem("evt-2", "bk2")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "skipped_unmanaged", reason: "unrecognized_key" }
    ]));
    assert.equal(state.reverseQueue.length, 1);
    assert.equal(state.reverseQueue[0].event.eventId, "evt-2");
  });
});

// ---------------------------------------------------------------------------
// rejected_invalid
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – rejected_invalid", () => {
  it("rejected_invalid: removes event from queue (final, not retried)", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk1"), makeQueueItem("evt-2", "bk2")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "rejected_invalid", reason: "schema_error" }
    ]));
    assert.equal(state.reverseQueue.length, 1);
    assert.equal(state.reverseQueue[0].event.eventId, "evt-2");
  });
});

// ---------------------------------------------------------------------------
// unknown status → keep in queue for retry
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – unknown status", () => {
  it("unknown status: keeps event in queue for retry", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk1"), makeQueueItem("evt-2", "bk2")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "some_future_status" }
    ]));
    assert.equal(state.reverseQueue.length, 2);
  });

  it("unknown status: does not mutate bookmarkIdToManagedKey", () => {
    const state = makeState();
    state.bookmarkIdToManagedKey["bk1"] = "note:Projects/Existing";
    seedQueue(state, [makeQueueItem("evt-1", "bk1")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "transient_retry" }
    ]));
    assert.equal(state.bookmarkIdToManagedKey["bk1"], "note:Projects/Existing");
  });
});

// ---------------------------------------------------------------------------
// Mixed batch
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – mixed batch", () => {
  it("applied + skipped + unknown: correct subset removed", () => {
    const state = makeState();
    seedQueue(state, [
      makeQueueItem("evt-1", "bk1"),
      makeQueueItem("evt-2", "bk2"),
      makeQueueItem("evt-3", "bk3"),
      makeQueueItem("evt-4", "bk4")   // not in ACK results at all
    ]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied" },
      { eventId: "evt-2", status: "skipped_ambiguous", reason: "multiple_matches" },
      { eventId: "evt-3", status: "some_future_status" }
    ]));
    // evt-1 (applied): removed
    // evt-2 (skipped_ambiguous): removed (final)
    // evt-3 (unknown): kept for retry
    // evt-4 (not acked): untouched
    assert.equal(state.reverseQueue.length, 2);
    const ids = state.reverseQueue.map((item) => item.event.eventId);
    assert.ok(ids.indexOf("evt-3") !== -1, "evt-3 (unknown status) must remain");
    assert.ok(ids.indexOf("evt-4") !== -1, "evt-4 (not acked) must remain");
    assert.ok(ids.indexOf("evt-1") === -1, "evt-1 (applied) must be removed");
    assert.ok(ids.indexOf("evt-2") === -1, "evt-2 (skipped_ambiguous) must be removed");
  });

  it("all statuses in one batch: correct final queue", () => {
    const state = makeState();
    seedQueue(state, [
      makeQueueItem("evt-a", "bkA"),
      makeQueueItem("evt-b", "bkB"),
      makeQueueItem("evt-c", "bkC"),
      makeQueueItem("evt-d", "bkD"),
      makeQueueItem("evt-e", "bkE")
    ]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-a", status: "applied", resolvedKey: "note:Projects/A" },
      { eventId: "evt-b", status: "duplicate" },
      { eventId: "evt-c", status: "skipped_unmanaged" },
      { eventId: "evt-d", status: "rejected_invalid" },
      { eventId: "evt-e", status: "mystery_status" }
    ]));
    // a,b,c,d removed; e kept
    assert.equal(state.reverseQueue.length, 1);
    assert.equal(state.reverseQueue[0].event.eventId, "evt-e");
    // a had resolvedKey
    assert.equal(state.bookmarkIdToManagedKey["bkA"], "note:Projects/A");
  });
});

// ---------------------------------------------------------------------------
// resolvedKey mapping — dedicated coverage
// ---------------------------------------------------------------------------

describe("processReverseAckResponse – resolvedKey in applied ACK", () => {
  it("resolvedKey updates bookmarkIdToManagedKey for correct bookmarkId", () => {
    const state = makeState();
    seedQueue(state, [makeQueueItem("evt-1", "bk99")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied", resolvedKey: "note:Projects/NewBookmark" }
    ]));
    assert.equal(state.reverseQueue.length, 0);
    assert.equal(state.bookmarkIdToManagedKey["bk99"], "note:Projects/NewBookmark");
  });

  it("resolvedKey for one event does not affect mapping for another", () => {
    const state = makeState();
    seedQueue(state, [
      makeQueueItem("evt-1", "bk1"),
      makeQueueItem("evt-2", "bk2")
    ]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied", resolvedKey: "note:Projects/First" },
      { eventId: "evt-2", status: "applied" }  // no resolvedKey
    ]));
    assert.equal(state.bookmarkIdToManagedKey["bk1"], "note:Projects/First");
    assert.equal(state.bookmarkIdToManagedKey["bk2"], undefined);
  });

  it("resolvedKey in applied overwrites pre-existing mapping", () => {
    const state = makeState();
    state.bookmarkIdToManagedKey["bk1"] = "note:Projects/Old";
    seedQueue(state, [makeQueueItem("evt-1", "bk1")]);
    bg.processReverseAckResponse(state, makeAck("b1", [
      { eventId: "evt-1", status: "applied", resolvedKey: "note:Projects/New" }
    ]));
    assert.equal(state.bookmarkIdToManagedKey["bk1"], "note:Projects/New");
  });
});
