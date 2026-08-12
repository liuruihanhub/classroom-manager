import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const evidenceDir = join(root, "browser-evidence");
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const evidenceTag = packageVersion === "2.0.0" ? "v20-final" : "v20-rc1";
const require = createRequire("C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\package.json");
const { chromium } = require("playwright");
const host = "127.0.0.1";
const port = 4180;
const appUrl = `http://${host}:${port}/`;
const dataKey = "workbuddy.classroom.v1.1.data";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

await mkdir(evidenceDir, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, appUrl).pathname);
    const target = resolve(dist, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!target.startsWith(`${dist}\\`) && target !== join(dist, "index.html")) throw new Error("forbidden");
    if (!(await stat(target)).isFile()) throw new Error("not-file");
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(await readFile(target));
  } catch { response.writeHead(404); response.end("Not found"); }
});
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, resolveListen); });

function namedNav(page, name) { return page.getByRole("button", { name: new RegExp(`${name}$`) }); }
async function auditVisibleSemantics(page, pageName, selector = "body") {
  const result = await page.locator(selector).evaluate((rootNode) => {
    const visible = (node) => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
    const controls = [...rootNode.querySelectorAll("button, input, select, textarea")].filter(visible);
    const unnamedButtons = controls.filter((node) => node.tagName === "BUTTON" && !(node.getAttribute("aria-label") || node.getAttribute("aria-labelledby") || node.textContent.trim())).map((node) => node.outerHTML.slice(0, 160));
    const unlabeledFields = controls.filter((node) => node.tagName !== "BUTTON" && node.type !== "hidden" && !(node.labels?.length || node.getAttribute("aria-label") || node.getAttribute("aria-labelledby"))).map((node) => node.outerHTML.slice(0, 160));
    const ids = [...rootNode.querySelectorAll("[id]")].map((node) => node.id);
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    const headings = [...rootNode.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((node) => ({ level: Number(node.tagName.slice(1)), text: node.textContent.trim().slice(0, 80) }));
    const skippedHeadings = headings.filter((item, index) => index > 0 && item.level > headings[index - 1].level + 1);
    return { controlCount: controls.length, unnamedButtons, unlabeledFields, duplicateIds, skippedHeadings };
  });
  result.page = pageName;
  result.pass = !result.unnamedButtons.length && !result.unlabeledFields.length && !result.duplicateIds.length && !result.skippedHeadings.length;
  return result;
}

const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
const report = { browser: "Google Chrome 本机正式版 + Playwright", url: appUrl, build: `${packageVersion} dist（本地模式）`, semantics: [], viewports: {}, privacy: {}, print: {}, runtime: {} };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  const failedResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() }); });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  report.semantics.push(await auditVisibleSemantics(page, "首次说明"));
  await page.getByRole("button", { name: "确认数据边界并进入系统" }).click();
  await namedNav(page, "数据健康与恢复").click();
  await page.getByRole("button", { name: "载入虚构数据集", exact: true }).click();
  await page.getByText("虚构验收数据已载入", { exact: true }).waitFor();
  await namedNav(page, "总览").click();

  report.semantics.push(await auditVisibleSemantics(page, "总览"));
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-dashboard-1440.png`), fullPage: true });
  report.viewports.desktop1440 = await page.evaluate(() => ({ width: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));

  await namedNav(page, "课堂工作台").click();
  await page.locator("#workspace-context-title").waitFor();
  report.semantics.push(await auditVisibleSemantics(page, "课堂工作台"));
  const workspaceText = await page.locator(".page").innerText();
  report.privacy.workspaceProjection = { hasScore: /加权总分|学生成绩|初始分/.test(workspaceText), hasSensitiveNote: /家庭|医疗|身份证|其他备注/.test(workspaceText) };
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-workspace-1440.png`), fullPage: true });

  await namedNav(page, "基础数据").click();
  await page.getByText("请勿投屏 · 含学生名单", { exact: true }).waitFor();
  report.semantics.push(await auditVisibleSemantics(page, "基础数据"));
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-roster-1440.png`), fullPage: false });

  await namedNav(page, "考勤").click();
  await page.getByRole("button", { name: "生成考勤表" }).click();
  await page.locator(".attendance-editor").waitFor();
  report.semantics.push(await auditVisibleSemantics(page, "考勤"));
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-attendance-1440.png`), fullPage: false });

  await namedNav(page, "平时分").click();
  await page.getByText("请勿投屏 · 含学生成绩", { exact: true }).waitFor();
  report.semantics.push(await auditVisibleSemantics(page, "平时分"));
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-scores-1440.png`), fullPage: false });

  await namedNav(page, "快速抽名").click();
  const drawText = await page.locator(".page").innerText();
  report.privacy.drawProjection = { hasScore: /加权总分|学生成绩|初始分/.test(drawText), hasSensitiveNote: /家庭|医疗|身份证|其他备注/.test(drawText) };
  report.semantics.push(await auditVisibleSemantics(page, "快速抽名"));

  await namedNav(page, "报表").click();
  await page.getByText("请勿投屏 · 含学生信息", { exact: true }).waitFor();
  report.semantics.push(await auditVisibleSemantics(page, "报表"));
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-reports-1440.png`), fullPage: false });
  await page.emulateMedia({ media: "print" });
  report.print = await page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector(".sidebar")).display,
    topbar: getComputedStyle(document.querySelector(".topbar")).display,
    toolbar: getComputedStyle(document.querySelector(".toolbar-panel")).display,
    filters: getComputedStyle(document.querySelector(".no-print")).display,
    report: getComputedStyle(document.querySelector(".report-sheet")).display,
    privacyVisible: [...document.querySelectorAll(".privacy-badge,.privacy-warning")].some((node) => getComputedStyle(node).display !== "none"),
  }));
  report.print.pass = report.print.sidebar === "none" && report.print.topbar === "none" && report.print.toolbar === "none" && report.print.filters === "none" && report.print.report !== "none" && !report.print.privacyVisible;
  await page.emulateMedia({ media: "screen", reducedMotion: "reduce" });

  await namedNav(page, "数据健康与恢复").click();
  await page.getByText("请勿投屏 · 含备份与账号状态", { exact: true }).waitFor();
  report.semantics.push(await auditVisibleSemantics(page, "数据健康与恢复"));
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-data-health-1440.png`), fullPage: true });

  await page.keyboard.press("Control+K");
  await page.getByLabel("姓名或非空学号").fill("10001");
  await page.getByText("找到 1 条结果", { exact: true }).waitFor();
  await page.locator(".search-result").getByRole("button", { name: "查看平时分明细" }).first().click();
  await page.getByText("请勿投屏 · 个人考勤与成绩明细", { exact: true }).waitFor();
  report.semantics.push(await auditVisibleSemantics(page, "学生个人明细", ".search-dialog"));
  await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-student-detail-1440.png`), fullPage: false });
  await page.getByRole("button", { name: "关闭学生查找" }).click();

  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key));
    data.classes[0].name = "新能源汽车智能检测与维修技术超长班级名称用于响应式边界验证一二三四五六七八九十";
    data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === data.classes[0].id).students[0].name = "虚构超长姓名阿尔法贝塔伽马德尔塔艾普西隆用于布局验证";
    localStorage.setItem(key, JSON.stringify(data));
  }, dataKey);
  await page.reload({ waitUntil: "networkidle" });
  await namedNav(page, "基础数据").click();

  for (const [label, width, height] of [["tablet768", 768, 1024], ["zoom200Equivalent", 720, 500], ["mobile375", 375, 812]]) {
    await page.setViewportSize({ width, height });
    const state = await page.evaluate(() => ({
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      tableCanScrollInside: [...document.querySelectorAll(".table-scroll")].some((node) => node.scrollWidth > node.clientWidth),
      visibleButtonMinHeight: Math.min(...[...document.querySelectorAll("button")].filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; }).map((node) => Math.round(node.getBoundingClientRect().height))),
    }));
    state.pass = !state.overflow && (width > 760 || state.visibleButtonMinHeight >= 48);
    report.viewports[label] = state;
    await page.screenshot({ path: join(evidenceDir, `${evidenceTag}-${label}.png`), fullPage: false });
  }

  report.reducedMotion = await page.evaluate(() => ({
    matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
    toastAnimationDuration: getComputedStyle(Object.assign(document.createElement("div"), { className: "toast" })).animationDuration,
    rulePresent: [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } }).some((rule) => rule.media?.mediaText?.includes("prefers-reduced-motion")),
  }));
  report.reducedMotion.pass = report.reducedMotion.matches && report.reducedMotion.rulePresent;
  report.privacy.pass = !report.privacy.workspaceProjection.hasScore && !report.privacy.workspaceProjection.hasSensitiveNote && !report.privacy.drawProjection.hasScore && !report.privacy.drawProjection.hasSensitiveNote;
  report.semanticsPass = report.semantics.every((item) => item.pass);
  report.runtime = { pageErrors, failedResponses, pass: pageErrors.length === 0 && failedResponses.length === 0 };
  report.pass = report.semanticsPass && report.privacy.pass && report.print.pass && Object.values(report.viewports).every((item) => item.pass !== false) && report.reducedMotion.pass && report.runtime.pass;
  await writeFile(join(evidenceDir, `${evidenceTag}-browser-state.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.pass) throw new Error(`${packageVersion} 浏览器验收失败：${JSON.stringify(report)}`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
