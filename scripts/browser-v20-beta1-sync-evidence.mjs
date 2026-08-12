import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = join(root, "browser-evidence");
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const evidenceTag = packageVersion === "2.0.0" ? "v20-final" : "v20-beta1";
const require = createRequire("C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\package.json");
const { chromium } = require("playwright");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const appUrl = "http://127.0.0.1:4177/";
const fakeUrl = "http://127.0.0.1:54331";

await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const state = () => fetch(`${fakeUrl}/__state`).then((response) => response.json());
const command = (name) => fetch(`${fakeUrl}/__${name}`, { method: "POST" }).then((response) => response.json());
async function waitRevision(minimum, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await state();
    if (current.current.revision >= minimum) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待假服务版本号 >= ${minimum} 超时；当前=${JSON.stringify(await state())}`);
}
async function login(page) {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.getByLabel("邮箱").fill("fictional.teacher@example.invalid");
  await page.getByLabel("密码").fill("browser-fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}
async function openHealth(page) {
  const target = page.getByRole("button", { name: /数据健康与恢复$/ });
  const box = await target.boundingBox();
  if (!box || box.x < 0) await page.getByRole("button", { name: "打开导航" }).click();
  await target.click();
  await page.getByRole("heading", { name: /本机与云端版本一致|同步未完成|当前网络不可用|登录状态可能已过期|云服务可能正在恢复/ }).waitFor();
  await page.getByText("云端最近 20 个历史版本", { exact: true }).waitFor();
}
async function exportCurrent(page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "导出当前本机版本", exact: true }).click()]);
  return { download, path: await download.path() };
}
function restoreButton(page, revision = 3) {
  return page.locator("tbody tr", { hasText: `v${revision}` }).getByRole("button", { name: "恢复为新版本" }).first();
}
async function localPending(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.endsWith(".pending"));
    if (!key) return null;
    const value = JSON.parse(localStorage.getItem(key));
    return { key, version: value.payload?.version, generation: value.generation, teacherName: value.payload?.settings?.teacherName };
  });
}

const report = { browser: "Google Chrome 正式构建 + 本地严格假 Supabase", build: packageVersion, fakeServiceScope: "仅证明客户端 Hook/Auth/REST/RPC/Realtime 语义，不代表真实 Supabase 上线" };
try {
  await command("unexpire");
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  await login(page);
  await page.getByRole("heading", { name: "先确认数据位置，再开始记录课堂" }).waitFor();
  const onboardingVisible = true;
  const cloudBoundary = await page.getByText(/当前部署已配置账号同步/).isVisible();
  if (!onboardingVisible) throw new Error(`登录后未显示首次引导：${(await page.locator("body").innerText()).slice(0, 1200)}`);
  const initialRevision = (await state()).current.revision;
  await page.getByRole("button", { name: "确认数据边界并进入系统" }).click();
  await page.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await page.waitForTimeout(700);
  if ((await state()).current.revision === initialRevision) {
    const storageDebug = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes("workbuddy.classroom"))));
    throw new Error(`首次引导确认未提交：页面=${(await page.locator("body").innerText()).slice(0, 700)}；存储键=${Object.keys(storageDebug).join(",")}`);
  }
  await waitRevision(initialRevision + 1);
  await page.reload({ waitUntil: "networkidle" });
  const noRepeat = await page.getByRole("heading", { name: "先确认数据位置，再开始记录课堂" }).count() === 0;
  await openHealth(page);
  await page.getByRole("button", { name: "查看使用说明" }).click();
  await page.getByRole("heading", { name: "数据怎样保存、导入和同步" }).waitFor();
  const reopened = true;
  await page.getByRole("button", { name: "我已了解" }).click();
  report.onboarding = { onboardingVisible, cloudBoundary, noRepeat, reopened, pass: onboardingVisible && cloudBoundary && noRepeat && reopened };

  await openHealth(page);
  const beforeExport = await state();
  const exportedCurrent = await exportCurrent(page);
  await waitRevision(beforeExport.current.revision + 1);
  const dialogs = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept(); });
  const beforeRestore = await state();
  await restoreButton(page).click();
  const restoredState = await waitRevision(beforeRestore.current.revision + 1);
  await page.getByText(/已通过版本校验恢复为新的云端版本/).waitFor();
  const unchangedTarget = restoredState.histories.find((item) => item.revision === 3);
  const safetyRow = page.locator("section.panel", { hasText: "本机安全副本" }).locator("tbody tr").first();
  await safetyRow.waitFor();
  const [safetyDownload] = await Promise.all([page.waitForEvent("download"), safetyRow.getByRole("button", { name: "导出此副本" }).click()]);
  const safetyPath = await safetyDownload.path();
  const safetyJson = JSON.parse(await readFile(safetyPath, "utf8"));
  await page.locator('input[type="file"][accept=".json"]').setInputFiles(safetyPath);
  await page.getByText("文件校验通过", { exact: true }).waitFor();
  const beforeJsonRestore = (await state()).current.revision;
  await page.getByRole("button", { name: "确认替换全部数据" }).click();
  await waitRevision(beforeJsonRestore + 1);
  report.successfulRestore = {
    exportedCurrentVersion: JSON.parse(await readFile(exportedCurrent.path, "utf8")).version,
    beforeRevision: beforeRestore.current.revision,
    afterRevision: restoredState.current.revision,
    confirmationDialogs: dialogs.slice(0, 2).length,
    targetHistoryStillPresent: Boolean(unchangedTarget),
    targetHistoryTeacher: unchangedTarget?.payload?.settings?.teacherName,
    safetyExportVersion: safetyJson.version,
    safetyJsonReimported: true,
    pass: restoredState.current.revision === beforeRestore.current.revision + 1 && dialogs.length >= 4 && Boolean(unchangedTarget) && safetyJson.version === "2.0",
  };

  await openHealth(page);
  const beforeEligibilityExport = await state();
  await exportCurrent(page);
  await waitRevision(beforeEligibilityExport.current.revision + 1);
  const absentInput = page.getByLabel("缺勤（节）");
  const nextThreshold = String(Number(await absentInput.inputValue()) + 1);
  await absentInput.fill(nextThreshold);
  const afterBusiness = await waitRevision(beforeEligibilityExport.current.revision + 2);
  await page.getByText(/必须先点页面顶部“导出当前本机版本”/).waitFor();
  const dialogsBeforeBlocked = dialogs.length;
  await restoreButton(page).click();
  await page.getByText(/恢复尚未开始：请先点“导出当前本机版本”/).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 350));
  report.eligibilityInvalidated = { changedThresholdTo: nextThreshold, dialogsOpened: dialogs.length - dialogsBeforeBlocked, remoteRevisionUnchanged: (await state()).current.revision === afterBusiness.current.revision, pass: dialogs.length === dialogsBeforeBlocked && (await state()).current.revision === afterBusiness.current.revision };

  const beforeConflictExport = await state();
  await exportCurrent(page);
  await waitRevision(beforeConflictExport.current.revision + 1);
  const competed = await command("compete");
  const remoteBeforeRestore = structuredClone(competed.current);
  await restoreButton(page).click();
  await page.getByRole("heading", { name: "本机与云端数据不同，系统已停止覆盖" }).waitFor();
  const afterConflict = await state();
  report.staleRestoreConflict = { competingRevision: remoteBeforeRestore.revision, afterRevision: afterConflict.current.revision, remoteTeacherName: afterConflict.current.payload.settings.teacherName, conflictVisible: true, pass: afterConflict.current.revision === remoteBeforeRestore.revision && afterConflict.current.payload.settings.teacherName === remoteBeforeRestore.payload.settings.teacherName };
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-sync-conflict.png`), fullPage: true });
  await context.close();

  await command("unexpire");
  const expiredContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const expiredPage = await expiredContext.newPage();
  await login(expiredPage);
  await expiredPage.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await openHealth(expiredPage);
  await command("expire");
  const expiredRemoteBefore = await state();
  await expiredPage.getByLabel("缺勤（节）").fill("8");
  await expiredPage.getByText(/登录状态已过期；本机数据和待同步修改均已保留/).waitFor();
  const expiredPending = await localPending(expiredPage);
  report.expiredSession = { status: await expiredPage.locator(".health-card").first().innerText(), pending: expiredPending, remoteUnchanged: (await state()).current.revision === expiredRemoteBefore.current.revision, pass: Boolean(expiredPending) && (await state()).current.revision === expiredRemoteBefore.current.revision };
  await expiredContext.close();

  await command("unexpire");
  const offlineContext = await browser.newContext({ viewport: { width: 375, height: 812 }, acceptDownloads: true });
  const offlinePage = await offlineContext.newPage();
  await login(offlinePage);
  await offlinePage.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await openHealth(offlinePage);
  const offlineRemoteBefore = await state();
  await offlineContext.setOffline(true);
  const [offlineDownload] = await Promise.all([offlinePage.waitForEvent("download"), offlinePage.getByRole("button", { name: "导出当前本机版本", exact: true }).click()]);
  await offlineDownload.path();
  const offlineDialogs = [];
  offlinePage.on("dialog", async (dialog) => { offlineDialogs.push(dialog.message()); await dialog.accept(); });
  await restoreButton(offlinePage).click();
  await offlinePage.getByText(/历史版本已保存在本机，但尚未写入云端/).waitFor();
  const offlinePending = await localPending(offlinePage);
  const mobile = await offlinePage.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
  report.offlineRestore = { confirmationDialogs: offlineDialogs.length, pending: offlinePending, remoteUnchanged: (await state()).current.revision === offlineRemoteBefore.current.revision, mobile, pass: offlineDialogs.length === 2 && Boolean(offlinePending) && (await state()).current.revision === offlineRemoteBefore.current.revision && !mobile.overflow };
  await offlinePage.screenshot({ path: join(evidenceDir, `${evidenceTag}-offline-restore-mobile.png`), fullPage: false });
  await offlineContext.close();

  const scenarioResults = [report.onboarding, report.successfulRestore, report.eligibilityInvalidated, report.staleRestoreConflict, report.expiredSession, report.offlineRestore];
  report.scenarios = scenarioResults.length;
  report.passed = scenarioResults.filter((item) => item.pass).length;
  report.pass = report.passed === report.scenarios;
  if (!report.pass) throw new Error(`严格假服务浏览器门槛失败：${JSON.stringify(report)}`);
  if (report.scenarios !== 6 || report.passed !== 6 || report.pass !== true) throw new Error(`同步证据顶层汇总无效：${JSON.stringify(report)}`);
  await writeFile(join(evidenceDir, `${evidenceTag}-sync-hook-state.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
}
