const panelId = "codex-etrade-downloader";
const statusId = "codex-etrade-downloader-status";
const messageSource = "codex-etrade-confirmation-downloader";

let running = false;

function ensurePanel() {
  if (document.getElementById(panelId)) {
    return;
  }

  const panel = document.createElement("div");
  panel.id = panelId;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Download confirmations";

  const status = document.createElement("span");
  status.id = statusId;
  status.textContent = "Ready";

  button.addEventListener("click", () => {
    if (running) {
      return;
    }
    running = true;
    button.disabled = true;
    status.textContent = "Collecting visible confirmations...";
    injectRunner().catch((error) => {
      status.textContent = `Error: ${error.message}`;
      setRunning(false);
    });
  });

  panel.append(button, status);
  document.documentElement.append(panel);
}

function setStatus(text) {
  const status = document.getElementById(statusId);
  if (status) {
    status.textContent = text;
  }
}

function setRunning(value) {
  running = value;
  const button = document.querySelector(`#${panelId} button`);
  if (button) {
    button.disabled = value;
  }
}

async function injectRunner() {
  const response = await chrome.runtime.sendMessage({ type: "run-collector" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not start collector");
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.data?.source !== messageSource) {
    return;
  }

  const { type, payload } = event.data;
  if (type === "progress") {
    setStatus(payload.message);
    return;
  }

  if (type === "error") {
    setStatus(`Error: ${payload.message}`);
    chrome.runtime.sendMessage({ type: "collector-finished" }).catch(() => {});
    setRunning(false);
    return;
  }

  if (type !== "result") {
    return;
  }

  setStatus(`Saving ${payload.items.length} files...`);
  try {
    const result = await saveFilesFromPage(payload);
    setStatus(`Saved ${result.saved} PDF files`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    chrome.runtime.sendMessage({ type: "collector-finished" }).catch(() => {});
    setRunning(false);
  }
});

ensurePanel();

async function saveFilesFromPage(payload) {
  const items = payload.items || [];
  const manifest = [];
  let saved = 0;

  for (const item of items) {
    const { base64, ...manifestItem } = item;
    manifest.push(manifestItem);

    if (!base64 || item.status !== 200 || !String(item.contentType || "").toLowerCase().includes("pdf")) {
      continue;
    }

    const filename = safeFilename(item.filename || fallbackFilename(item));
    await downloadBase64(filename, base64, "application/pdf");
    saved += 1;
    setStatus(`Saved ${saved} PDF files...`);
    await sleep(250);
  }

  const links = manifest.map((item) => `${item.date}\t${item.type}\t${item.row}\t${item.url || ""}`).join("\n") + "\n";
  await downloadText("links.txt", links, "text/plain;charset=utf-8");
  await sleep(250);
  await downloadText("manifest.json", JSON.stringify({ ...payload, items: manifest }, null, 2), "application/json;charset=utf-8");

  return { saved, total: items.length };
}

async function downloadBase64(filename, base64, mimeType) {
  const response = await chrome.runtime.sendMessage({
    type: "download-data",
    payload: {
      filename,
      url: `data:${mimeType};base64,${base64}`,
    },
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Download failed");
  }
}

async function downloadText(filename, text, mimeType) {
  const base64 = btoa(unescape(encodeURIComponent(text)));
  await downloadBase64(filename, base64, mimeType);
}

async function downloadBlob(filename, blob) {
  const base64 = await blobToBase64(blob);
  await downloadBase64(filename, base64, blob.type || "application/octet-stream");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Could not read blob"));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const chunkSize = 0x8000;
  const byteCharacters = atob(base64);
  const chunks = [];
  for (let offset = 0; offset < byteCharacters.length; offset += chunkSize) {
    const slice = byteCharacters.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      bytes[i] = slice.charCodeAt(i);
    }
    chunks.push(bytes);
  }
  return new Blob(chunks, { type });
}

function fallbackFilename(item) {
  const date = normalizeDate(String(item.date || "unknown-date"));
  const type = item.type || "document";
  return `${date}_${type}_confirmation.pdf`;
}

function normalizeDate(date) {
  if (!date.includes("/")) {
    return date;
  }
  return date.replace(/^(\d{2})\/(\d{2})\/(\d{2,4})$/, (_, month, day, year) => {
    return `${year.length === 2 ? `20${year}` : year}-${month}-${day}`;
  });
}

function safeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*]/g, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
