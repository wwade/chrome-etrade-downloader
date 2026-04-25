(() => {
  const messageSource = "codex-etrade-confirmation-downloader";

  function post(type, payload) {
    window.postMessage({ source: messageSource, type, payload }, window.location.origin);
  }

  function normalizeDate(date) {
    if (!date || !date.includes("/")) {
      return date || "unknown-date";
    }
    return date.replace(/^(\d{2})\/(\d{2})\/(\d{2,4})$/, (_, month, day, year) => {
      return `${year.length === 2 ? `20${year}` : year}-${month}-${day}`;
    });
  }

  function filenameKey(item) {
    const isoDate = normalizeDate(item.date);
    return `${isoDate}_${item.type}`;
  }

  function assignFilenames(items) {
    const groups = new Map();
    for (const item of items) {
      const key = filenameKey(item);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    }

    for (const [key, group] of groups.entries()) {
      if (group.length === 1) {
        group[0].filename = `${key}_confirmation.pdf`;
        continue;
      }

      group.forEach((item, index) => {
        item.filename = `${key}_confirmation_${index + 1}_of_${group.length}.pdf`;
      });
    }

    return items;
  }

  async function toBase64(response, responseText) {
    let bytes;
    if (response instanceof Blob) {
      bytes = new Uint8Array(await response.arrayBuffer());
    } else if (response instanceof ArrayBuffer) {
      bytes = new Uint8Array(response);
    } else if (typeof response === "string") {
      bytes = new Uint8Array([...response].map((char) => char.charCodeAt(0) & 0xff));
    } else if (typeof responseText === "string") {
      bytes = new Uint8Array([...responseText].map((char) => char.charCodeAt(0) & 0xff));
    } else {
      bytes = new Uint8Array();
    }

    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { base64: btoa(binary), bytes: bytes.byteLength };
  }

  function parseTradeRows() {
    const lines = document.body.innerText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\/\s*\d{6,}/.test(lines[i]) && /\d{2}\/\d{2}\/\d{2}/.test(lines[i - 1] || "")) {
        rows.push({ date: lines[i - 1], row: `${lines[i - 1]} ${lines[i]}` });
      }
    }
    return rows;
  }

  async function run() {
    const tradeRows = parseTradeRows();
    const tradeWaiters = [];
    const oldXhrOpen = XMLHttpRequest.prototype.open;
    const oldXhrSend = XMLHttpRequest.prototype.send;
    const oldOpen = window.open;
    const oldCreateElement = Document.prototype.createElement;
    const oldHtmlClick = HTMLElement.prototype.click;
    const openedUrls = [];

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__codexEtradeRequest = { method, url: String(url) };
      return oldXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      const request = this.__codexEtradeRequest;
      if (request?.url.includes("TradeConfirmations.pdf")) {
        this.addEventListener("loadend", async () => {
          try {
            const responseText = this.responseText || (typeof this.response === "string" ? this.response : "");
            const contentType = this.getResponseHeader("content-type") || "";
            let payload;

            if (contentType.toLowerCase().includes("json") && responseText) {
              const json = JSON.parse(responseText);
              payload = {
                url: request.url,
                status: this.status,
                contentType: "application/pdf",
                bytes: atob(json.documentStream || "").length,
                base64: json.documentStream || "",
                sourceFileName: json.fileName || "",
              };
            } else {
              payload = {
                url: request.url,
                status: this.status,
                contentType,
                ...(await toBase64(this.response, responseText)),
              };
            }

            const waiter = tradeWaiters.shift();
            if (waiter) {
              waiter(payload);
            }
          } catch (error) {
            const waiter = tradeWaiters.shift();
            if (waiter) {
              waiter({ error: error.message });
            }
          }
        });
      }
      return oldXhrSend.apply(this, args);
    };

    window.open = (...args) => {
      openedUrls.push(args);
      return null;
    };

    Document.prototype.createElement = function(tagName, ...args) {
      const element = oldCreateElement.call(this, tagName, ...args);
      if (String(tagName).toLowerCase() === "a") {
        element.addEventListener("click", (event) => {
          const href = element.href || "";
          if (/\.pdf(?:$|[?#])/i.test(href) || element.download) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }, true);
      }
      return element;
    };

    HTMLElement.prototype.click = function(...args) {
      if (this instanceof HTMLAnchorElement) {
        const href = this.href || "";
        if (/\.pdf(?:$|[?#])/i.test(href) || this.download) {
          return undefined;
        }
      }
      return oldHtmlClick.apply(this, args);
    };

    try {
      const items = [];
      const stockButtons = [...document.querySelectorAll("button")]
        .filter((button) => /View Confirmation Of (Purchase|Release)/i.test(button.innerText || button.textContent || ""));

      post("progress", { message: `Found ${stockButtons.length} stock-plan confirmations` });

      for (const [index, button] of stockButtons.entries()) {
        const tr = button.closest("tr");
        const row = (tr ? tr.innerText : button.closest(".table-responsive")?.innerText || "")
          .trim()
          .replace(/\s+/g, " ");
        const label = (button.innerText || button.textContent || "").trim().replace(/\s+/g, " ");
        const type = /release/i.test(`${label} ${row}`) ? "release" : "purchase";
        const date = row.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || String(index + 1).padStart(2, "0");
        const quantity = row.match(/Shares (?:purchased|released)\s+([\d,]+)/i)?.[1] || "";

        openedUrls.length = 0;
        button.click();
        const url = openedUrls[0]?.[0] || "";
        if (!url) {
          items.push({ index, row, label, type, date, quantity, url, error: "No PDF URL produced by click" });
          continue;
        }

        const response = await fetch(url, { credentials: "include" });
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }

        const item = {
          index,
          row,
          label,
          type,
          date,
          quantity,
          url,
          status: response.status,
          contentType: response.headers.get("content-type"),
          bytes: buffer.byteLength,
          base64: btoa(binary),
        };
        items.push(item);
        post("progress", { message: `Collected ${items.length} confirmations...` });
      }

      const tradeLinks = [...document.querySelectorAll("a,button,[role=button]")]
        .filter((element) => /\/\s*\d{6,}/.test(element.innerText || element.textContent || ""))
        .filter((element) => !/Adobe/i.test(element.innerText || element.textContent || ""));

      post("progress", { message: `Found ${tradeLinks.length} trade confirmations` });

      for (const [tradeIndex, link] of tradeLinks.entries()) {
        const itemIndex = stockButtons.length + tradeIndex;
        const label = (link.innerText || link.textContent || "").trim().replace(/\s+/g, " ");
        const parsedRow = tradeRows[tradeIndex] || {};
        const date = parsedRow.date || String(tradeIndex + 1).padStart(2, "0");
        const row = parsedRow.row || label;

        const responsePromise = new Promise((resolve) => {
          tradeWaiters.push(resolve);
          setTimeout(() => resolve({ error: "Timed out waiting for trade confirmation PDF XHR" }), 15000);
        });
        link.click();
        const response = await responsePromise;
        const item = {
          index: itemIndex,
          row,
          label,
          type: "trade",
          date,
          quantity: "",
          ...response,
        };
        items.push(item);
        post("progress", { message: `Collected ${items.length} confirmations...` });
      }

      assignFilenames(items);
      post("result", {
        pageUrl: location.href,
        pageTitle: document.title,
        collectedAt: new Date().toISOString(),
        items,
      });
    } finally {
      window.open = oldOpen;
      Document.prototype.createElement = oldCreateElement;
      HTMLElement.prototype.click = oldHtmlClick;
      XMLHttpRequest.prototype.open = oldXhrOpen;
      XMLHttpRequest.prototype.send = oldXhrSend;
    }
  }

  run().catch((error) => {
    post("error", { message: error.message || String(error) });
  });
})();
