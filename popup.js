const bridgeUrlInput = document.getElementById("bridge-url");
const bridgeTokenInput = document.getElementById("bridge-token");
const autoSyncInput = document.getElementById("auto-sync");
const saveButton = document.getElementById("save");
const syncButton = document.getElementById("sync");
const statusEl = document.getElementById("status");

if (
  !(bridgeUrlInput instanceof HTMLTextAreaElement) ||
  !(bridgeTokenInput instanceof HTMLTextAreaElement) ||
  !(autoSyncInput instanceof HTMLInputElement) ||
  !(saveButton instanceof HTMLButtonElement) ||
  !(syncButton instanceof HTMLButtonElement) ||
  !(statusEl instanceof HTMLElement)
) {
  throw new Error("Popup elements not found");
}

void initializeConfig();

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
