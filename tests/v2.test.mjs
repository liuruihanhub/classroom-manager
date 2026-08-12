import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DATA_VERSION,
  createFictionalDataset,
  migrateAndValidateDatabase,
  migrateDatabaseToV2,
  validateDatabase,
} from "../src/core.mjs";
import { inspectStoredData, DATA_KEY } from "../src/storage.js";
import {
  recentWorkspaceOfferings,
  recordWorkspacePerformance,
  rememberWorkspaceOffering,
  startWorkspaceAttendance,
  workspaceOffering,
} from "../src/workspace-core.mjs";

function legacy(version = "1.1") {
  const data = createFictionalDataset();
  data.version = version;
  delete data.settings.workspaceContext;
  delete data.settings.onboarding;
  data.unknownLegacyField = { preserve: true };
  data.settings.unknownTeacherPreference = "保留";
  return data;
}

class ReadTrackingStorage {
  constructor(raw) { this.map = new Map([[DATA_KEY, raw]]); this.writeCount = 0; }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.writeCount += 1; this.map.set(key, value); }
  removeItem(key) { this.writeCount += 1; this.map.delete(key); }
  key(index) { return [...this.map.keys()][index] ?? null; }
  get length() { return this.map.size; }
}

test("2.0 迁移保持全部旧 ID、业务记录和未知字段，1.1/1.2 各连续100次结果一致", () => {
  for (const sourceVersion of ["1.1", "1.2"]) {
    const source = legacy(sourceVersion);
    const original = JSON.stringify(source);
    const expectedIds = {
      semesters: source.semesters.map((item) => item.id),
      rosters: source.semesterRosters.map((item) => item.id),
      students: source.semesterRosters.flatMap((item) => item.students.map((student) => student.id)),
      attendance: source.attendanceSessions.map((item) => item.id),
    };
    let first = null;
    for (let index = 0; index < 100; index += 1) {
      const migrated = migrateAndValidateDatabase(source);
      first ??= migrated;
      assert.deepEqual(migrated, first);
      assert.equal(migrated.version, DATA_VERSION);
      assert.deepEqual(migrated.semesters.map((item) => item.id), expectedIds.semesters);
      assert.deepEqual(migrated.semesterRosters.map((item) => item.id), expectedIds.rosters);
      assert.deepEqual(migrated.semesterRosters.flatMap((item) => item.students.map((student) => student.id)), expectedIds.students);
      assert.deepEqual(migrated.attendanceSessions.map((item) => item.id), expectedIds.attendance);
      assert.deepEqual(migrated.unknownLegacyField, { preserve: true });
      assert.equal(migrated.settings.unknownTeacherPreference, "保留");
    }
    assert.equal(JSON.stringify(source), original, "迁移不得修改调用者的旧对象");
    assert.deepEqual(migrateDatabaseToV2(first), first, "2.0 数据再次迁移必须幂等");
  }
});

test("100次迁移失败不修改原对象，也不写 localStorage", () => {
  for (let index = 0; index < 100; index += 1) {
    const source = legacy(index % 2 ? "1.1" : "1.2");
    source.offerings[0].semesterId = "missing";
    const raw = JSON.stringify(source);
    const storage = new ReadTrackingStorage(raw);
    const inspection = inspectStoredData(storage);
    assert.equal(inspection.kind, "invalid");
    assert.match(inspection.error, /不存在/);
    assert.equal(storage.writeCount, 0);
    assert.equal(storage.getItem(DATA_KEY), raw);
    assert.equal(JSON.stringify(source), raw);
  }
});

test("2.0 当前数据严格校验课堂上下文，新字段引用不能悬空或重复", () => {
  const data = createFictionalDataset();
  const validId = data.offerings.find((item) => item.semesterId === "sem_2026").id;
  data.settings.workspaceContext = { offeringId: validId, recentOfferingIds: [validId] };
  assert.doesNotThrow(() => validateDatabase(data));
  const dangling = structuredClone(data); dangling.settings.workspaceContext.offeringId = "missing";
  assert.throws(() => validateDatabase(dangling), /不存在/);
  const duplicate = structuredClone(data); duplicate.settings.workspaceContext.recentOfferingIds = [validId, validId];
  assert.throws(() => validateDatabase(duplicate), /重复/);
});

test("课堂工作台一次选择后，考勤与课堂表现保持同一班级课程且只写一条事件", () => {
  const data = createFictionalDataset();
  const offering = data.offerings.find((item) => item.semesterId === "sem_2026" && item.classId === "class_2" && item.courseId === "course_diag");
  const remembered = rememberWorkspaceOffering(data, offering.id);
  assert.equal(remembered.settings.workspaceContext.offeringId, offering.id);
  assert.equal(recentWorkspaceOfferings(remembered)[0].offering.id, offering.id);
  const started = startWorkspaceAttendance(remembered, { offeringId: offering.id, date: "2026-10-01", sectionCount: 2, id: "att_workspace_alpha" });
  assert.equal(started.created, true);
  const continued = startWorkspaceAttendance(started.data, { offeringId: offering.id, date: "2026-10-01", sectionCount: 2, id: "must_not_be_used" });
  assert.equal(continued.created, false);
  assert.equal(continued.data.attendanceSessions.filter((item) => item.date === "2026-10-01" && item.classId === offering.classId && item.courseId === offering.courseId).length, 1);
  const student = workspaceOffering(continued.data, offering.id).students[0];
  const afterEvent = recordWorkspacePerformance(continued.data, { offeringId: offering.id, studentId: student.id, delta: 1, reason: "主动回答", id: "event_workspace_alpha", time: "2026-10-01T01:00:00.000Z" });
  assert.equal(afterEvent.performanceEvents.filter((item) => item.id === "event_workspace_alpha").length, 1);
  const event = afterEvent.performanceEvents.at(-1);
  assert.deepEqual([event.semesterId, event.classId, event.courseId], [offering.semesterId, offering.classId, offering.courseId]);
  const session = afterEvent.attendanceSessions.find((item) => item.id === "att_workspace_alpha");
  assert.deepEqual([session.semesterId, session.classId, session.courseId], [event.semesterId, event.classId, event.courseId]);
});

test("归档班级课程在工作台业务层拒绝考勤和课堂表现", () => {
  const data = createFictionalDataset();
  const archived = data.offerings.find((item) => item.semesterId === "sem_2025");
  const student = workspaceOffering(data, archived.id).students[0];
  assert.throws(() => startWorkspaceAttendance(data, { offeringId: archived.id, date: "2026-10-01", sectionCount: 2 }), /归档学期只读/);
  assert.throws(() => recordWorkspacePerformance(data, { offeringId: archived.id, studentId: student.id, delta: 1, reason: "不应写入" }), /归档学期只读/);
});

test("2.0-alpha 页面包含最近课堂两点击路径和一次点击课堂表现预设", async () => {
  const [main, workspace] = await Promise.all([
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/ClassroomWorkspace.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(main, /继续最近课堂/);
  assert.match(main, /page === "workspace"/);
  assert.match(workspace, /继续考勤/);
  assert.match(workspace, /保存本次考勤/);
  assert.match(workspace, /\+1 主动回答/);
  assert.match(workspace, /recordWorkspacePerformance/);
  assert.match(workspace, /归档学期不能继续抽名/);
});

test("2.0 SQL 写入门禁使用 auth.uid、CAS、4 MiB 与最近 20 个历史版本", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260812_v2_payload.sql", import.meta.url), "utf8");
  assert.match(sql, /p_payload->>'version' is distinct from '2\.0'/);
  assert.match(sql, /v_owner_id uuid := auth\.uid\(\)/);
  assert.doesNotMatch(sql, /p_owner_id/i);
  assert.match(sql, /octet_length\(p_payload::text\) > 4194304/);
  assert.match(sql, /workspaceContext/);
  assert.match(sql, /onboarding/);
  assert.match(sql, /p_expected_revision/);
  assert.match(sql, /revision_conflict/);
  assert.match(sql, /offset 20/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function[\s\S]*to authenticated/i);
});
