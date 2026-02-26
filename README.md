# local-event-gateway

Chrome MV3 extension that syncs bookmarks with `project2chrome` over WebSocket action envelopes.

## Load Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this folder: `/Users/runixs/working_local/chrome/local-event-gateway`.

## Transport Model

- Active transport is WebSocket (`ws://` / `wss://`) per client profile.
- HTTP `/payload` and `/reverse-sync` are no longer used as active runtime transport paths.
- On startup/install/config changes, the extension attempts to connect and perform handshake.
- Keepalive runs with heartbeat ping/pong and reconnect backoff.

## WebSocket Envelope

Envelope validation is defined in `websocket-envelope.js`.

Core frame types:

- `handshake`
- `handshake_ack`
- `action`
- `ack`
- `error`
- `heartbeat_ping`
- `heartbeat_pong`

Action frame fields:

- `clientId`
- `eventId`
- `idempotencyKey`
- `op`
- `target`
- `payload`
- `occurredAt`

## Runtime Behavior

- Inbound action frames are validated, deduped by `clientId + idempotencyKey/eventId`, queued, then applied.
- Outbound bookmark events are queued, coalesced, and sent as WebSocket `action` frames.
- ACK frames are reconciled into local queue state (`applied`, `duplicate`, `skipped`, `rejected`).
- Loop suppression uses apply epoch + cooldown to avoid echo cycles.

## Multi-Client Profiles

- Profiles are stored in `chrome.storage.local` under `local_event_gateway_bridge`.
- Active profile defines `clientId`, `token`, and `wsUrl` for the current session.
- Popup supports add/remove/select profile and saving active profile settings.

## Debug and Status

Popup shows:

- Current WebSocket status (`CONNECTED`, `RECONNECTING`, `DISCONNECTED`)
- Active client id
- Reconnect attempt count
- Inbound/outbound queue counts
- Last error (if any)
- Reverse-sync debug timeline

## Messages

- `gateway.getBridgeConfig`
- `gateway.setBridgeConfig`
- `gateway.syncFromBridge`
- `gateway.getWebSocketSession`
- `gateway.getDebugState`
- `gateway.setDebugOptions`
- `gateway.clearDebugEvents`

## Permissions

- `bookmarks`
- `storage`
- `alarms`
- `host_permissions` for localhost HTTP/WS endpoints

## Test and Validate

```bash
node --test *.test.js
node --check background.js
node --check popup.js
```
