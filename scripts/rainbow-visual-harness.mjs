import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { SignJWT } from "jose";
import WebSocket from "ws";

const BASE_URL = "http://127.0.0.1:3000";
const OUTPUT_DIR = "/tmp/rainbow20415-visual";
const DEBUG_PORT = 9335;

const delay = (milliseconds) =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForJson(url, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chromium is still starting.
    }
    await delay(125);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.on("message", rawMessage => {
    const message = JSON.parse(rawMessage.toString());
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result ?? {});
  });

  return {
    ready,
    async send(method, params = {}) {
      await ready;
      const id = nextId;
      nextId += 1;
      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function createSessionToken() {
  const openId = process.env.OWNER_OPEN_ID;
  const appId = process.env.VITE_APP_ID;
  const name = process.env.OWNER_NAME || "Project Owner";
  const secret = process.env.JWT_SECRET;

  if (!openId || !appId || !secret) {
    throw new Error("OWNER_OPEN_ID, VITE_APP_ID and JWT_SECRET are required");
  }

  return new SignJWT({ openId, appId, name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor((Date.now() + 15 * 60 * 1000) / 1000))
    .sign(new TextEncoder().encode(secret));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result?.value;
}

async function navigateAndCapture(cdp, pathname, filename, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
  await cdp.send("Page.navigate", { url: `${BASE_URL}${pathname}` });
  await delay(5000);

  const bodyText = await evaluate(cdp, "document.body.innerText");
  const currentUrl = await evaluate(cdp, "location.href");
  await writeFile(`${OUTPUT_DIR}/${filename}.txt`, `${currentUrl}\n\n${bodyText}`);

  const metrics = await cdp.send("Page.getLayoutMetrics");
  const contentSize = metrics.cssContentSize ?? metrics.contentSize;
  const width = Math.min(Math.ceil(contentSize.width), 1800);
  const height = Math.min(Math.ceil(contentSize.height), 12000);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  await writeFile(`${OUTPUT_DIR}/${filename}.png`, Buffer.from(screenshot.data, "base64"));

  return { pathname, currentUrl, bodyText, width, height };
}

await mkdir(OUTPUT_DIR, { recursive: true });
const sessionToken = await createSessionToken();
const chrome = spawn(
  "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=/tmp/rainbow20415-chrome-${process.pid}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

let cdp;
try {
  await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const targetResponse = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`,
    { method: "PUT" }
  );
  const target = await targetResponse.json();
  cdp = createCdpClient(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { if (location.origin === ${JSON.stringify(BASE_URL)}) sessionStorage.setItem("manus-cookie", ${JSON.stringify(sessionToken)}); } catch {}`,
  });

  const desktop = { width: 1440, height: 1000, mobile: false };
  const mobile = { width: 390, height: 844, mobile: true };
  const results = [];
  results.push(await navigateAndCapture(cdp, "/strategies", "strategies-desktop", desktop));
  results.push(await navigateAndCapture(cdp, "/backtest", "backtest-desktop", desktop));
  results.push(await navigateAndCapture(cdp, "/parameter-snapshots", "snapshots-desktop", desktop));
  results.push(await navigateAndCapture(cdp, "/strategies", "strategies-mobile", mobile));

  for (const result of results) {
    const summary = result.bodyText.replace(/\s+/g, " ").slice(0, 180);
    console.log(`${result.pathname} -> ${result.currentUrl} [${result.width}x${result.height}] ${summary}`);
  }
} finally {
  cdp?.close();
  chrome.kill("SIGTERM");
  await delay(300);
}
