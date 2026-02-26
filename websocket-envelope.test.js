"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  parseAndValidateWsEnvelope,
  mapLegacyAckStatus
} = require("./websocket-envelope");

describe("mapLegacyAckStatus", () => {
  it("maps legacy ack statuses to websocket statuses", () => {
    assert.equal(mapLegacyAckStatus("applied"), "applied");
    assert.equal(mapLegacyAckStatus("duplicate"), "duplicate");
    assert.equal(mapLegacyAckStatus("skipped_ambiguous"), "skipped");
    assert.equal(mapLegacyAckStatus("skipped_unmanaged"), "skipped");
    assert.equal(mapLegacyAckStatus("rejected_invalid"), "rejected");
  });
});

describe("parseAndValidateWsEnvelope", () => {
  it("parses valid handshake frame", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "handshake",
      eventId: "evt-1",
      clientId: "local-event-gateway",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      sessionId: "ses-1",
      token: "project2chrome-local",
      capabilities: ["action", "ack"]
    });

    assert.ok(parsed);
    assert.equal(parsed.type, "handshake");
  });

  it("parses valid action frame", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "action",
      eventId: "evt-2",
      clientId: "local-event-gateway",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      idempotencyKey: "idem-1",
      op: "bookmark_created",
      target: "bookmark:123",
      payload: {
        title: "test",
        url: "chrome://extensions"
      }
    });

    assert.ok(parsed);
    assert.equal(parsed.type, "action");
  });

  it("parses valid ack frame with legacyStatus", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "ack",
      eventId: "evt-3",
      clientId: "project2chrome",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      correlationId: "evt-2",
      status: "skipped",
      legacyStatus: "skipped_unmanaged"
    });

    assert.ok(parsed);
    assert.equal(parsed.type, "ack");
    assert.equal(parsed.legacyStatus, "skipped_unmanaged");
  });

  it("rejects action frame without idempotencyKey", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "action",
      eventId: "evt-4",
      clientId: "local-event-gateway",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      op: "bookmark_created",
      target: "bookmark:123",
      payload: {}
    });

    assert.equal(parsed, null);
  });

  it("rejects heartbeat_pong without correlationId", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "heartbeat_pong",
      eventId: "evt-5",
      clientId: "project2chrome",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0"
    });

    assert.equal(parsed, null);
  });

  it("rejects ack frame with unknown legacy status", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "ack",
      eventId: "evt-6",
      clientId: "project2chrome",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      correlationId: "evt-1",
      status: "rejected",
      legacyStatus: "future_status"
    });

    assert.equal(parsed, null);
  });
});
