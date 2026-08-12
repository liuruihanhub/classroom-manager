import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const evidenceDir = join(root, "browser-evidence");
const profileDir = await mkdtemp(join(tmpdir(), "workbuddy-v20-fresh-"));
const require = createRequire("C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\package.json");
const { chromium } = require("playwright");
const host = "127.0.0.1";
const port = 4183;
const appUrl = `http://${host}:${port}/`;
const dataKey = "workbuddy.classroom.v1.1.data";
const cacheName = "workbuddy-classroom-v2.0";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const fixture = JSON.parse(await readFile(join(root, "tests", "fixtures", "v2-fictional-dataset.json"), "utf8"));
fixture.settings.onboarding.completedVersion = "2.0";

await mkdir(evidenceDir, { recursive: true });
let serverClosed = false;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, appUrl).pathname);
    if (pathname === "/install-only.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end('<!doctype html><meta charset="utf-8"><title>安装探针</title><h1>仅安装离线资源</h1><script>navigator.serviceWorker.register("./service-worker.js");</script>');
      return;
    }
    const target = resolve(dist, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!target.startsWith(`${dist}\\`) && target !== join(dist, "index.html")) throw new Error("forbidden");
    if (!(await stat(target)).isFile()) throw new Error("not-file");
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store", ...(pathname === "/service-worker.js" ? { "Service-Worker-Allowed": "/" } : {}) });
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

function namedNav(page, name) {
  return page.getByRole("button", { name: new RegExp(`${name}$`) });
}

const context = await chromium.launchPersistentContext(profileDir, { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: "allow" });
const report = { browser: "Google Chrome 本机正式版 + Playwright 持久资料", install: {}, offlineFirstUse: {}, runtime: {} };
const pageErrors = [];
let page = context.pages()[0] ?? await context.newPage();
try {
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${appUrl}install-only.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(async (expected) => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === "activated" && (await caches.keys()).includes(expected);
  }, cacheName, { timeout: 15000 });
  const installed = await page.evaluate(async (expected) => {
    const cache = await caches.open(expected);
    const requests = await cache.keys();
    const assets = [];
    let totalBytes = 0;
    for (const request of requests) {
      if (!/\.(?:js|css)$/.test(new URL(request.url).pathname)) continue;
      const response = await cache.match(request);
      const bytes = (await response.arrayBuffer()).byteLength;
      totalBytes += bytes;
      assets.push({ url: request.url, bytes });
    }
    return { cacheNames: await caches.keys(), assets, totalBytes, controlled: Boolean(navigator.serviceWorker.controller) };
  }, cacheName);
  const required = ["Onboarding-", "ClassroomWorkspace-", "DataHealth-", "StudentSearch-"];
  report.install = {
    cacheNames: installed.cacheNames,
    jsCssCount: installed.assets.length,
    jsCssBytes: installed.totalBytes,
    requiredChunks: Object.fromEntries(required.map((name) => [name.slice(0, -1), installed.assets.some((item) => item.url.includes(name))])),
    appWasNotOpened: page.url().endsWith("/install-only.html"),
    controlled: installed.controlled,
  };
  report.install.pass = installed.cacheNames.length === 1 && installed.cacheNames[0] === cacheName && installed.assets.length === 16 && installed.totalBytes === 1790659 && Object.values(report.install.requiredChunks).every(Boolean) && report.install.appWasNotOpened;

  await closeServer();
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.getByRole("heading", { name: "先确认数据位置，再开始记录课堂" }).waitFor();
  const onboardingOpened = true;
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: dataKey, value: JSON.stringify(fixture) });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await namedNav(page, "课堂工作台").click();
  await page.locator("#workspace-context-title").waitFor();
  const workspaceOpened = true;
  await namedNav(page, "数据健康与恢复").click();
  await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
  const dataHealthOpened = true;
  await page.keyboard.press("Control+K");
  await page.getByLabel("姓名或非空学号").fill("10001");
  await page.getByText("找到 1 条结果", { exact: true }).waitFor();
  const studentSearchOpened = true;
  const networkUnavailable = await page.evaluate(async () => {
    try { await fetch("./__network_probe__", { cache: "no-store" }); return false; } catch { return true; }
  });
  report.offlineFirstUse = { onboardingOpened, workspaceOpened, dataHealthOpened, studentSearchOpened, networkUnavailable, title: await page.title(), controlled: await page.evaluate(() => Boolean(navigator.serviceWorker.controller)) };
  report.offlineFirstUse.pass = Object.values({ onboardingOpened, workspaceOpened, dataHealthOpened, studentSearchOpened, networkUnavailable }).every(Boolean) && report.offlineFirstUse.title === "教师课堂管理系统" && report.offlineFirstUse.controlled;
  await page.screenshot({ path: join(evidenceDir, "v20-final-fresh-install-offline-first-use.png"), fullPage: false });

  report.runtime = { pageErrors, pass: pageErrors.length === 0 };
  report.pass = report.install.pass && report.offlineFirstUse.pass && report.runtime.pass;
  await writeFile(join(evidenceDir, "v20-final-fresh-offline-state.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.pass) throw new Error(`2.0 全新安装离线首次使用失败：${JSON.stringify(report)}`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  report.failure = error.message;
  await writeFile(join(evidenceDir, "v20-final-fresh-offline-debug.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
} finally {
  await context.close();
  await closeServer();
  await rm(profileDir, { recursive: true, force: true });
}
