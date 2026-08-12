import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = join(root, "browser-evidence");
const require = createRequire("C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\package.json");
const { chromium } = require("playwright");
const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
await mkdir(evidenceDir, { recursive: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4177/", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  const firstUse = {
    heading: await page.getByRole("heading", { name: "先确认数据位置，再开始记录课堂" }).isVisible(),
    localBoundary: await page.getByText(/当前未配置云同步，数据只保存在这个浏览器/).isVisible(),
    overwriteWarning: await page.getByText(/JSON 恢复会替换当前学期、名单、考勤、成绩和抽名记录/).isVisible(),
    cloudNotAssumed: await page.getByText(/电脑与手机不会自动同步/).isVisible(),
  };
  await page.getByRole("button", { name: "确认数据边界并进入系统" }).click();
  await page.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await page.getByRole("button", { name: /数据健康与恢复$/ }).click();
  await page.getByRole("heading", { name: "当前为本地模式" }).waitFor();
  const health = {
    status: await page.locator(".health-card").nth(0).innerText(),
    revision: await page.locator(".health-card").nth(1).innerText(),
    pending: await page.locator(".health-card").nth(2).innerText(),
    safety: await page.locator(".health-card").nth(3).innerText(),
  };
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出当前本机版本", exact: true }).click(),
  ]);
  const downloadPath = await download.path();
  const exported = JSON.parse(await readFile(downloadPath, "utf8"));
  const backup = { suggestedFilename: download.suggestedFilename(), version: exported.version, hasSettings: Boolean(exported.settings) };

  await page.getByRole("button", { name: "查看使用说明" }).click();
  const reopened = await page.getByRole("heading", { name: "数据怎样保存、导入和同步" }).isVisible();
  await page.getByRole("button", { name: "我已了解" }).click();
  await page.reload({ waitUntil: "networkidle" });
  const guideDoesNotRepeat = await page.getByRole("heading", { name: "先确认数据位置，再开始记录课堂" }).count() === 0;
  await page.getByRole("button", { name: /数据健康与恢复$/ }).click();
  await page.screenshot({ path: join(evidenceDir, "v20-beta1-data-health-local.png"), fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  const mobile = await page.evaluate(() => ({
    innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    minVisibleButtonHeight: Math.min(...[...document.querySelectorAll("button")]
      .filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; })
      .map((node) => Math.round(node.getBoundingClientRect().height))),
  }));
  await page.screenshot({ path: join(evidenceDir, "v20-beta1-data-health-mobile.png"), fullPage: false });

  const report = { browser: "Google Chrome (local executable)", firstUse, health, backup, reopened, guideDoesNotRepeat, mobile };
  if (!Object.values(firstUse).every(Boolean) || backup.version !== "2.0" || !backup.hasSettings || !reopened || !guideDoesNotRepeat || mobile.overflow || mobile.minVisibleButtonHeight < 48) {
    throw new Error(`beta1 浏览器验收失败：${JSON.stringify(report)}`);
  }
  await writeFile(join(evidenceDir, "v20-beta1-browser-state.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
}
