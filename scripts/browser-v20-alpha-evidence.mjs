import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = join(root, "browser-evidence");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const runtimeModules = "C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules";
const require = createRequire(`${runtimeModules}\\package.json`);
const { chromium } = require("playwright");
const appUrl = "http://127.0.0.1:4177/";

await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => { window.confirm = () => true; });
  await page.waitForTimeout(500);
  if (await page.getByRole("button", { name: /备份与设置$/ }).count() !== 1) {
    const body = (await page.locator("body").innerText()).slice(0, 600);
    throw new Error(`未进入本地模式主界面；页面=${body}；脚本错误=${pageErrors.join(" | ") || "无"}`);
  }

  await page.getByRole("button", { name: /备份与设置$/ }).click();
  await page.getByRole("button", { name: "载入虚构数据集", exact: true }).click();
  await page.getByText("虚构验收数据已载入", { exact: true }).waitFor();
  await page.getByRole("button", { name: /总览$/ }).click();

  let primaryClicks = 0;
  const firstAction = await page.getByRole("button", { name: "继续最近课堂", exact: true }).textContent();
  await page.getByRole("button", { name: "继续最近课堂", exact: true }).click();
  primaryClicks += 1;
  await page.locator("#workspace-context-title").waitFor();
  const attendanceButton = page.getByRole("button", { name: /^(开始|继续)考勤$/ });
  const secondAction = await attendanceButton.textContent();
  await attendanceButton.click();
  primaryClicks += 1;
  await page.locator(".workspace-attendance").waitFor();
  const editableAttendance = {
    rows: await page.locator(".workspace-attendance tbody tr").count(),
    enabledSelectors: await page.locator(".workspace-attendance select:enabled").count(),
  };

  const performanceCount = () => page.evaluate(() => {
    const value = localStorage.getItem("workbuddy.classroom.v1.1.data");
    return value ? JSON.parse(value).performanceEvents.length : -1;
  });
  let performanceClicks = 0;
  await page.getByRole("button", { name: "抽一名学生", exact: true }).click();
  performanceClicks += 1;
  const preset = page.getByRole("button", { name: "+1 主动回答", exact: true });
  await preset.waitFor();
  const beforeEventCount = await performanceCount();
  await preset.click();
  performanceClicks += 1;
  await page.waitForFunction((expected) => {
    const value = localStorage.getItem("workbuddy.classroom.v1.1.data");
    return value && JSON.parse(value).performanceEvents.length === expected;
  }, beforeEventCount + 1);
  const afterEventCount = await performanceCount();
  const winner = await page.locator(".workspace-action").nth(1).locator("h2").textContent();

  await page.screenshot({ path: join(evidenceDir, "v20-alpha-two-click-proof.png"), fullPage: false });
  await page.setViewportSize({ width: 375, height: 812 });
  const mobile = await page.evaluate(() => ({
    innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    minButtonHeight: Math.min(...[...document.querySelectorAll("button")]
      .filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; })
      .map((node) => Math.round(node.getBoundingClientRect().height))),
  }));

  const report = {
    browser: "Google Chrome (local executable, Playwright controller)",
    url: appUrl,
    recentClassToEditableAttendance: {
      firstAction, secondAction, primaryClicks, editableAttendance,
      pass: primaryClicks <= 2 && editableAttendance.rows === 60 && editableAttendance.enabledSelectors >= 60,
    },
    drawToPerformanceRecord: {
      winner, performanceClicks, beforeEventCount, afterEventCount,
      added: afterEventCount - beforeEventCount,
      pass: performanceClicks <= 2 && afterEventCount - beforeEventCount === 1,
    },
    mobile,
  };
  await writeFile(join(evidenceDir, "v20-alpha-two-click-proof.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.recentClassToEditableAttendance.pass || !report.drawToPerformanceRecord.pass) {
    throw new Error("2.0-alpha 课堂路径未达到点击门槛");
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
}
