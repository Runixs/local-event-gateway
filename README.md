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

## Sync Behavior

- Performs a managed-tree full refresh before applying each payload sync.
- Preserves payload order for folders and bookmarks.
- Supports duplicate bookmark URLs when the payload provides multiple link entries.
- Treats payload as source of truth for all managed nodes under the gateway root.

## Supported Tools

- [Runixs/project2chrome](https://github.com/Runixs/project2chrome): Obsidian plugin that builds and serves bookmark payloads consumed by this extension.

## Messages

- `gateway.getBridgeConfig`
- `gateway.setBridgeConfig`
- `gateway.syncFromBridge`

## Permissions

- `bookmarks`
- `storage`
- `alarms`
- `host_permissions`: localhost / 127.0.0.1

## Reverse Sync (Bookmark → Obsidian)

Reverse sync captures Chrome bookmark events and posts them back to the Obsidian plugin bridge so that note content stays in sync with bookmark changes made inside Chrome.

### Event Capture

The extension listens on four Chrome bookmark event listeners:

| Event | Captured as |
|---|---|
| `chrome.bookmarks.onCreated` | `bookmark_created` |
| `chrome.bookmarks.onChanged` (managed bookmark title/url) | `bookmark_updated` |
| `chrome.bookmarks.onChanged` (managed folder title) | `folder_renamed` |
| `chrome.bookmarks.onMoved` (managed bookmark) | `bookmark_updated` |
| `chrome.bookmarks.onRemoved` (managed bookmark) | `bookmark_deleted` |

Only events on extension-managed nodes are forwarded. Managed folder move/remove events are ignored in V1.

### Managed Key Resolution

The extension keeps both key directions in storage:

- `managedBookmarkIds`: `managedKey -> bookmarkId`
- `bookmarkIdToManagedKey`: `bookmarkId -> managedKey`

During payload apply, both maps are rebuilt from newly created managed bookmarks. Reverse listeners resolve keys with `bookmarkIdToManagedKey` first and then fall back to scanning `managedBookmarkIds` to avoid dropping managed events when state is partially stale.

### Batching and Durability

Events are coalesced into batches before being posted to the plugin:

- **Batch window**: 2–5 seconds after the first event in a group.
- **Alarm-backed durability**: a MV3 alarm ensures pending batches are flushed even if the service worker is recycled between events.

### Retry Pipeline

Failed POST requests to `/reverse-sync` are retried automatically:

- Maximum **3 retry attempts** with exponential backoff.
- After 3 failures, the batch is moved to a **quarantine queue** and not retried.
- Quarantined batches are logged and can be inspected in `chrome.storage.local`.

### Loop Suppression

To prevent a reverse-sync write from triggering another outbound payload fetch (which would create an event loop):

- An `applyEpoch` flag is set in `chrome.storage.local` before each payload apply cycle.
- A **3-second cooldown** is enforced after each apply: any bookmark events fired during the cooldown are dropped by the reverse-sync listener.
- The flag is cleared after the cooldown expires.

### Reverse Sync Endpoint

```
POST http://127.0.0.1:<port>/reverse-sync
X-Project2Chrome-Token: <token>
```

Payload body:

```json
{
  "batchId": "e48cb577-7d95-45d7-83f1-f8b4fe3ad8c0",
  "sentAt": "2026-02-25T11:00:00.000Z",
  "events": [
    {
      "batchId": "e48cb577-7d95-45d7-83f1-f8b4fe3ad8c0",
      "eventId": "d2116999-f8df-4890-bab3-c450efdd2eb6",
      "type": "bookmark_updated",
      "bookmarkId": "123",
      "managedKey": "note:1_Projects/MyProject/task.md",
      "title": "New title",
      "url": "https://example.com/new",
      "occurredAt": "2026-02-25T11:00:00.000Z",
      "schemaVersion": "1"
    }
  ]
}
```

### ACK Statuses

| Status | Meaning |
|---|---|
| `applied` | Write successfully applied to note |
| `skipped_ambiguous` | Could not resolve target; write skipped |
| `skipped_unmanaged` | Node is not managed by this extension |
| `rejected_invalid` | Payload validation failed |
| `duplicate` | Identical event already processed |
