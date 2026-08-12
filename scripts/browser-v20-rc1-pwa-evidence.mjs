import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const evidenceDir = join(root, "browser-evidence");
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const releaseLabel = packageVersion === "2.0.0" ? "2.0" : "2.0-rc1";
const evidenceTag = packageVersion === "2.0.0" ? "v20-final" : "v20-rc1";
const require = createRequire("C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\package.json");
const { chromium } = require("playwright");
const host = "127.0.0.1";
const port = 4181;
const appUrl = `http://${host}:${port}/`;
const dataKey = "workbuddy.classroom.v1.1.data";
const oldCache = "workbuddy-classroom-v2.0-beta2";
const currentCache = `workbuddy-classroom-v${releaseLabel}`;
const currentWorker = await readFile(join(dist, "service-worker.js"), "utf8");
if (!currentWorker.includes(`const CACHE = "${currentCache}"`) || currentWorker.includes("skipWaiting")) throw new Error("正式构建没有使用 RC1 等待式更新协议");
const beta2Worker = currentWorker.replace(currentCache, oldCache);
const beta2LazyProbe = 'export default "beta2-lazy-ok";';
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

await mkdir(evidenceDir, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), "workbuddy-rc1-pwa-"));
let workerVersion = "beta2";
let serverClosed = false;
let transportOnline = true;
const server = createServer(async (request, response) => {
  try {
    if (!transportOnline) {
      request.socket.destroy();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, appUrl).pathname);
    if (pathname === "/rest/v1/workbuddy-probe") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end('{"ok":true}');
      return;
    }
    if (pathname === "/assets/beta2-lazy-probe.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      response.end(beta2LazyProbe);
      return;
    }
    if (pathname === "/service-worker.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" });
      response.end(workerVersion === "beta2" ? beta2Worker : currentWorker);
      return;
    }
    const target = resolve(dist, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!target.startsWith(`${dist}\\`) && target !== join(dist, "index.html")) throw new Error("forbidden");
    if (!(await stat(target)).isFile()) throw new Error("not-file");
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, resolveListen); });

async function closeServer() {
  if (serverClosed) return;
  serverClosed = true;
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function cacheSnapshot(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const entries = [];
    for (const name of names) {
      const cache = await caches.open(name);
      entries.push(...(await cache.keys()).map((request) => ({ cache: name, url: request.url })));
    }
    return { names, entries };
  });
}

async function waitForActiveCache(page, expectedCache) {
  await page.waitForFunction(async (expected) => {
    const registration = await navigator.serviceWorker.getRegistration();
    const names = await caches.keys();
    return registration?.active?.state === "activated" && names.includes(expected);
  }, expectedCache, { timeout: 15000 });
}

async function waitForWaitingWorker(page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.waiting?.state === "installed";
  }, undefined, { timeout: 15000 });
}

function namedNav(page, name) {
  return page.getByRole("button", { name: new RegExp(`${name}$`) });
}

function observePage(page, pageErrors) {
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
}

const context = await chromium.launchPersistentContext(profileDir, { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: "allow" });
const report = { browser: "Google Chrome 本机正式版 + Playwright 持久资料", build: `${packageVersion} dist`, waitingProtocol: {}, activation: {}, apiBypass: {}, lazyOffline: {}, dataIntegrity: {}, runtime: {} };
const pageErrors = [];
let page = context.pages()[0] ?? await context.newPage();
try {
  observePage(page, pageErrors);
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await waitForActiveCache(page, oldCache);
  await page.getByRole("button", { name: "确认数据边界并进入系统" }).click();
  await namedNav(page, "数据健康与恢复").click();
  await page.getByRole("button", { name: "载入虚构数据集", exact: true }).click();
  await page.getByText("虚构验收数据已载入", { exact: true }).waitFor();
  await namedNav(page, "总览").click();
  const dataBeforeUpdate = await page.evaluate((key) => localStorage.getItem(key), dataKey);
  if (!dataBeforeUpdate) throw new Error("升级前没有可核对的业务数据");

  workerVersion = "rc1";
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error("没有 beta2 Service Worker");
    await registration.update();
  });
  await waitForWaitingWorker(page);
  await page.getByText("新版本已下载", { exact: true }).waitFor();

  const waitingRegistration = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return { active: registration?.active?.state ?? null, waiting: registration?.waiting?.state ?? null, controlled: Boolean(navigator.serviceWorker.controller) };
  });
  const duringWaiting = await cacheSnapshot(page);
  const beta2LazyValue = await page.evaluate(async () => (await import("./assets/beta2-lazy-probe.js")).default);
  await namedNav(page, "数据健康与恢复").click();
  await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
  const afterOldLazy = await cacheSnapshot(page);
  const dataDuringWaiting = await page.evaluate((key) => localStorage.getItem(key), dataKey);
  report.waitingProtocol = {
    registration: waitingRegistration,
    caches: duringWaiting.names,
    oldLazyValue: beta2LazyValue,
    oldLazyCachedInBeta2: afterOldLazy.entries.some((entry) => entry.cache === oldCache && entry.url.endsWith("/assets/beta2-lazy-probe.js")),
    updateMessage: "新版本已下载",
  };
  report.waitingProtocol.pass = waitingRegistration.active === "activated" && waitingRegistration.waiting === "installed" && waitingRegistration.controlled && duringWaiting.names.includes(oldCache) && duringWaiting.names.includes(currentCache) && beta2LazyValue === "beta2-lazy-ok" && report.waitingProtocol.oldLazyCachedInBeta2;
  report.dataIntegrity.waitingBytesEqual = dataDuringWaiting === dataBeforeUpdate;
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-pwa-update-waiting.png`), fullPage: false });

  await page.close();
  await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
  page = await context.newPage();
  observePage(page, pageErrors);
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await waitForActiveCache(page, currentCache);
  await page.waitForFunction(async (oldName) => !(await caches.keys()).includes(oldName), oldCache);
  const activated = await cacheSnapshot(page);
  const activationRegistration = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return { active: registration?.active?.state ?? null, waiting: Boolean(registration?.waiting), controlled: Boolean(navigator.serviceWorker.controller) };
  });
  const dataAfterActivation = await page.evaluate((key) => localStorage.getItem(key), dataKey);
  report.activation = { registration: activationRegistration, caches: activated.names };
  report.activation.pass = activationRegistration.active === "activated" && !activationRegistration.waiting && activationRegistration.controlled && activated.names.length === 1 && activated.names[0] === currentCache;
  report.dataIntegrity.activationBytesEqual = dataAfterActivation === dataBeforeUpdate;

  await page.evaluate(() => fetch("./rest/v1/workbuddy-probe").then((response) => response.json()));
  const afterProbe = await cacheSnapshot(page);
  report.apiBypass = { requestSucceeded: true, cached: afterProbe.entries.some((entry) => entry.url.includes("/rest/v1/workbuddy-probe")) };
  report.apiBypass.pass = report.apiBypass.requestSucceeded && !report.apiBypass.cached;

  await namedNav(page, "数据健康与恢复").click();
  await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
  await page.keyboard.press("Control+K");
  await page.getByLabel("姓名或非空学号").waitFor();
  await page.getByRole("button", { name: "关闭学生查找" }).click();
  const lazyCache = await cacheSnapshot(page);
  report.lazyOffline.cachedBeforeStop = {
    dataHealth: lazyCache.entries.some((entry) => entry.cache === currentCache && /DataHealth-.*\.js$/.test(entry.url)),
    studentSearch: lazyCache.entries.some((entry) => entry.cache === currentCache && /StudentSearch-.*\.js$/.test(entry.url)),
  };

  const repeatResults = [];
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        if (/\/(?:DataHealth|StudentSearch)-.*\.js$/.test(new URL(request.url).pathname)) await cache.delete(request);
      }
    }, currentCache);
    await page.reload({ waitUntil: "networkidle" });
    await namedNav(page, "数据健康与恢复").click();
    await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
    await page.keyboard.press("Control+K");
    await page.getByLabel("姓名或非空学号").waitFor();
    const written = await cacheSnapshot(page);
    const cacheWritten = written.entries.some((entry) => entry.cache === currentCache && /DataHealth-.*\.js$/.test(entry.url))
      && written.entries.some((entry) => entry.cache === currentCache && /StudentSearch-.*\.js$/.test(entry.url));
    await page.close();

    transportOnline = false;
    page = await context.newPage();
    observePage(page, pageErrors);
    let offlineOpened = false;
    let dataUnchanged = false;
    try {
      await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await namedNav(page, "数据健康与恢复").click();
      await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
      await page.keyboard.press("Control+K");
      await page.getByLabel("姓名或非空学号").waitFor();
      const networkUnavailable = await page.evaluate(async () => {
        try { await fetch("./__repeat_network_probe__", { cache: "no-store" }); return false; } catch { return true; }
      });
      offlineOpened = networkUnavailable;
      dataUnchanged = await page.evaluate((key) => localStorage.getItem(key), dataKey) === dataBeforeUpdate;
    } catch (error) {
      repeatResults.push({ cycle, cacheWritten, offlineOpened, dataUnchanged, error: error.message });
    }
    if (!repeatResults.some((item) => item.cycle === cycle)) repeatResults.push({ cycle, cacheWritten, offlineOpened, dataUnchanged });
    await page.close();

    transportOnline = true;
    page = await context.newPage();
    observePage(page, pageErrors);
    await page.goto(appUrl, { waitUntil: "networkidle" });
  }
  const repeatHits = repeatResults.filter((item) => item.cacheWritten && item.offlineOpened && item.dataUnchanged && !item.error).length;
  report.lazyOffline.repeat20 = { attempts: 20, hits: repeatHits, results: repeatResults, pass: repeatHits === 20 };
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-pwa-activated-online.png`), fullPage: false });

  await page.close();
  await closeServer();
  page = await context.newPage();
  observePage(page, pageErrors);
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  const networkUnavailable = await page.evaluate(async () => {
    try { await fetch("./__network_probe__", { cache: "no-store" }); return false; } catch { return true; }
  });
  await namedNav(page, "数据健康与恢复").click();
  await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
  await page.keyboard.press("Control+K");
  await page.getByLabel("姓名或非空学号").fill("10001");
  await page.getByText("找到 1 条结果", { exact: true }).waitFor();
  const offlineState = await page.evaluate((key) => ({ title: document.title, controlled: Boolean(navigator.serviceWorker.controller), data: localStorage.getItem(key) }), dataKey);
  report.lazyOffline = { ...report.lazyOffline, networkUnavailable, dataHealthOpened: true, studentSearchOpened: true, searchResult: "找到 1 条结果", title: offlineState.title, controlled: offlineState.controlled };
  report.lazyOffline.pass = report.lazyOffline.cachedBeforeStop.dataHealth && report.lazyOffline.cachedBeforeStop.studentSearch && report.lazyOffline.repeat20.pass && networkUnavailable && offlineState.controlled && offlineState.title === "教师课堂管理系统";
  report.dataIntegrity.offlineBytesEqual = offlineState.data === dataBeforeUpdate;
  report.dataIntegrity.pass = report.dataIntegrity.waitingBytesEqual && report.dataIntegrity.activationBytesEqual && report.dataIntegrity.offlineBytesEqual;
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-pwa-offline-lazy.png`), fullPage: false });

  report.runtime = { pageErrors, pass: pageErrors.length === 0 };
  report.pass = report.waitingProtocol.pass && report.activation.pass && report.apiBypass.pass && report.lazyOffline.pass && report.dataIntegrity.pass && report.runtime.pass;
  await writeFile(join(evidenceDir, `${evidenceTag}-pwa-state.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.pass) throw new Error(`${packageVersion} PWA 验收失败：${JSON.stringify(report)}`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) {
    report.failurePage = { url: page.url(), bodyText: await page.locator("body").innerText().catch(() => "") };
    await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-pwa-failure.png`), fullPage: false }).catch(() => {});
  }
  await writeFile(join(evidenceDir, `${evidenceTag}-pwa-debug-state.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
} finally {
  await context.close();
  await closeServer();
  await rm(profileDir, { recursive: true, force: true });
}
