const collectorTabs = new Set();
const pendingFilenameByUrl = new Map();
const pendingCollectorFilenames = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "run-collector") {
    if (_sender.tab?.id) {
      collectorTabs.add(_sender.tab.id);
    }
    runCollector(_sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "collector-finished") {
    if (_sender.tab?.id) {
      collectorTabs.delete(_sender.tab.id);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "download-data") {
    downloadData(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function runCollector(tabId) {
  if (!tabId) {
    throw new Error("No active E*TRADE tab was found.");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/page-runner.js"],
    world: "MAIN",
  });
}

async function downloadData(payload) {
  const filename = sanitizeFilename(payload.filename || "confirmation.pdf");
  rememberPendingFilename(payload.url, filename);
  pendingCollectorFilenames.push(filename);

  const id = await chrome.downloads.download({
    url: payload.url,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
  return { id };
}

function sanitizeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*]/g, "_");
}

function rememberPendingFilename(url, filename) {
  const existing = pendingFilenameByUrl.get(url) || [];
  existing.push(filename);
  pendingFilenameByUrl.set(url, existing);

  setTimeout(() => {
    const names = pendingFilenameByUrl.get(url);
    if (!names) {
      return;
    }
    const index = names.indexOf(filename);
    if (index >= 0) {
      names.splice(index, 1);
    }
    if (names.length === 0) {
      pendingFilenameByUrl.delete(url);
    }
  }, 120000);
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const queuedForUrl = pendingFilenameByUrl.get(downloadItem.url);
  const exactFilename = queuedForUrl?.shift();
  if (queuedForUrl && queuedForUrl.length === 0) {
    pendingFilenameByUrl.delete(downloadItem.url);
  }
  if (exactFilename) {
    removePendingCollectorFilename(exactFilename);
  }

  const fallbackFilename = !exactFilename && shouldRenameCollectorDownload(downloadItem) ? pendingCollectorFilenames.shift() : null;
  const filename = exactFilename || fallbackFilename;
  if (!filename) {
    return;
  }

  suggest({
    filename,
    conflictAction: "uniquify",
  });
});

function shouldRenameCollectorDownload(downloadItem) {
  if (collectorTabs.size === 0 || pendingCollectorFilenames.length === 0) {
    return false;
  }

  const url = downloadItem.finalUrl || downloadItem.url || "";
  const currentName = downloadItem.filename || "";
  return (
    /^https:\/\/[^/]*etrade\.com\//i.test(url) ||
    /^data:/i.test(url) ||
    /(^|[\\/])download(?: \(\d+\))?\.pdf$/i.test(currentName) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/i.test(currentName)
  );
}

function removePendingCollectorFilename(filename) {
  const index = pendingCollectorFilenames.indexOf(filename);
  if (index >= 0) {
    pendingCollectorFilenames.splice(index, 1);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  maybeCloseNativeDownloadTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  maybeCloseNativeDownloadTab({ ...tab, id: tabId });
});

function maybeCloseNativeDownloadTab(tab) {
  if (collectorTabs.size === 0 || !tab.id) {
    return;
  }

  const url = tab.pendingUrl || tab.url || "";
  if (!url) {
    return;
  }

  const looksLikeNativeConfirmationTab =
    /^https:\/\/[^/]*etrade\.com\//i.test(url) &&
    /(Confirmation|Confirmations|\.pdf|documentStream|getEsppConfirmation|getReleaseConfirmation|TradeConfirmations)/i.test(url);

  if (looksLikeNativeConfirmationTab) {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}
