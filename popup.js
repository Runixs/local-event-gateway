const bridgeClientSelect = document.getElementById("bridge-client");
const bridgeUrlInput = document.getElementById("bridge-url");
const bridgeWsUrlInput = document.getElementById("bridge-ws-url");
const bridgeTokenInput = document.getElementById("bridge-token");
const autoSyncInput = document.getElementById("auto-sync");
const saveButton = document.getElementById("save");
const syncButton = document.getElementById("sync");
const addClientButton = document.getElementById("client-add");
const removeClientButton = document.getElementById("client-remove");
const statusEl = document.getElementById("status");
const wsStatusEl = document.getElementById("ws-status");
const debugEnabledInput = document.getElementById("debug-enabled");
const debugBadgeInput = document.getElementById("debug-badge");
const debugRefreshButton = document.getElementById("debug-refresh");
const debugClearButton = document.getElementById("debug-clear");
const debugEventsEl = document.getElementById("debug-events");

if (
  !(bridgeClientSelect instanceof HTMLSelectElement) ||
  !(bridgeUrlInput instanceof HTMLTextAreaElement) ||
  !(bridgeWsUrlInput instanceof HTMLTextAreaElement) ||
  !(bridgeTokenInput instanceof HTMLTextAreaElement) ||
  !(autoSyncInput instanceof HTMLInputElement) ||
  !(saveButton instanceof HTMLButtonElement) ||
  !(syncButton instanceof HTMLButtonElement) ||
  !(addClientButton instanceof HTMLButtonElement) ||
  !(removeClientButton instanceof HTMLButtonElement) ||
  !(statusEl instanceof HTMLElement) ||
  !(wsStatusEl instanceof HTMLElement) ||
  !(debugEnabledInput instanceof HTMLInputElement) ||
  !(debugBadgeInput instanceof HTMLInputElement) ||
  !(debugRefreshButton instanceof HTMLButtonElement) ||
  !(debugClearButton instanceof HTMLButtonElement) ||
  !(debugEventsEl instanceof HTMLElement)
) {
  throw new Error("Popup elements not found");
}

let currentConfig = null;

void initializeConfig();
void refreshDebugTimeline();
void refreshWsStatus();

saveButton.addEventListener("click", async () => {
  statusEl.textContent = "Saving...";
  const nextConfig = buildNextConfigFromForm();
  const response = await chrome.runtime.sendMessage({
    type: "gateway.setBridgeConfig",
    config: nextConfig
  });

  if (!response?.ok) {
    statusEl.textContent = `Save failed: ${response?.error ?? "unknown error"}`;
    return;
  }

  currentConfig = response.config;
  populateClientSelect();
  applyClientToForm(response.config.activeClientId);
  statusEl.textContent = "Gateway settings saved";
  await refreshWsStatus();
});

syncButton.addEventListener("click", async () => {
  statusEl.textContent = "Syncing from bridge...";
  const response = await chrome.runtime.sendMessage({ type: "gateway.syncFromBridge" });
  if (!response?.ok) {
    statusEl.textContent = `Sync failed: ${response?.error ?? "unknown error"}`;
    return;
  }
  statusEl.textContent = "Sync completed";
  await refreshDebugTimeline();
  await refreshWsStatus();
});

bridgeClientSelect.addEventListener("change", () => {
  applyClientToForm(bridgeClientSelect.value);
});

addClientButton.addEventListener("click", () => {
  if (!currentConfig) {
    return;
  }
  const baseId = "client";
  let i = 1;
  while ((currentConfig.profiles || []).some((profile) => profile.clientId === `${baseId}-${String(i)}`)) {
    i += 1;
  }
  const nextId = `${baseId}-${String(i)}`;
  const profiles = Array.isArray(currentConfig.profiles) ? [...currentConfig.profiles] : [];
  profiles.push({
    clientId: nextId,
    url: bridgeUrlInput.value || "http://127.0.0.1:27123/payload",
    wsUrl: bridgeWsUrlInput.value || "ws://127.0.0.1:27123/ws",
    token: bridgeTokenInput.value || "project2chrome-local",
    enabled: true,
    priority: 100
  });
  currentConfig = {
    ...currentConfig,
    activeClientId: nextId,
    profiles
  };
  populateClientSelect();
  applyClientToForm(nextId);
  statusEl.textContent = `Added ${nextId}`;
});

removeClientButton.addEventListener("click", () => {
  if (!currentConfig) {
    return;
  }
  const profiles = Array.isArray(currentConfig.profiles) ? [...currentConfig.profiles] : [];
  if (profiles.length <= 1) {
    statusEl.textContent = "At least one client profile is required";
    return;
  }
  const activeId = bridgeClientSelect.value;
  const nextProfiles = profiles.filter((profile) => profile.clientId !== activeId);
  const nextActive = nextProfiles[0]?.clientId || "";
  currentConfig = {
    ...currentConfig,
    activeClientId: nextActive,
    profiles: nextProfiles
  };
  populateClientSelect();
  applyClientToForm(nextActive);
  statusEl.textContent = `Removed ${activeId}`;
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
  const response = await chrome.runtime.sendMessage({ type: "gateway.getBridgeConfig" });
  if (!response?.ok) {
    statusEl.textContent = "Failed to load gateway settings";
    return;
  }

  currentConfig = response.config;
  autoSyncInput.checked = Boolean(currentConfig?.autoSync);
  populateClientSelect();
  applyClientToForm(currentConfig?.activeClientId);
  statusEl.textContent = "Ready";
}

function populateClientSelect() {
  bridgeClientSelect.innerHTML = "";
  const profiles = Array.isArray(currentConfig?.profiles) ? currentConfig.profiles : [];
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.clientId;
    option.textContent = profile.clientId;
    bridgeClientSelect.append(option);
  }
  if (profiles.length > 0) {
    bridgeClientSelect.value = currentConfig?.activeClientId || profiles[0].clientId;
  }
}

function applyClientToForm(clientId) {
  const profile = findProfileById(clientId);
  if (!profile) {
    bridgeUrlInput.value = "http://127.0.0.1:27123/payload";
    bridgeWsUrlInput.value = "ws://127.0.0.1:27123/ws";
    bridgeTokenInput.value = "project2chrome-local";
    return;
  }
  bridgeClientSelect.value = profile.clientId;
  bridgeUrlInput.value = profile.url || "http://127.0.0.1:27123/payload";
  bridgeWsUrlInput.value = profile.wsUrl || "ws://127.0.0.1:27123/ws";
  bridgeTokenInput.value = profile.token || "project2chrome-local";
}

function findProfileById(clientId) {
  const profiles = Array.isArray(currentConfig?.profiles) ? currentConfig.profiles : [];
  return profiles.find((profile) => profile.clientId === clientId) || null;
}

function buildNextConfigFromForm() {
  const activeId = bridgeClientSelect.value;
  const profiles = Array.isArray(currentConfig?.profiles) ? [...currentConfig.profiles] : [];
  const nextProfiles = profiles.map((profile) => {
    if (profile.clientId !== activeId) {
      return profile;
    }
    return {
      ...profile,
      url: bridgeUrlInput.value.trim() || profile.url,
      wsUrl: bridgeWsUrlInput.value.trim() || profile.wsUrl,
      token: bridgeTokenInput.value.trim() || profile.token,
      enabled: profile.enabled !== false
    };
  });

  return {
    autoSync: autoSyncInput.checked,
    activeClientId: activeId,
    profiles: nextProfiles,
    clientId: activeId,
    url: bridgeUrlInput.value,
    wsUrl: bridgeWsUrlInput.value,
    token: bridgeTokenInput.value
  };
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

async function refreshWsStatus() {
  const response = await chrome.runtime.sendMessage({ type: "gateway.getWebSocketSession" });
  if (!response?.ok) {
    wsStatusEl.textContent = "WebSocket session unavailable";
    return;
  }
  const session = response.session || {};
  const status = String(session.status || "disconnected").toUpperCase();
  const client = session.activeClientId || "-";
  const reconnectAttempt = Number.isFinite(session.reconnectAttempt) ? session.reconnectAttempt : 0;
  const inQ = Number.isFinite(session.queuedInbound) ? session.queuedInbound : 0;
  const outQ = Number.isFinite(session.queuedOutbound) ? session.queuedOutbound : 0;
  const err = session.lastError ? ` error=${session.lastError}` : "";
  wsStatusEl.textContent = `WS ${status} client=${client} retry=${String(reconnectAttempt)} in=${String(inQ)} out=${String(outQ)}${err}`;
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
