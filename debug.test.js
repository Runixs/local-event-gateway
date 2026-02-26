"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STORAGE_KEY = "local_event_gateway_state";
const BRIDGE_CONFIG_KEY = "local_event_gateway_bridge";
const DEBUG_STATE_KEY = "local_event_gateway_debug";
const SRC = readFileSync(path.join(__dirname, "background.js"), "utf8");

function createHarness() {
  const store = {
    [STORAGE_KEY]: null,
    [BRIDGE_CONFIG_KEY]: {
      url: "http://127.0.0.1:27123/payload",
      token: "project2chrome-local",
      autoSync: true
    },
    [DEBUG_STATE_KEY]: null
  };

  const badgeState = {
    text: "",
    color: "",
    title: ""
  };

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
        async get(key) {
          if (typeof key === "string") {
            return { [key]: store[key] };
          }
          const out = {};
          for (const k of Object.keys(key || {})) {
            out[k] = store[k];
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj || {})) {
            store[k] = v;
          }
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
    },
    action: {
      async setTitle({ title }) {
        badgeState.title = title;
      },
      async setBadgeText({ text }) {
        badgeState.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badgeState.color = color;
      }
    }
  };

  const ctx = {
    chrome,
    crypto: { randomUUID },
    console: { log() {} },
    fetch: async () => ({ ok: true, json: async () => ({ batchId: "b", results: [] }) }),
    setTimeout,
    clearTimeout,
    Date
  };

  runInNewContext(SRC, ctx);

  return { bg: ctx, store, badgeState };
}

describe("debug state", () => {
  let h;

  beforeEach(() => {
    h = createHarness();
  });

  it("migrates missing debug state to safe defaults", async () => {
    await h.bg.ensureDebugState();
    const debug = await h.bg.getDebugState();
    assert.equal(debug.enabled, true);
    assert.equal(debug.showInfoBadge, false);
    assert.equal(Array.isArray(debug.events), true);
    assert.equal(debug.events.length, 0);
  });

  it("records rsLog events into persistent timeline", async () => {
    await h.bg.ensureDebugState();
    h.bg.rsLog("flush", { batchId: "batch-1", count: 2 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const debug = await h.bg.getDebugState();
    assert.equal(debug.events.length >= 1, true);
    const latest = debug.events[debug.events.length - 1];
    assert.equal(latest.event, "flush");
    assert.equal(typeof latest.summary, "string");
  });

  it("setDebugOptions toggles enabled and showInfoBadge", async () => {
    await h.bg.ensureDebugState();
    const next = await h.bg.setDebugOptions({ enabled: false, showInfoBadge: true });
    assert.equal(next.enabled, false);
    assert.equal(next.showInfoBadge, true);

    const debug = await h.bg.getDebugState();
    assert.equal(debug.enabled, false);
    assert.equal(debug.showInfoBadge, true);
  });

  it("clearDebugEvents removes timeline entries", async () => {
    await h.bg.ensureDebugState();
    h.bg.rsLog("enqueue", { eventId: "e1" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const before = await h.bg.getDebugState();
    assert.equal(before.events.length >= 1, true);

    const after = await h.bg.clearDebugEvents();
    assert.equal(after.events.length, 0);
  });

  it("keeps only bounded number of debug events", async () => {
    await h.bg.ensureDebugState();
    for (let i = 0; i < 260; i += 1) {
      h.bg.rsLog("enqueue", { eventId: `e${String(i)}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const debug = await h.bg.getDebugState();
    assert.equal(debug.events.length <= 200, true);
  });
});
