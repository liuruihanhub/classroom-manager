import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  ATTENDANCE_STATUSES, DATA_VERSION, addScoreComponent, assertValidEventDelta, assertWritableSemester, attendanceStats,
  createFictionalDataset, deleteScoreComponent, deleteStudentSafely, drawStudent, exportDatabase,
  importDatabaseSafely, mulberry32, parseRosterText, rosterFor, studentScores, validateAttendanceSession,
  setAttendanceScoreRule, setStudentBaseScore, updateScoreComponent, validateDatabase, validateRoster, validateScore, warningRows,
} from "../src/core.mjs";
import { replaceDataAtomically } from "../src/storage.js";
import { parseStandaloneJson, parseStandaloneText } from "../standalone/import-core.mjs";

function clone(value) { return structuredClone(value); }
function fixture() { return createFictionalDataset(); }

test("未配置云同步时保持本地直接进入；云端密码只属于 Supabase 登录", async () => {
  const [main, storage] = await Promise.all([
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/storage.js", import.meta.url), "utf8"),
  ]);
  assert.match(main, /sync\.configured/);
  assert.match(main, /type="password"/);
  assert.match(main, /账号由学校指定管理员创建，不开放页面注册/);
  assert.doesNotMatch(main, /createPasswordLock|lockStorage|修改本地密码|>锁定</);
  assert.doesNotMatch(storage, /LOCK_KEY|SESSION_KEY|lockStorage/);
});

test("虚构数据集满足 2 学期、6 班×60人、2门课程及归档样例", () => {
  const data = validateDatabase(fixture());
  assert.equal(data.semesters.length, 2);
  assert.equal(data.semesters.filter((item) => item.archived).length, 1);
  assert.equal(data.classes.length, 6);
  assert.equal(data.courses.length, 2);
  assert.equal(data.semesterRosters.length, 12);
  data.semesterRosters.forEach((roster) => assert.equal(roster.students.length, 60));
  assert.equal(new Set(data.semesterRosters.flatMap((roster) => roster.students.map((student) => student.id))).size, 720);
});

test("学号可选：单列姓名、空学号和整库恢复均可用，非空学号仍须唯一", () => {
  const namesOnly = parseRosterText("姓名\n虚构学生甲\n虚构学生乙");
  assert.deepEqual(namesOnly.errors, []);
  assert.deepEqual(namesOnly.students.map((student) => [student.studentNo, student.name]), [["", "虚构学生甲"], ["", "虚构学生乙"]]);
  assert.deepEqual(validateRoster(namesOnly.students), []);

  const optionalColumn = parseRosterText("学号\t姓名\n\t虚构学生丙\n0007\t虚构学生丁");
  assert.deepEqual(optionalColumn.errors, []);
  assert.deepEqual(optionalColumn.students.map((student) => student.studentNo), ["", "0007"]);
  assert.match(parseRosterText("学号\t姓名\n0007\t甲\n0007\t乙").errors[0], /重复学号/);

  const data = fixture();
  data.semesterRosters[0].students[0].studentNo = "";
  data.semesterRosters[0].students[1].studentNo = "";
  assert.doesNotThrow(() => validateDatabase(data));
  const restored = importDatabaseSafely(JSON.stringify(data), fixture());
  assert.equal(restored.ok, true);
  assert.equal(restored.data.semesterRosters[0].students[0].studentNo, "");

  let sequence = 0;
  const standalone = parseStandaloneText("姓名\n独立页虚构甲\n独立页虚构乙", (prefix) => `${prefix}_${sequence += 1}`);
  assert.deepEqual(standalone.map((student) => student.studentNo), ["", ""]);
  const standaloneJson = parseStandaloneJson([{ name: "独立页虚构丙" }], (prefix) => `${prefix}_${sequence += 1}`);
  assert.equal(standaloneJson.students[0].studentNo, "");
});

test("固定考勤样例精确统计7种状态并触发三类阈值", () => {
  const data = fixture();
  const reference = { semesterId: "sem_2026", courseId: "course_ev", classId: "class_1" };
  const student = rosterFor(data, reference.semesterId, reference.classId).students[0];
  const counts = attendanceStats(data, reference)[student.id];
  assert.deepEqual(counts, { 出勤: 0, 缺勤: 3, 迟到: 3, 早退: 3, 病假: 1, 事假: 1, 其他: 1 });
  assert.equal(counts.缺勤, 3, "病假、事假不得计入缺勤");
  const warnings = warningRows(data, reference).filter((row) => row.student.id === student.id);
  assert.deepEqual(warnings.map((row) => row.reason).sort(), ["早退3次", "缺勤3节", "迟到3次"]);
  assert.equal(warningRows(data, reference).length, 3);
  const invalid = clone(data.attendanceSessions.find((session) => session.semesterId === reference.semesterId && session.classId === reference.classId && session.courseId === reference.courseId));
  invalid.records[student.id][0] = { status: "其他", note: "" };
  assert.match(validateAttendanceSession(invalid)[0], /必须填写备注/);
});

test("个性化平时分：初始70分、考勤自动计分、权重与自定义项可调整", () => {
  assert.deepEqual(validateScore(0, 10), { ok: true, value: 0 });
  assert.deepEqual(validateScore(10, 10), { ok: true, value: 10 });
  assert.equal(validateScore(11, 10).ok, false);
  assert.equal(validateScore(-1, 10).ok, false);
  const data = fixture(); const reference = { semesterId: "sem_2026", courseId: "course_ev", classId: "class_1" }; const student = rosterFor(data, reference.semesterId, reference.classId).students[0];
  const offering = data.offerings.find((item) => item.semesterId === reference.semesterId && item.courseId === reference.courseId && item.classId === reference.classId);
  const initial = studentScores(data, { ...reference, studentId: student.id });
  assert.deepEqual(initial.components.map((item) => [item.name, item.base]), [["考勤", 70], ["课堂表现", 70], ["作业", 70]]);
  assert.equal(initial.考勤, 43, "缺勤、迟到、早退应按规则自动扣减考勤分");
  assert.equal(initial.总分, 64.6);
  data.scoreItems.push({ id: "score_test", ...reference, type: "作业", title: "边界作业", max: 20, scores: { [student.id]: 20 }, date: "2026-09-20" });
  data.performanceEvents.push({ id: "event_test", ...reference, studentId: student.id, delta: 2, reason: "回答问题", time: "2026-09-20T00:00:00.000Z", revokedAt: null });
  assert.equal(studentScores(data, { ...reference, studentId: student.id }).总分, 77.4);
  data.performanceEvents[0].delta = 1; data.performanceEvents[0].reason = "修改后的事由";
  assert.equal(studentScores(data, { ...reference, studentId: student.id }).总分, 77);
  data.performanceEvents[0].revokedAt = "2026-09-21T00:00:00.000Z";
  assert.equal(studentScores(data, { ...reference, studentId: student.id }).总分, 76.6);
  setStudentBaseScore(data, { offeringId: offering.id, studentId: student.id, componentId: "score_attendance", value: 80 });
  setAttendanceScoreRule(data, { offeringId: offering.id, status: "缺勤", value: -3 });
  updateScoreComponent(data, { offeringId: offering.id, componentId: "score_homework", name: "课后任务", weight: 30, defaultScore: 75 });
  const customId = addScoreComponent(data, { offeringId: offering.id, id: "score_custom", name: "课堂练习", weight: 10, defaultScore: 70 });
  assert.equal(customId, "score_custom"); assert.equal(studentScores(data, { ...reference, studentId: student.id }).components.length, 4);
  deleteScoreComponent(data, { offeringId: offering.id, componentId: customId });
  assert.equal(studentScores(data, { ...reference, studentId: student.id }).components.length, 3);
  assert.throws(() => deleteScoreComponent(data, { offeringId: offering.id, componentId: "score_attendance" }), /不能删除/);
  assert.throws(() => assertValidEventDelta(data, reference, "NaN"), /有限数字/);
  assert.throws(() => assertValidEventDelta(data, reference, 0), /非零/);
  assert.throws(() => assertValidEventDelta(data, reference, 9999), /不能超过/);
});

test("JSON 完整往返恢复", () => {
  const data = fixture(); const json = exportDatabase(data); const result = importDatabaseSafely(json, { sentinel: true });
  assert.equal(result.ok, true); assert.equal(result.data.version, DATA_VERSION); assert.equal(result.data.semesterRosters.length, 12); assert.equal(result.data.attendanceSessions.length, 13);
});

test("旧版固定成绩数据迁移为可见的历史成绩项，不静默丢弃", () => {
  const legacy = fixture();
  legacy.version = "1.1";
  delete legacy.settings.workspaceContext;
  delete legacy.settings.onboarding;
  const offering = legacy.offerings.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1" && item.courseId === "course_ev");
  delete offering.scoreConfig;
  const student = rosterFor(legacy, offering.semesterId, offering.classId).students[0];
  legacy.scoreItems.push({ id: "legacy_practice", semesterId: offering.semesterId, classId: offering.classId, courseId: offering.courseId, type: ["实训", "操作"].join(""), title: "旧版历史项目", max: 10, scores: { [student.id]: 8 } });
  const result = importDatabaseSafely(JSON.stringify(legacy), fixture());
  assert.equal(result.ok, true);
  const migratedOffering = result.data.offerings.find((item) => item.id === offering.id);
  const migrated = migratedOffering.scoreConfig.components.find((item) => item.name === "历史成绩（迁移）");
  assert.ok(migrated); assert.equal(migrated.weight, 0); assert.equal(result.data.scoreItems.at(-1).componentId, migrated.id);
  assert.equal(studentScores(result.data, { ...migratedOffering, studentId: student.id }).components.find((item) => item.id === migrated.id).score, 80);
});

test("畸形 JSON、错误版本和重复学号失败且返回原对象", () => {
  const current = fixture();
  const malformed = importDatabaseSafely("{bad", current); assert.equal(malformed.ok, false); assert.equal(malformed.data, current);
  const wrong = clone(current); wrong.version = "9.9"; const wrongResult = importDatabaseSafely(JSON.stringify(wrong), current); assert.equal(wrongResult.ok, false); assert.equal(wrongResult.data, current);
  const duplicate = clone(current); duplicate.semesterRosters[0].students[1].studentNo = duplicate.semesterRosters[0].students[0].studentNo; const duplicateResult = importDatabaseSafely(JSON.stringify(duplicate), current); assert.equal(duplicateResult.ok, false); assert.equal(duplicateResult.data, current);
});

test("整库攻击样例全部被拒绝，原数据引用保持不变", async (context) => {
  const attacks = [
    ["缺 settings", (data) => { delete data.settings; }],
    ["非法阈值", (data) => { data.settings.warningThresholds.absent = 0; }],
    ["非法默认节数", (data) => { data.settings.defaultSections = 13; }],
    ["offering悬空学期", (data) => { data.offerings[0].semesterId = "missing"; }],
    ["attendance悬空课程", (data) => { data.attendanceSessions[0].courseId = "missing"; }],
    ["score悬空班级", (data) => { const student = data.semesterRosters.at(-1).students[0]; data.scoreItems.push({ id: "attack_score", semesterId: "sem_2026", courseId: "course_ev", classId: "missing", type: "作业", title: "x", max: 10, scores: { [student.id]: 1 } }); }],
    ["event悬空学生", (data) => { data.performanceEvents.push({ id: "attack_event", semesterId: "sem_2026", courseId: "course_ev", classId: "class_1", studentId: "missing", delta: 1, reason: "x" }); }],
    ["draw悬空学生", (data) => { data.drawHistory.push({ id: "attack_draw", semesterId: "sem_2026", courseId: "course_ev", classId: "class_1", studentId: "missing", mode: "pure" }); }],
    ["非法考勤节数", (data) => { data.attendanceSessions[0].sectionCount = 0; }],
    ["考勤多余学生", (data) => { data.attendanceSessions[0].records.intruder = [{ status: "出勤", note: "" }]; }],
    ["考勤缺少学生", (data) => { delete data.attendanceSessions[0].records[Object.keys(data.attendanceSessions[0].records)[0]]; }],
    ["成绩项悬空引用", (data) => { const student = rosterFor(data, "sem_2026", "class_1").students[0]; data.scoreItems.push({ id: "attack_score", semesterId: "sem_2026", courseId: "course_ev", classId: "class_1", componentId: "missing", type: "自定义", title: "x", max: 10, scores: { [student.id]: 1 } }); }],
    ["非有限成绩", (data) => { const student = rosterFor(data, "sem_2026", "class_1").students[0]; data.scoreItems.push({ id: "attack_score", semesterId: "sem_2026", courseId: "course_ev", classId: "class_1", type: "作业", title: "x", max: 10, scores: { [student.id]: "Infinity" } }); }],
    ["非法成绩项权重", (data) => { data.offerings[0].scoreConfig.components[0].weight = -1; }],
    ["非法考勤计分规则", (data) => { data.offerings[0].scoreConfig.attendanceRules.缺勤 = Number.POSITIVE_INFINITY; }],
    ["初始分悬空学生", (data) => { data.offerings[0].scoreConfig.overrides.missing = { score_attendance: 70 }; }],
    ["重复顶层 id", (data) => { data.courses[1].id = data.courses[0].id; }],
  ];
  for (const [name, mutate] of attacks) await context.test(name, () => { const current = fixture(); const attacked = clone(current); mutate(attacked); const result = importDatabaseSafely(JSON.stringify(attacked), current); assert.equal(result.ok, false); assert.equal(result.data, current); });
});

test("replaceDataAtomically 在校验失败前不写 localStorage", () => {
  const calls = []; globalThis.localStorage = { setItem: (...args) => calls.push(args), getItem: () => null, removeItem: () => calls.push(["remove"]) };
  const invalid = fixture(); delete invalid.settings;
  assert.throws(() => replaceDataAtomically(invalid)); assert.equal(calls.length, 0);
  delete globalThis.localStorage;
});

test("归档业务守卫、历史引用删除保护与跨学期名单快照隔离", () => {
  const data = fixture();
  assert.throws(() => assertWritableSemester(data, "sem_2025"), /归档学期只读/);
  assert.doesNotThrow(() => assertWritableSemester(data, "sem_2026"));
  const archivedOffering = data.offerings.find((item) => item.semesterId === "sem_2025");
  assert.throws(() => addScoreComponent(data, { offeringId: archivedOffering.id, name: "归档攻击项" }), /归档学期只读/);
  assert.throws(() => setStudentBaseScore(data, { offeringId: archivedOffering.id, studentId: rosterFor(data, "sem_2025", archivedOffering.classId).students[0].id, componentId: "score_attendance", value: 90 }), /归档学期只读/);
  const archivedRoster = rosterFor(data, "sem_2025", "class_1"); const activeRoster = rosterFor(data, "sem_2026", "class_1"); const archivedName = archivedRoster.students[0].name;
  activeRoster.students[0].name = "新学期修改后的姓名"; assert.equal(archivedRoster.students[0].name, archivedName); assert.notEqual(activeRoster.students[0].id, archivedRoster.students[0].id);
  assert.throws(() => deleteStudentSafely(data, { semesterId: "sem_2026", classId: "class_1", studentId: activeRoster.students[0].id }), /已有考勤/);
  const unreferenced = { id: "stu_new_unreferenced", studentNo: "09999", name: "虚构新生" }; activeRoster.students.push(unreferenced); deleteStudentSafely(data, { semesterId: "sem_2026", classId: "class_1", studentId: unreferenced.id }); assert.equal(activeRoster.students.length, 60);
});

test("独立页可从主系统备份导入多学期班级且安全重置次数", () => {
  let sequence = 0; const makeTestId = (prefix) => `${prefix}_${sequence += 1}`; const data = fixture();
  data.semesterRosters[0].students[0].count = -10;
  const imported = parseStandaloneJson(data, makeTestId); assert.equal(imported.kind, "classes"); assert.equal(imported.classes.length, 12); assert.match(imported.classes[0].name, /2025—2026学年第二学期｜新能源1班/);
  assert.equal(imported.classes[0].students[0].count, 0); assert.ok(imported.classes.every((item) => item.students.every((student) => Number.isInteger(student.count) && student.count >= 0)));
  const simple = parseStandaloneJson([{ studentNo: "0001", name: "虚构甲", count: Number.POSITIVE_INFINITY }], makeTestId); assert.equal(simple.students[0].studentNo, "0001"); assert.equal(simple.students[0].count, 0);
  const names = imported.classes.map((item) => item.name); assert.equal(new Set(names).size, names.length);
});

test("主系统与独立抽名页都默认纯随机，且页面不再显示固定实训成绩项", async () => {
  const [main, standalone, template] = await Promise.all([
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../standalone/randomizer-entry.js", import.meta.url), "utf8"),
    readFile(new URL("../standalone/randomizer-template.html", import.meta.url), "utf8"),
  ]);
  assert.match(main, /useState\("pure"\)/);
  assert.match(standalone, /mode: "pure"/);
  assert.match(template, /option value="pure">纯随机<\/option><option value="weighted"/);
  assert.doesNotMatch(main, /实训操作/);
});

function stats(counts) {
  const values = Object.values(counts); const mean = values.reduce((sum, value) => sum + value, 0) / values.length; const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { coverage: values.filter((value) => value > 0).length / values.length, min: Math.min(...values), max: Math.max(...values), mean, cv: Math.sqrt(variance) / mean };
}

for (const mode of ["pure", "weighted"]) test(`${mode} 随机10000次覆盖全部合格学生且排除者永不入选`, () => {
  const students = Array.from({ length: 60 }, (_, index) => ({ id: `s${index}`, studentNo: String(index).padStart(3, "0"), name: `虚构学生${index}` }));
  const excluded = students[0]; const counts = Object.fromEntries(students.slice(1).map((student) => [student.id, 0])); const rng = mulberry32(mode === "pure" ? 20260810 : 20260811);
  for (let index = 0; index < 10000; index += 1) { const chosen = drawStudent(students, { mode, excludedIds: [excluded.id], counts, rng }); assert.notEqual(chosen.id, excluded.id); counts[chosen.id] += 1; }
  const result = stats(counts); console.log(`RANDOM_METRIC ${mode} coverage=${result.coverage.toFixed(4)} min=${result.min} max=${result.max} mean=${result.mean.toFixed(2)} cv=${result.cv.toFixed(4)}`);
  assert.equal(result.coverage, 1); assert.ok(result.min > 0); assert.ok(result.cv < (mode === "weighted" ? .08 : .25));
});

test("独立抽名交付物是无外链的单一 HTML", async () => {
  const html = await readFile(new URL("../deliverables/独立随机抽名.html", import.meta.url), "utf8");
  assert.match(html, /课堂随机抽名/); assert.match(html, /Excel \/ CSV \/ JSON/); assert.doesNotMatch(html, /<script[^>]+src=/i); assert.doesNotMatch(html, /<link[^>]+href=/i); assert.doesNotMatch(html, /(?:fetch|import)\s*\(\s*["']https?:\/\//i);
  assert.equal(html.match(/<\/script>/gi)?.length, 1, "内联包中的结束标签必须转义，不能提前截断脚本");
});

test("PWA manifest、service worker 与全部图标存在于构建产物", async () => {
  const dist = new URL("../dist/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", dist), "utf8"));
  assert.equal(manifest.display, "standalone"); assert.equal(manifest.start_url, "./");
  for (const icon of manifest.icons) await access(new URL(icon.src.replace(/^\.\//, ""), dist));
  await access(new URL("apple-touch-icon.png", dist)); await access(new URL("service-worker.js", dist));
  const index = await readFile(new URL("index.html", dist), "utf8"); assert.match(index, /manifest\.webmanifest/); assert.match(index, /apple-touch-icon\.png/);
  const worker = await readFile(new URL("service-worker.js", dist), "utf8"); assert.match(worker, /caches\.open/); assert.match(worker, /icon-192\.png/); assert.match(worker, /icon-512\.png/);
  assert.doesNotMatch(worker, /__PRECACHE_ASSETS__/); assert.match(worker, /\.\/assets\/index-[^"']+\.js/); assert.match(worker, /\.\/assets\/index-[^"']+\.css/);
});
