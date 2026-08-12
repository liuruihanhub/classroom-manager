import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const currentDist = join(root, "dist");
const archive = join(root, "releases", "classroom-manager-v1.2.5-static.zip");
const evidenceDir = join(root, "browser-evidence");
const tempDir = await mkdtemp(join(tmpdir(), "workbuddy-v125-upgrade-"));
const profileDir = await mkdtemp(join(tmpdir(), "workbuddy-v125-profile-"));
const require = createRequire("C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\package.json");
const { chromium } = require("playwright");
const host = "127.0.0.1";
const port = 4182;
const appUrl = `http://${host}:${port}/`;
const dataKey = "workbuddy.classroom.v1.1.data";
const oldCache = "workbuddy-classroom-v1.2.5";
const currentCache = "workbuddy-classroom-v2.0";
const expectedArchiveHash = "93550B0A62F36E629EE0C03FE08D2C10A90A4D046529C8F7530215F32BB08AB0";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

await mkdir(evidenceDir, { recursive: true });
const archiveHash = createHash("sha256").update(await readFile(archive)).digest("hex").toUpperCase();
if (archiveHash !== expectedArchiveHash) throw new Error("v1.2.5 冻结静态包哈希不匹配");
await execFile("tar.exe", ["-xf", archive, "-C", tempDir]);
const oldDist = join(tempDir, "dist");
const oldWorker = await readFile(join(oldDist, "service-worker.js"), "utf8");
const currentWorker = await readFile(join(currentDist, "service-worker.js"), "utf8");
if (!oldWorker.includes(oldCache) || !oldWorker.includes("skipWaiting")) throw new Error("冻结包不是真实 v1.2.5 worker");
if (!currentWorker.includes(currentCache) || currentWorker.includes("skipWaiting")) throw new Error("当前构建不是等待式 2.0 worker");
const oldAssets = await readdir(join(oldDist, "assets"));
const oldLazyName = oldAssets.find((name) => /^browser-.*\.js$/.test(name));
if (!oldLazyName) throw new Error("v1.2.5 冻结包缺少旧 hash 懒块");
const oldLazyPath = `/assets/${oldLazyName}`;
const oldLazyBytes = await readFile(join(oldDist, "assets", oldLazyName));
const legacyFixture = await readFile(join(root, "tests", "fixtures", "v11-fictional-dataset.json"), "utf8");

let deployment = "v1.2.5";
let serverClosed = false;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, appUrl).pathname);
    const selectedDist = deployment === "v1.2.5" ? oldDist : currentDist;
    const target = resolve(selectedDist, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!target.startsWith(`${selectedDist}\\`) && target !== join(selectedDist, "index.html")) throw new Error("forbidden");
    if (!(await stat(target)).isFile()) throw new Error("not-file");
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store", ...(pathname === "/service-worker.js" ? { "Service-Worker-Allowed": "/" } : {}) });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
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

async function waitForActiveCache(page, cacheName) {
  await page.waitForFunction(async (expected) => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state === "activated" && (await caches.keys()).includes(expected);
  }, cacheName, { timeout: 15000 });
}

function namedNav(page, name) {
  return page.getByRole("button", { name: new RegExp(`${name}$`) });
}

function observe(page, errors) {
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
}

const context = await chromium.launchPersistentContext(profileDir, { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: "allow" });
const report = { browser: "Google Chrome 本机正式版 + Playwright 持久资料", sourceArchive: "classroom-manager-v1.2.5-static.zip", sourceArchiveSha256: archiveHash, sourceWorker: {}, waiting: {}, activation: {}, migration: {}, finalUi: {}, runtime: {} };
const pageErrors = [];
let page = context.pages()[0] ?? await context.newPage();
try {
  observe(page, pageErrors);
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await waitForActiveCache(page, oldCache);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: dataKey, value: legacyFixture });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "总览", exact: true }).waitFor();
  const dataBefore = await page.evaluate((key) => localStorage.getItem(key), dataKey);

  const beforeSwitchCache = await cacheSnapshot(page);
  report.sourceWorker = {
    cache: oldCache,
    oldLazyPath,
    oldLazyArchiveBytes: oldLazyBytes.byteLength,
    oldLazyNotPreviouslyCached: !beforeSwitchCache.entries.some((entry) => entry.url.endsWith(oldLazyPath)),
  };

  deployment = "2.0";
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  });
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === "installed", undefined, { timeout: 15000 });
  const waitingCaches = await cacheSnapshot(page);
  const newServerOldAssetStatus = (await fetch(`${appUrl}${oldLazyPath.slice(1)}`, { cache: "no-store" })).status;
  const oldLazyAfterDeploy = await page.evaluate(async (path) => {
    await import(path);
    const response = await fetch(path);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { ok: response.ok, bytes: bytes.byteLength };
  }, oldLazyPath);
  const dataDuringWaiting = await page.evaluate((key) => localStorage.getItem(key), dataKey);
  report.waiting = {
    caches: waitingCaches.names,
    oldCacheRetained: waitingCaches.names.includes(oldCache),
    currentWorkerWaiting: waitingCaches.names.includes(currentCache),
    newServerOldAssetStatus,
    oldLazyLoadedAfterDeploy: oldLazyAfterDeploy.ok && oldLazyAfterDeploy.bytes === oldLazyBytes.byteLength,
    oldPageHeading: await page.getByRole("heading", { name: "总览", exact: true }).innerText(),
    dataBytesEqual: dataDuringWaiting === dataBefore,
  };
  report.waiting.pass = report.sourceWorker.oldLazyNotPreviouslyCached && report.waiting.oldCacheRetained && report.waiting.currentWorkerWaiting && newServerOldAssetStatus === 200 && report.waiting.oldLazyLoadedAfterDeploy && report.waiting.dataBytesEqual;
  await page.screenshot({ path: join(evidenceDir, "v20-final-real-v125-waiting.png"), fullPage: false });

  await page.close();
  await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
  page = await context.newPage();
  observe(page, pageErrors);
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await waitForActiveCache(page, currentCache);
  await page.waitForFunction(async (oldName) => !(await caches.keys()).includes(oldName), oldCache);
  const afterActivation = await cacheSnapshot(page);
  const dataBeforeMigration = await page.evaluate((key) => localStorage.getItem(key), dataKey);
  await page.getByRole("heading", { name: "先核对摘要，再升级本机数据" }).waitFor();
  report.activation = { caches: afterActivation.names, oldCacheDeleted: !afterActivation.names.includes(oldCache), currentCacheOnly: afterActivation.names.length === 1 && afterActivation.names[0] === currentCache, dataBytesEqualBeforeTeacherMigration: dataBeforeMigration === dataBefore };
  report.activation.pass = report.activation.oldCacheDeleted && report.activation.currentCacheOnly && report.activation.dataBytesEqualBeforeTeacherMigration;

  await page.getByRole("button", { name: "确认升级到 2.0" }).click();
  await page.getByRole("heading", { name: "先确认数据位置，再开始记录课堂" }).waitFor();
  const migrated = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), dataKey);
  report.migration = { explicitTeacherAction: true, version: migrated.version, semesters: migrated.semesters.length, classes: migrated.classes.length, rosterEntries: migrated.semesterRosters.reduce((sum, roster) => sum + roster.students.length, 0) };
  report.migration.pass = migrated.version === "2.0" && migrated.semesters.length === 2 && migrated.classes.length === 6 && report.migration.rosterEntries === 720;
  await page.getByRole("button", { name: "确认数据边界并进入系统" }).click();
  await page.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await namedNav(page, "数据健康与恢复").click();
  await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
  await page.keyboard.press("Control+K");
  await page.getByLabel("姓名或非空学号").fill("10001");
  await page.getByText("找到 1 条结果", { exact: true }).waitFor();
  const finalCache = await cacheSnapshot(page);
  report.finalUi = {
    dataHealthOpened: true,
    studentSearchOpened: true,
    dataHealthCached: finalCache.entries.some((entry) => entry.cache === currentCache && /DataHealth-.*\.js$/.test(entry.url)),
    studentSearchCached: finalCache.entries.some((entry) => entry.cache === currentCache && /StudentSearch-.*\.js$/.test(entry.url)),
  };
  report.finalUi.pass = Object.values(report.finalUi).every(Boolean);
  await page.screenshot({ path: join(evidenceDir, "v20-final-real-v125-upgraded.png"), fullPage: false });

  report.runtime = { pageErrors, pass: pageErrors.length === 0 };
  report.pass = report.waiting.pass && report.activation.pass && report.migration.pass && report.finalUi.pass && report.runtime.pass;
  await writeFile(join(evidenceDir, "v20-final-real-v125-upgrade-state.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.pass) throw new Error(`真实 v1.2.5→2.0 升级失败：${JSON.stringify(report)}`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) report.failurePage = { url: page.url(), bodyText: await page.locator("body").innerText().catch(() => "") };
  await writeFile(join(evidenceDir, "v20-final-real-v125-upgrade-debug.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
} finally {
  await context.close();
  await closeServer();
  await rm(profileDir, { recursive: true, force: true });
  await rm(tempDir, { recursive: true, force: true });
}
