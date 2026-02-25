const bridgeUrlInput = document.getElementById("bridge-url");
const bridgeTokenInput = document.getElementById("bridge-token");
const autoSyncInput = document.getElementById("auto-sync");
const saveButton = document.getElementById("save");
const syncButton = document.getElementById("sync");
const statusEl = document.getElementById("status");
const debugEnabledInput = document.getElementById("debug-enabled");
const debugBadgeInput = document.getElementById("debug-badge");
const debugRefreshButton = document.getElementById("debug-refresh");
const debugClearButton = document.getElementById("debug-clear");
const debugEventsEl = document.getElementById("debug-events");

if (
  !(bridgeUrlInput instanceof HTMLTextAreaElement) ||
  !(bridgeTokenInput instanceof HTMLTextAreaElement) ||
  !(autoSyncInput instanceof HTMLInputElement) ||
  !(saveButton instanceof HTMLButtonElement) ||
  !(syncButton instanceof HTMLButtonElement) ||
  !(statusEl instanceof HTMLElement) ||
  !(debugEnabledInput instanceof HTMLInputElement) ||
  !(debugBadgeInput instanceof HTMLInputElement) ||
  !(debugRefreshButton instanceof HTMLButtonElement) ||
  !(debugClearButton instanceof HTMLButtonElement) ||
  !(debugEventsEl instanceof HTMLElement)
) {
  throw new Error("Popup elements not found");
}

void initializeConfig();
void refreshDebugTimeline();

saveButton.addEventListener("click", async () => {
  statusEl.textContent = "Saving...";

  const response = await chrome.runtime.sendMessage({
    type: "gateway.setBridgeConfig",
    config: {
      url: bridgeUrlInput.value,
      token: bridgeTokenInput.value,
      autoSync: autoSyncInput.checked
    }
  });

  if (!response?.ok) {
    statusEl.textContent = `Save failed: ${response?.error ?? "unknown error"}`;
    return;
  }

  statusEl.textContent = "Gateway settings saved";
});

syncButton.addEventListener("click", async () => {
  statusEl.textContent = "Syncing from bridge...";

  const response = await chrome.runtime.sendMessage({
    type: "gateway.syncFromBridge"
  });

  if (!response?.ok) {
    statusEl.textContent = `Sync failed: ${response?.error ?? "unknown error"}`;
    return;
  }

  statusEl.textContent = "Sync completed";
  await refreshDebugTimeline();
});

debugEnabledInput.addEventListener("change", async () => {
  await saveDebugOptions();
});

debugBadgeInput.addEventListener("change", async () => {
  await saveDebugOptions();
});

debugRefreshButton.addEventListener("click", async () => {
  await refreshDebugTimeline();
});

debugClearButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "gateway.clearDebugEvents" });
  if (!response?.ok) {
    statusEl.textContent = `Clear debug failed: ${response?.error ?? "unknown error"}`;
    return;
  }
  statusEl.textContent = "Debug timeline cleared";
  renderDebugEvents(response.debug?.events ?? []);
});

async function initializeConfig() {
  const response = await chrome.runtime.sendMessage({
    type: "gateway.getBridgeConfig"
  });

  if (!response?.ok) {
    statusEl.textContent = "Failed to load gateway settings";
    return;
  }

  const config = response.config;
  bridgeUrlInput.value = typeof config.url === "string" ? config.url : "http://127.0.0.1:27123/payload";
  bridgeTokenInput.value = typeof config.token === "string" ? config.token : "project2chrome-local";
  autoSyncInput.checked = Boolean(config.autoSync);
  statusEl.textContent = "Ready";
}

async function saveDebugOptions() {
  const response = await chrome.runtime.sendMessage({
    type: "gateway.setDebugOptions",
    options: {
      enabled: debugEnabledInput.checked,
      showInfoBadge: debugBadgeInput.checked
    }
  });

  if (!response?.ok) {
    statusEl.textContent = `Debug option save failed: ${response?.error ?? "unknown error"}`;
    return;
  }

  statusEl.textContent = "Debug options saved";
  await refreshDebugTimeline();
}

async function refreshDebugTimeline() {
  const response = await chrome.runtime.sendMessage({ type: "gateway.getDebugState" });
  if (!response?.ok) {
    statusEl.textContent = `Debug load failed: ${response?.error ?? "unknown error"}`;
    return;
  }

  const debug = response.debug || {};
  debugEnabledInput.checked = Boolean(debug.enabled);
  debugBadgeInput.checked = Boolean(debug.showInfoBadge);
  renderDebugEvents(Array.isArray(debug.events) ? debug.events : []);
}

function renderDebugEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    debugEventsEl.innerHTML = '<div class="debug-empty">No debug events yet.</div>';
    return;
  }

  const latestFirst = [...events].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const rows = latestFirst.slice(0, 80).map((entry) => {
    const level = typeof entry.level === "string" ? entry.level : "info";
    const when = Number.isFinite(entry.ts) ? new Date(entry.ts).toLocaleTimeString() : "-";
    const summary = typeof entry.summary === "string" && entry.summary.length > 0
      ? entry.summary
      : String(entry.event || "unknown");
    return `<div class="debug-event level-${escapeHtml(level)}"><strong>[${escapeHtml(level.toUpperCase())}]</strong> ${escapeHtml(when)} ${escapeHtml(summary)}</div>`;
  });

  debugEventsEl.innerHTML = rows.join("");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
