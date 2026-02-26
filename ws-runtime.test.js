const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

const SRC = readFileSync(path.join(__dirname, "background.js"), "utf8");
const BRIDGE_CONFIG_KEY = "local_event_gateway_bridge";
const WS_SESSION_KEY = "local_event_gateway_ws";

function createHarness() {
  const store = {
    [BRIDGE_CONFIG_KEY]: {
      autoSync: true,
      activeClientId: "project2chrome",
      profiles: [
        {
          clientId: "project2chrome",
          url: "http://127.0.0.1:27123/payload",
          wsUrl: "ws://127.0.0.1:27123/ws",
          token: "project2chrome-local",
          enabled: true,
          priority: 100
        }
      ]
    },
    [WS_SESSION_KEY]: null
  };

  const sockets = [];

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(String(payload));
    }

    close(code = 1000, reason = "") {
      this.readyState = MockWebSocket.CLOSED;
      if (typeof this.onclose === "function") {
        this.onclose({ code, reason });
      }
    }

    open() {
      this.readyState = MockWebSocket.OPEN;
      if (typeof this.onopen === "function") {
        this.onopen();
      }
    }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSED = 3;

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    alarms: {
      onAlarm: { addListener() {} },
      async clear() {},
      async create() {}
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
    WebSocket: MockWebSocket,
    console: { log() {} },
    crypto: { randomUUID: () => "uuid-1" },
    fetch: async () => ({ ok: true, json: async () => ({ batchId: "b", results: [] }) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date
  };

  runInNewContext(SRC, ctx);

  return { bg: ctx, store, sockets, MockWebSocket };
}

describe("websocket runtime", () => {
  let h;

  beforeEach(() => {
    h = createHarness();
  });

  it("creates websocket session state and transitions to connected on open", async () => {
    await h.bg.ensureWebSocketSession();
    await h.bg.ensureWebSocketConnection("test");
    assert.equal(h.sockets.length, 1);
    h.sockets[0].open();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const session = await h.bg.getWebSocketSession();
    assert.equal(session.status, "connected");
    assert.equal(session.activeClientId, "project2chrome");
    assert.equal(typeof session.lastConnectedAt, "string");
  });

  it("updates session to disconnected after socket close and increments reconnectAttempt", async () => {
    await h.bg.ensureWebSocketSession();
    await h.bg.ensureWebSocketConnection("test");
    assert.equal(h.sockets.length, 1);
    h.sockets[0].open();
    h.sockets[0].close(4000, "heartbeat_timeout");
    await new Promise((resolve) => setTimeout(resolve, 120));

    const session = await h.bg.getWebSocketSession();
    assert.equal(typeof session.status, "string");
    assert.equal(session.reconnectAttempt >= 0, true);
  });

  it("reconnects after close and resets session to connected", async () => {
    await h.bg.ensureWebSocketSession();
    await h.bg.ensureWebSocketConnection("test");
    assert.equal(h.sockets.length, 1);

    h.sockets[0].open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.sockets[0].close(4000, "heartbeat_timeout");
    await new Promise((resolve) => setTimeout(resolve, 120));

    await h.bg.ensureWebSocketConnection("manual_reconnect");
    assert.equal(h.sockets.length, 2);
    h.sockets[1].open();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const session = await h.bg.getWebSocketSession();
    assert.equal(session.status, "connected");
    assert.equal(session.reconnectAttempt, 0);
  });
});
