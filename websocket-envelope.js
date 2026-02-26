"use strict";

const WS_ACTION_SCHEMA_VERSION = "1.0";

const WS_MESSAGE_TYPES = [
  "handshake",
  "handshake_ack",
  "action",
  "ack",
  "error",
  "heartbeat_ping",
  "heartbeat_pong"
];

const WS_ACK_STATUSES = ["received", "applied", "duplicate", "skipped", "rejected"];
const LEGACY_ACK_STATUSES = ["applied", "skipped_ambiguous", "skipped_unmanaged", "rejected_invalid", "duplicate"];

function mapLegacyAckStatus(status) {
  if (status === "applied") {
    return "applied";
  }
  if (status === "duplicate") {
    return "duplicate";
  }
  if (status === "skipped_ambiguous" || status === "skipped_unmanaged") {
    return "skipped";
  }
  return "rejected";
}

function parseAndValidateWsEnvelope(body) {
  if (!isRecord(body)) {
    return null;
  }

  const type = readMessageType(body.type);
  const eventId = readString(body.eventId);
  const clientId = readString(body.clientId);
  const occurredAt = readString(body.occurredAt);
  const schemaVersion = readString(body.schemaVersion);
  const idempotencyKey = readOptionalString(body.idempotencyKey);
  const correlationId = readOptionalString(body.correlationId);

  if (!type || !eventId || !clientId || !occurredAt || !schemaVersion) {
    return null;
  }
  if (idempotencyKey === null || correlationId === null) {
    return null;
  }

  if (type === "handshake") {
    const sessionId = readString(body.sessionId);
    const token = readString(body.token);
    const capabilities = readOptionalStringArray(body.capabilities);
    if (!sessionId || !token || capabilities === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey || undefined,
      correlationId: correlationId || undefined,
      sessionId,
      token,
      capabilities: capabilities || undefined
    };
  }

  if (type === "handshake_ack") {
    const sessionId = readString(body.sessionId);
    const accepted = body.accepted;
    const heartbeatMs = readHeartbeatMs(body.heartbeatMs);
    if (!sessionId || typeof accepted !== "boolean" || heartbeatMs === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey || undefined,
      correlationId: correlationId || undefined,
      sessionId,
      accepted,
      heartbeatMs
    };
  }

  if (type === "action") {
    const op = readString(body.op);
    const target = readString(body.target);
    const payload = readRecord(body.payload);
    if (!op || !target || !payload || !idempotencyKey) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey,
      correlationId: correlationId || undefined,
      op,
      target,
      payload
    };
  }

  if (type === "ack") {
    const status = readWsAckStatus(body.status);
    const reason = readOptionalString(body.reason);
    const resolvedPath = readOptionalString(body.resolvedPath);
    const resolvedKey = readOptionalString(body.resolvedKey);
    const legacyStatus = readOptionalLegacyAckStatus(body.legacyStatus);
    if (!status || !correlationId || reason === null || resolvedPath === null || resolvedKey === null || legacyStatus === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey || undefined,
      correlationId,
      status,
      reason: reason || undefined,
      resolvedPath: resolvedPath || undefined,
      resolvedKey: resolvedKey || undefined,
      legacyStatus: legacyStatus || undefined
    };
  }

  if (type === "error") {
    const code = readString(body.code);
    const message = readString(body.message);
    const retryable = body.retryable;
    const details = readOptionalRecord(body.details);
    if (!code || !message || typeof retryable !== "boolean" || details === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey || undefined,
      correlationId: correlationId || undefined,
      code,
      message,
      retryable,
      details: details || undefined
    };
  }

  if (type === "heartbeat_ping") {
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey || undefined,
      correlationId: correlationId || undefined
    };
  }

  if (!correlationId) {
    return null;
  }

  return {
    type,
    eventId,
    clientId,
    occurredAt,
    schemaVersion,
    idempotencyKey: idempotencyKey || undefined,
    correlationId
  };
}

function readMessageType(value) {
  if (typeof value !== "string") {
    return null;
  }
  return WS_MESSAGE_TYPES.includes(value) ? value : null;
}

function readWsAckStatus(value) {
  if (typeof value !== "string") {
    return null;
  }
  return WS_ACK_STATUSES.includes(value) ? value : null;
}

function readOptionalLegacyAckStatus(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  return LEGACY_ACK_STATUSES.includes(value) ? value : null;
}

function readHeartbeatMs(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value >= 1000 && value <= 120000 ? value : null;
}

function readString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalString(value) {
  if (value === undefined) {
    return undefined;
  }
  return readString(value);
}

function readOptionalStringArray(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const result = [];
  for (const item of value) {
    const parsed = readString(item);
    if (!parsed) {
      return null;
    }
    result.push(parsed);
  }
  return result;
}

function readRecord(value) {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  return value;
}

function readOptionalRecord(value) {
  if (value === undefined) {
    return undefined;
  }
  return readRecord(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

module.exports = {
  WS_ACTION_SCHEMA_VERSION,
  WS_MESSAGE_TYPES,
  WS_ACK_STATUSES,
  parseAndValidateWsEnvelope,
  mapLegacyAckStatus
};
