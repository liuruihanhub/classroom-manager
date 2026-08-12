import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("2.0-rc1 使用完整语义 token、清晰焦点与 120–220ms 动效，并尊重减少动效", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const token of [
    "--color-page", "--color-surface", "--color-text", "--color-text-muted", "--color-border",
    "--color-primary", "--color-success", "--color-warning", "--color-danger", "--color-focus",
    "--color-chart-primary", "--color-chart-secondary", "--color-chart-alert",
  ]) assert.match(css, new RegExp(`${token}:`), `缺少语义 token ${token}`);
  assert.match(css, /--motion-fast:\s*(?:1[2-9]\d|2[01]\d|220)ms/);
  assert.match(css, /button:focus-visible[\s\S]*outline:\s*3px/);
  assert.match(css, /input:focus-visible[\s\S]*box-shadow/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*\.01ms/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|box-shadow:\s*0\s+(?:[2-9]\d|\d{3,})px/i, "不得堆叠渐变或厚重阴影");
});

test("成绩、个人明细、名单和数据健康明确请勿投屏，课堂投屏区不显示成绩或备注", async () => {
  const [main, search, health, workspace] = await Promise.all([
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/StudentSearch.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/DataHealth.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/ClassroomWorkspace.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(main, /请勿投屏 · 含学生成绩/);
  assert.match(main, /请勿投屏 · 含学生信息/);
  assert.match(main, /请勿投屏 · 含学生名单/);
  assert.match(search, /请勿投屏 · 个人考勤与成绩明细/);
  assert.match(health, /请勿投屏 · 含备份与账号状态/);
  assert.doesNotMatch(workspace, /加权总分|初始分|成绩明细|其他备注/);
});

test("核心考勤输入具备可访问名称，同步状态可读屏，危险操作不是一次 Enter 即执行", async () => {
  const [main, health] = await Promise.all([
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/DataHealth.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(main, /aria-label=\{`\$\{student\.name\}第\$\{index \+ 1\}节考勤状态`\}/);
  assert.match(main, /aria-label=\{`\$\{student\.name\}第\$\{index \+ 1\}节其他状态备注`\}/);
  assert.match(main, /role="status" aria-live="polite"/);
  assert.match(main, /删除 \$\{student\.name\}[\s\S]*confirm\("再次确认删除/);
  assert.match(main, /归档后[\s\S]*confirm\("再次确认/);
  assert.match(health, /导入会完整替换[\s\S]*confirm\("再次确认/);
  assert.match(health, /重试同步|重新连接/);
});

test("同步错误说明原因、数据是否保留和下一步，打印仅保留报表主体", async () => {
  const [syncCore, healthCore, css] = await Promise.all([
    readFile(new URL("../src/sync-core.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/data-health-core.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  for (const phrase of ["网络不可用", "登录状态已过期", "云服务暂不可用", "本机数据和待同步修改均已保留"]) assert.match(syncCore, new RegExp(phrase));
  for (const phrase of ["当前网络不可用", "登录状态可能已过期", "云服务可能正在恢复", "同步未完成"]) assert.match(healthCore, new RegExp(phrase));
  assert.match(css, /@media print[\s\S]*\.sidebar[\s\S]*\.privacy-badge[\s\S]*display:\s*none !important/);
  assert.match(css, /@media print[\s\S]*\.report-sheet, \.table-scroll[\s\S]*border:\s*0/);
});

test("首次说明保持按需加载，入口继续使用独立搜索/健康/工作台块", async () => {
  const main = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
  for (const component of ["ClassroomWorkspace", "DataHealth", "StudentSearch", "Onboarding"]) {
    assert.match(main, new RegExp(`const ${component} = lazy\\(\\(\\) => import\\(\"\\./${component}\\.jsx\"\\)\\)`));
  }
});

test("Service Worker 等待运行时缓存写入完成，按需页面可在首次在线后离线重开", async () => {
  const [worker, finalizer] = await Promise.all([
    readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/finalize-pwa.mjs", import.meta.url), "utf8"),
  ]);
  const main = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
  assert.match(worker, /async function cacheSuccessfulSameOrigin/);
  assert.match(worker, /const cache = await caches\.open\(CACHE\);[\s\S]*await cache\.put\(request, response\.clone\(\)\)/);
  assert.match(worker, /catch \{[\s\S]*valid network response/);
  assert.match(worker, /respondWith\([\s\S]*cacheSuccessfulSameOrigin\(event\.request, response\)/);
  assert.doesNotMatch(worker, /caches\.open\(CACHE\)\.then\(\(cache\) => cache\.put/);
  assert.doesNotMatch(worker, /skipWaiting/);
  assert.match(main, /registration\.waiting/);
  assert.match(main, /updatefound/);
  assert.match(main, /新版本已下载/);
  assert.match(main, /关闭所有本系统窗口后重新打开/);
  assert.match(finalizer, /readdir\(assetsDirectory\)/);
  assert.match(finalizer, /js\|css/);
  assert.match(finalizer, /!name\.endsWith\("\.map"\)/);
});
