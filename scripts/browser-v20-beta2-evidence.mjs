import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const evidenceDir = join(root, "browser-evidence");
const require = createRequire("C:\\Users\\LRH\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\package.json");
const { chromium } = require("playwright");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const host = "127.0.0.1";
const port = 4179;
const appUrl = `http://${host}:${port}/`;
const dataKey = "workbuddy.classroom.v1.1.data";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

await mkdir(evidenceDir, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, appUrl).pathname);
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const target = resolve(dist, relative);
    if (!target.startsWith(`${dist}\\`) && target !== join(dist, "index.html")) throw new Error("forbidden");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not-file");
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, resolveListen); });

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const report = { browser: "Google Chrome 本机正式版 + Playwright", url: appUrl, build: "dist（未配置云同步）" };
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
  await page.getByRole("button", { name: "确认数据边界并进入系统" }).click();
  await page.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await page.getByRole("button", { name: /数据健康与恢复$/ }).click();
  await page.getByRole("button", { name: "载入虚构数据集", exact: true }).click();
  await page.getByText("虚构验收数据已载入", { exact: true }).waitFor();

  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key));
    data.semesterRosters.find((item) => item.semesterId === "sem_2025" && item.classId === "class_1").students[0].name = "只在归档学期的学生";
    localStorage.setItem(key, JSON.stringify(data));
  }, dataKey);
  await page.reload({ waitUntil: "networkidle" });
  await page.keyboard.press("Control+K");
  const input = page.getByLabel("姓名或非空学号");
  await input.fill("只在归档学期的学生");
  await page.getByText("没有找到匹配学生；请核对姓名或已填写的学号。").waitFor();
  report.archivedExcluded = { resultCount: await page.locator(".search-result").count(), pass: await page.locator(".search-result").count() === 0 };
  await input.press("Escape");
  await input.press("Escape");

  await page.evaluate((key) => {
    const data = JSON.parse(localStorage.getItem(key));
    data.semesters.find((item) => item.id === "sem_2025").archived = false;
    data.semesters.find((item) => item.id === "sem_2025").name = "另一使用中学期";
    const first = data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1").students[0];
    const second = data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_2").students[0];
    const attackName = '<img src=x onerror="window.__beta2Xss=1">同名学生';
    first.name = attackName;
    second.name = attackName;
    first.studentNo = "";
    data.offerings = data.offerings.filter((item) => !(item.semesterId === "sem_2026" && item.classId === "class_6"));
    data.settings.workspaceContext.offeringId = "off_sem_2026_class_1_course_ev";
    data.settings.workspaceContext.recentOfferingIds = ["off_sem_2026_class_1_course_ev"];
    localStorage.setItem(key, JSON.stringify(data));
  }, dataKey);
  await page.reload({ waitUntil: "networkidle" });
  await page.keyboard.press("Control+K");
  const semesterSelect = page.getByLabel("查找学期");
  const semesterOptions = await semesterSelect.evaluate((select) => [...select.options].map((option) => option.textContent));
  report.semesterSelection = {
    selected: await semesterSelect.inputValue(),
    options: semesterOptions,
    workspaceOptionMarked: semesterOptions.some((item) => item.includes("课堂工作台当前学期")),
  };
  report.semesterSelection.pass = report.semesterSelection.selected === "sem_2026" && report.semesterSelection.workspaceOptionMarked && semesterOptions.length === 3;

  await input.fill("同名学生");
  await page.getByText("找到 2 条结果", { exact: true }).waitFor();
  const sameNameResults = page.locator(".search-result");
  const resultIds = await sameNameResults.evaluateAll((nodes) => nodes.map((node) => node.id));
  const courseCounts = await sameNameResults.evaluateAll((nodes) => nodes.map((node) => node.querySelectorAll(".search-courses > div").length));
  const resultText = await sameNameResults.allTextContents();
  report.sameNameAndXss = {
    count: await sameNameResults.count(), resultIds, courseCounts,
    classesShown: ["新能源1班", "新能源2班"].every((className) => resultText.some((text) => text.includes(className))),
    rawTextVisible: resultText.every((text) => text.includes("<img src=x")),
    injectedImageCount: await page.locator(".search-result img").count(),
    executed: await page.evaluate(() => window.__beta2Xss === 1),
  };
  report.sameNameAndXss.pass = report.sameNameAndXss.count === 2 && new Set(resultIds).size === 2 && courseCounts.every((count) => count === 2) && report.sameNameAndXss.classesShown && report.sameNameAndXss.rawTextVisible && report.sameNameAndXss.injectedImageCount === 0 && !report.sameNameAndXss.executed;
  await page.screenshot({ path: join(evidenceDir, "v20-beta2-search-desktop.png"), fullPage: false });

  await input.press("Enter");
  await page.locator(".course-choice").waitFor();
  report.multipleCourses = { choiceCards: await page.locator(".course-choice > article").count(), noSilentSelection: await page.locator(".student-detail").count() === 0 };
  await page.keyboard.press("Escape");
  report.returnState = { query: await input.inputValue(), focused: await input.evaluate((node) => document.activeElement === node) };

  const classOneResult = page.locator(".search-result", { hasText: "新能源1班" });
  const evCourse = classOneResult.locator(".search-courses > div", { hasText: "新能源汽车结构与原理" });
  await evCourse.getByRole("button", { name: "查看考勤明细" }).click();
  await page.getByRole("heading", { name: /同名学生/ }).waitFor();
  report.targetedAttendance = {
    context: await page.locator(".student-detail .eyebrow").first().innerText(),
    rows: await page.locator('section[aria-labelledby="student-attendance-title"] tbody tr').count(),
    headingContainsRawName: (await page.locator(".student-detail h2").innerText()).includes("<img src=x"),
  };
  report.targetedAttendance.pass = report.targetedAttendance.context.includes("新能源1班") && report.targetedAttendance.context.includes("新能源汽车结构与原理") && report.targetedAttendance.rows === 12 && report.targetedAttendance.headingContainsRawName;
  await page.screenshot({ path: join(evidenceDir, "v20-beta2-student-attendance-detail.png"), fullPage: false });
  await page.getByRole("button", { name: "返回搜索结果" }).click();
  const evCourseAgain = page.locator(".search-result", { hasText: "新能源1班" }).locator(".search-courses > div", { hasText: "新能源汽车结构与原理" });
  await evCourseAgain.getByRole("button", { name: "查看平时分明细" }).click();
  report.targetedScores = {
    context: await page.locator(".student-detail .eyebrow").first().innerText(),
    rows: await page.locator('section[aria-labelledby="student-score-title"] tbody tr').count(),
  };
  report.targetedScores.pass = report.targetedScores.context.includes("新能源1班") && report.targetedScores.rows === 3;
  await page.getByRole("button", { name: "返回搜索结果" }).click();

  await input.fill("虚构学生");
  await page.getByText("找到 40 条结果", { exact: true }).waitFor();
  for (let index = 0; index < 25; index += 1) await input.press("ArrowDown");
  report.keyboardScroll = await page.evaluate(() => {
    const container = document.querySelector(".search-results").getBoundingClientRect();
    const active = document.querySelector(".search-result.active").getBoundingClientRect();
    return { activeIndex: Number(document.querySelector(".search-result.active").dataset.searchIndex), visible: active.top >= container.top - 1 && active.bottom <= container.bottom + 1 };
  });

  await input.fill("不会有结果的超长输入".repeat(20));
  await page.getByText("没有找到匹配学生；请核对姓名或已填写的学号。").waitFor();
  await input.focus();
  await page.keyboard.press("Tab");
  const tabWrapped = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "关闭学生查找");
  await page.keyboard.press("Shift+Tab");
  const shiftTabWrapped = await input.evaluate((node) => document.activeElement === node);
  report.focusTrap = { tabWrapped, shiftTabWrapped, pass: tabWrapped && shiftTabWrapped };
  await input.press("Escape");
  await input.fill("未填写学号");
  await page.getByText("没有找到匹配学生；请核对姓名或已填写的学号。").waitFor();
  report.emptyStudentNumber = { resultCount: await page.locator(".search-result").count(), pass: await page.locator(".search-result").count() === 0 };

  await input.fill("虚构学生6-01");
  await page.getByText("找到 1 条结果", { exact: true }).waitFor();
  await input.press("Enter");
  const zeroCourseStatus = await page.locator("#search-status").innerText();
  report.zeroCourse = { status: zeroCourseStatus, stayedInResults: await page.locator(".student-detail, .course-choice").count() === 0 };
  report.zeroCourse.pass = report.zeroCourse.stayedInResults && zeroCourseStatus.includes("尚未关联课程");

  await semesterSelect.selectOption("sem_2025");
  report.semesterSwitch = { selected: await semesterSelect.inputValue(), queryCleared: await input.inputValue() === "", status: await page.locator("#search-status").innerText() };
  report.semesterSwitch.pass = report.semesterSwitch.selected === "sem_2025" && report.semesterSwitch.queryCleared && report.semesterSwitch.status.includes("另一使用中学期");
  await semesterSelect.selectOption("sem_2026");

  await page.setViewportSize({ width: 375, height: 812 });
  await input.fill("同名学生");
  await page.getByText("找到 2 条结果", { exact: true }).waitFor();
  report.mobile = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".search-dialog button")].filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
    return {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      minVisibleButtonHeight: Math.min(...buttons.map((node) => Math.round(node.getBoundingClientRect().height))),
      dialogWidth: Math.round(document.querySelector(".search-dialog").getBoundingClientRect().width),
    };
  });
  report.mobile.pass = !report.mobile.overflow && report.mobile.minVisibleButtonHeight >= 48 && report.mobile.dialogWidth <= 375;
  await page.screenshot({ path: join(evidenceDir, "v20-beta2-search-mobile.png"), fullPage: false });

  report.multipleCourses.pass = report.multipleCourses.choiceCards === 2 && report.multipleCourses.noSilentSelection;
  report.returnState.pass = report.returnState.query === "同名学生" && report.returnState.focused;
  report.keyboardScroll.pass = report.keyboardScroll.activeIndex === 25 && report.keyboardScroll.visible;
  report.runtime = { pageErrors, failedResponses, pass: pageErrors.length === 0 && failedResponses.length === 0 };
  const gates = ["archivedExcluded", "semesterSelection", "sameNameAndXss", "multipleCourses", "returnState", "targetedAttendance", "targetedScores", "keyboardScroll", "focusTrap", "emptyStudentNumber", "zeroCourse", "semesterSwitch", "mobile", "runtime"];
  report.pass = gates.every((key) => report[key].pass);
  await writeFile(join(evidenceDir, "v20-beta2-browser-state.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.pass) throw new Error(`2.0-beta2 浏览器验收失败：${JSON.stringify(report)}`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
