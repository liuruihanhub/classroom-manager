import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFictionalDataset } from "../src/core.mjs";
import { buildStudentCourseDetail, buildStudentSearchIndex, normalizeSearchText, searchStudents } from "../src/student-search-core.mjs";

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}

test("搜索索引只包含明确选择的使用中学期，并按 studentId 区分同名学生", () => {
  const data = createFictionalDataset();
  const currentRosters = data.semesterRosters.filter((item) => item.semesterId === "sem_2026");
  currentRosters[0].students[0].name = "同名学生";
  currentRosters[1].students[0].name = "同名学生";
  const index = buildStudentSearchIndex(data, "sem_2026");
  assert.equal(index.length, 360);
  assert.ok(index.every((item) => item.semesterId === "sem_2026"));
  assert.ok(index.every((item) => !item.studentId.includes("sem_2025")), "归档学期不得进入索引");
  const sameNames = searchStudents(index, "同名学生");
  assert.equal(sameNames.length, 2);
  assert.notEqual(sameNames[0].studentId, sameNames[1].studentId);
  assert.notEqual(sameNames[0].classId, sameNames[1].classId);
  assert.ok(sameNames.every((item) => item.courses.length === 2));
});

test("空学号、Unicode、无结果、超长输入与零课程班级均安全处理", () => {
  const data = createFictionalDataset();
  const roster = data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1");
  roster.students[0].studentNo = "";
  const firstId = roster.students[0].id;
  const index = buildStudentSearchIndex(data, "sem_2026");
  assert.deepEqual(searchStudents(index, ""), []);
  assert.deepEqual(searchStudents(index, "   "), []);
  assert.ok(!searchStudents(index, "不存在的学号").some((item) => item.studentId === firstId));
  assert.equal(searchStudents(index, "１０００２")[0].studentNo, "10002", "全角学号应按 NFKC 合理归一");
  assert.deepEqual(searchStudents(index, "完全没有这个学生"), []);
  assert.equal(normalizeSearchText(" Ａ".repeat(200)).length, 100);

  data.offerings = data.offerings.filter((item) => !(item.semesterId === "sem_2026" && item.classId === "class_1"));
  const noCourse = searchStudents(buildStudentSearchIndex(data, "sem_2026"), roster.students[1].name)[0];
  assert.equal(noCourse.studentId, roster.students[1].id);
  assert.deepEqual(noCourse.courses, [], "没有课程时仍返回学生，但不能伪造课程上下文");
});

test("多课程结果保留所有明确上下文，明细定位到准确 studentId 与 offeringId", () => {
  const data = createFictionalDataset();
  const index = buildStudentSearchIndex(data, "sem_2026");
  const result = searchStudents(index, "10001")[0];
  assert.equal(result.courses.length, 2);
  assert.deepEqual(result.courses.map((item) => item.courseName).sort((a, b) => a.localeCompare(b, "zh-CN")), ["新能源汽车结构与原理", "汽车故障诊断"].sort((a, b) => a.localeCompare(b, "zh-CN")));
  const attendanceCourse = result.courses.find((item) => item.courseId === "course_ev");
  const detail = buildStudentCourseDetail(data, { studentId: result.studentId, offeringId: attendanceCourse.offeringId });
  assert.equal(detail.student.id, result.studentId);
  assert.equal(detail.classItem.id, result.classId);
  assert.equal(detail.course.id, "course_ev");
  assert.equal(detail.sessions.length, 12);
  assert.equal(detail.scores.components.length, 3);
  assert.equal(detail.stats.缺勤, 3);
  assert.equal(detail.stats.迟到, 3);
  assert.equal(detail.stats.早退, 3);
});

test("100 个脚本式姓名按普通文本建立与搜索，不产生可执行拼接", async () => {
  const data = createFictionalDataset();
  const students = data.semesterRosters.filter((item) => item.semesterId === "sem_2026").flatMap((item) => item.students).slice(0, 100);
  const attacks = Array.from({ length: 100 }, (_, index) => `<img src=x onerror=window.__xss${index}=1>脚本${index}`);
  attacks.forEach((name, index) => { students[index].name = name; });
  const index = buildStudentSearchIndex(data, "sem_2026");
  for (let attackIndex = 0; attackIndex < attacks.length; attackIndex += 1) {
    const match = searchStudents(index, attacks[attackIndex])[0];
    assert.equal(match.name, attacks[attackIndex]);
  }
  const [component, core] = await Promise.all([
    readFile(new URL("../src/StudentSearch.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/student-search-core.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|innerHTML\s*=/);
  assert.doesNotMatch(core, /new RegExp|eval\s*\(|fetch\s*\(/);
});

test("1000 次实际 360 人索引搜索 p95 小于 100ms", () => {
  const data = createFictionalDataset();
  const index = buildStudentSearchIndex(data, "sem_2026");
  const durations = [];
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const expected = index[iteration % index.length];
    const query = iteration % 2 ? expected.studentNo : expected.name;
    const started = performance.now();
    const result = searchStudents(index, query);
    durations.push(performance.now() - started);
    assert.ok(result.some((item) => item.studentId === expected.studentId));
  }
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const max = Math.max(...durations);
  process.stdout.write(`SEARCH_METRIC count=1000 index=360 p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms\n`);
  assert.ok(p95 < 100, `p95 ${p95.toFixed(3)}ms 必须小于 100ms`);
});

test("搜索界面优先课堂工作台学期、显式切换、键盘滚动与模态焦点锁定", async () => {
  const [main, component] = await Promise.all([
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/StudentSearch.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(main, /lazy\(\(\) => import\("\.\/StudentSearch\.jsx"\)\)/, "搜索模块必须按需加载");
  assert.match(main, /workspaceOfferingId=\{data\.settings\.workspaceContext\.offeringId\}/);
  assert.match(component, /workspaceSemesterId[\s\S]*activeSemesters\.length === 1[\s\S]*""/);
  assert.match(component, /请选择当前要查找的学期/);
  assert.match(component, /if \(!result\.courses\.length\)[\s\S]*return;/, "零课程不得进入空选择页");
  assert.match(component, /ArrowDown[\s\S]*ArrowUp[\s\S]*Enter[\s\S]*Escape/);
  assert.match(component, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(component, /event\.key === "Tab"[\s\S]*event\.shiftKey[\s\S]*last\.focus\(\)/);
  assert.match(component, /requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\)\)/, "返回结果必须恢复搜索焦点");
});
