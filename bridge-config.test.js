"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

const BRIDGE_CONFIG_KEY = "local_event_gateway_bridge";
const SRC = readFileSync(path.join(__dirname, "background.js"), "utf8");

function createHarness(initialBridgeConfig) {
  const store = {
    [BRIDGE_CONFIG_KEY]: initialBridgeConfig
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
    }
  };

  const ctx = {
    chrome,
    console,
    crypto: { randomUUID: () => "uuid-1" },
    fetch: async () => ({ ok: true, json: async () => ({ batchId: "b", results: [] }) }),
    setTimeout,
    clearTimeout,
    Date
  };

  runInNewContext(SRC, ctx);

  return { bg: ctx, store };
}

describe("bridge config migration and profile APIs", () => {
  let h;

  beforeEach(() => {
    h = createHarness({
      url: "http://127.0.0.1:27123/payload",
      token: "legacy-token",
      autoSync: true
    });
  });

  it("getBridgeConfig migrates legacy single-profile config", async () => {
    const config = await h.bg.getBridgeConfig();

    assert.equal(config.autoSync, true);
    assert.equal(config.url, "http://127.0.0.1:27123/payload");
    assert.equal(config.token, "legacy-token");
    assert.equal(Array.isArray(config.profiles), true);
    assert.equal(config.profiles.length, 1);
    assert.equal(config.profiles[0].clientId, "project2chrome");
    assert.equal(config.activeClientId, "project2chrome");
  });

  it("setBridgeConfig can switch active client and add profile", async () => {
    const config = await h.bg.setBridgeConfig({
      activeClientId: "obsidian-sidecar",
      url: "http://127.0.0.1:30123/payload",
      token: "sidecar-token",
      autoSync: false
    });

    assert.equal(config.autoSync, false);
    assert.equal(config.activeClientId, "obsidian-sidecar");
    assert.equal(config.url, "http://127.0.0.1:30123/payload");
    assert.equal(config.token, "sidecar-token");
    assert.equal(config.profiles.some((profile) => profile.clientId === "obsidian-sidecar"), true);
  });

  it("setBridgeConfig sanitizes malformed profiles payload", async () => {
    const config = await h.bg.setBridgeConfig({
      profiles: [
        null,
        { clientId: "", url: "", token: "" },
        { clientId: "c1", url: "http://127.0.0.1:4000/payload", token: "t1", enabled: true, priority: 42 },
        { clientId: "c1", url: "http://127.0.0.1:5000/payload", token: "t2", enabled: true }
      ]
    });

    assert.equal(config.profiles.length >= 1, true);
    assert.equal(config.profiles.filter((profile) => profile.clientId === "c1").length, 1);
    assert.equal(typeof config.url, "string");
    assert.equal(typeof config.token, "string");
  });
});
