# local-event-gateway

Chrome MV3 extension providing a standard local bridge automation interface for bookmark sync.

## Load Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this folder: `/Users/runixs/working_local/chrome/local-event-gateway`.

## Bridge Contract

- Default bridge URL: `http://127.0.0.1:27123/payload`
- Required request header: `X-Project2Chrome-Token: <token>`
- Auto sync: every 1 minute via MV3 alarms

## Messages

- `gateway.getBridgeConfig`
- `gateway.setBridgeConfig`
- `gateway.syncFromBridge`

## Permissions

- `bookmarks`
- `storage`
- `alarms`
- `host_permissions`: localhost / 127.0.0.1
