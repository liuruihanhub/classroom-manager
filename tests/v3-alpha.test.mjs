import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DATA_VERSION, createFictionalDataset, migrateAndValidateDatabase, migrateDatabaseToV3, validateDatabase } from "../src/core.mjs";
import { DATA_KEY, inspectStoredData } from "../src/storage.js";
import {
  addRosterStudents,
  addTagsToPeople,
  addTeachingNote,
  archiveTeachingNote,
  createPersonForStudent,
  linkStudentSnapshot,
  permanentlyDeleteTeachingNote,
  personSnapshots,
  personSummary,
  restoreTeachingNote,
  unlinkStudentSnapshot,
  updateTeachingNote,
} from "../src/profile-core.mjs";

class NoWriteStorage {
  constructor(raw) { this.raw = raw; this.writes = 0; }
  getItem(key) { return key === DATA_KEY ? this.raw : null; }
  setItem() { this.writes += 1; }
  removeItem() { this.writes += 1; }
}

async function v2Fixture() { return JSON.parse(await readFile(new URL("./fixtures/v2-fictional-dataset.json", import.meta.url), "utf8")); }

test("3.0-alpha 当前数据为360个稳定person、720快照，跨学期复用person且studentId不同", () => {
  const data = validateDatabase(createFictionalDataset());
  assert.equal(data.version, "3.0");
  assert.equal(data.people.length, 360);
  assert.equal(new Set(data.people.map((item) => item.id)).size, 360);
  const current = data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1").students[0];
  const archived = data.semesterRosters.find((item) => item.semesterId === "sem_2025" && item.classId === "class_1").students[0];
  assert.equal(current.personId, archived.personId);
  assert.notEqual(current.id, archived.id);
  assert.equal(personSnapshots(data, current.personId).length, 2);
});

test("同一2.0输入独立迁移100次产生业务等价且无碰撞的确定性personId，第二次迁移幂等", async () => {
  const source = await v2Fixture();
  const raw = JSON.stringify(source);
  let first;
  for (let index = 0; index < 100; index += 1) {
    const migrated = migrateAndValidateDatabase(source);
    first ??= migrated;
    assert.deepEqual(migrated, first);
    assert.equal(migrated.version, DATA_VERSION);
    assert.equal(migrated.people.length, 720, "旧快照不能按姓名或学号自动跨学期合并");
    assert.equal(new Set(migrated.people.map((item) => item.id)).size, 720);
    assert.equal(new Set(migrated.semesterRosters.flatMap((item) => item.students.map((student) => student.personId))).size, 720);
  }
  assert.deepEqual(migrateDatabaseToV3(first), first);
  assert.equal(JSON.stringify(source), raw);
});

test("2.0迁移失败100次原对象与localStorage保持不变", async () => {
  const source = await v2Fixture();
  source.offerings[0].semesterId = "missing";
  const raw = JSON.stringify(source);
  for (let index = 0; index < 100; index += 1) {
    const storage = new NoWriteStorage(raw);
    const inspection = inspectStoredData(storage);
    assert.equal(inspection.kind, "invalid");
    assert.equal(storage.writes, 0);
    assert.equal(storage.getItem(DATA_KEY), raw);
  }
  assert.equal(JSON.stringify(source), raw);
});

test("普通新增和批量导入原子建立全新person；失败不留下学生或档案", () => {
  const data = createFictionalDataset();
  const before = JSON.stringify(data);
  assert.throws(() => addRosterStudents(data, { semesterId: "sem_2026", classId: "class_1", students: [{ id: "new_a", name: "虚构新增甲", studentNo: "10001" }, { id: "new_b", name: "虚构新增乙", studentNo: "10001" }], personIdFactory: (_, index) => `new_person_${index}` }), /重复/);
  assert.equal(JSON.stringify(data), before);
  const added = addRosterStudents(data, { semesterId: "sem_2026", classId: "class_1", students: [{ id: "new_a", name: "同名学生", studentNo: "" }, { id: "new_b", name: "同名学生", studentNo: "" }], personIdFactory: (_, index) => `new_person_${index}` });
  assert.deepEqual(added.map((item) => item.personId), ["new_person_0", "new_person_1"]);
  assert.equal(data.people.filter((item) => item.id.startsWith("new_person_")).length, 2);
});

test("createPerson和批量标签在非法时间或缺失person时零部分写入", () => {
  const data = createFictionalDataset();
  const looseStudent = { id: "loose", name: "虚构待建档", studentNo: "" };
  assert.throws(() => createPersonForStudent(data, looseStudent, { personId: "bad", now: "not-a-time" }), /时间/);
  assert.equal(looseStudent.personId, undefined);
  assert.equal(data.people.some((item) => item.id === "bad"), false);
  const before = JSON.stringify(data.people);
  assert.throws(() => addTagsToPeople(data, { personIds: [data.people[0].id, "missing"], tags: ["待补交"] }), /不存在/);
  assert.equal(JSON.stringify(data.people), before);
});

test("同名不会自动关联；教师确认关联/解除只重绑快照且历史studentId不变，孤儿档案保留", () => {
  const data = createFictionalDataset();
  const roster = data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1");
  const first = roster.students[0]; const second = roster.students[1];
  second.name = first.name; second.studentNo = "";
  const sourcePerson = first.personId; const targetPerson = second.personId;
  const attendanceBefore = Object.keys(data.attendanceSessions[0].records);
  assert.throws(() => linkStudentSnapshot(data, { semesterId: "sem_2026", classId: "class_1", studentId: first.id, targetPersonId: targetPerson }), /二次确认/);
  assert.throws(() => linkStudentSnapshot(data, { semesterId: "sem_2026", classId: "class_1", studentId: first.id, targetPersonId: targetPerson, confirmed: true }), /同一学期/);
  const archived = data.semesterRosters.find((item) => item.semesterId === "sem_2025" && item.classId === "class_1").students[0];
  const newPerson = "person_unlinked_alpha";
  const result = unlinkStudentSnapshot(data, { semesterId: "sem_2026", classId: "class_1", studentId: first.id, confirmed: true, newPersonId: newPerson, now: "2026-08-12T00:00:00.000Z" });
  assert.equal(result.oldPersonId, sourcePerson);
  assert.equal(first.id, data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1").students[0].id);
  assert.deepEqual(Object.keys(data.attendanceSessions[0].records), attendanceBefore);
  assert.equal(data.people.some((item) => item.id === sourcePerson), true, "仍有旧快照或档案内容的person必须保留");
  assert.equal(personSummary(data, sourcePerson).snapshotCount, 1);
  assert.equal(data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1").students[0].personId, newPerson);
  assert.equal(data.profileEvents.at(-1).type, "association");
});

test("备注变更原子追加事实事件，归档恢复与永久删除前明确同步安全副本", () => {
  const data = createFictionalDataset();
  const student = data.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1").students[0];
  const context = { semesterId: "sem_2026", classId: "class_1", courseId: "course_ev" };
  addTeachingNote(data, { personId: student.personId, context, type: "课堂观察", text: "能按安全流程完成高压下电。", id: "note_alpha", now: "2026-08-12T01:00:00.000Z" });
  updateTeachingNote(data, { noteId: "note_alpha", text: "能独立按安全流程完成高压下电。", now: "2026-08-12T02:00:00.000Z" });
  archiveTeachingNote(data, { noteId: "note_alpha", now: "2026-08-12T03:00:00.000Z" });
  restoreTeachingNote(data, { noteId: "note_alpha", now: "2026-08-12T04:00:00.000Z" });
  archiveTeachingNote(data, { noteId: "note_alpha", now: "2026-08-12T05:00:00.000Z" });
  assert.deepEqual(data.profileEvents.filter((item) => item.entityId === "note_alpha").map((item) => item.type), ["note_created", "note_modified", "note_archived", "note_restored", "note_archived"]);
  const before = JSON.stringify(data);
  assert.throws(() => permanentlyDeleteTeachingNote(data, { noteId: "note_alpha", confirmed: true, safetyBackupWriter: () => Promise.resolve(true) }), /同步返回明确成功/);
  assert.equal(JSON.stringify(data), before);
  let saved;
  permanentlyDeleteTeachingNote(data, { noteId: "note_alpha", confirmed: true, safetyBackupWriter: (backup) => { saved = backup; return true; } });
  assert.equal(saved.teachingNotes.some((item) => item.id === "note_alpha"), true);
  assert.equal(data.teachingNotes.some((item) => item.id === "note_alpha"), false);
  assert.equal(data.profileEvents.at(-1).type, "note_deleted");
  assert.doesNotMatch(data.profileEvents.at(-1).detail, /高压下电/);
  assert.doesNotThrow(() => validateDatabase(data));
});

test("3.0整库校验拒绝档案上下文错绑、悬空来源、状态日期矛盾和无效日历", () => {
  const base = createFictionalDataset();
  const student = base.semesterRosters.find((item) => item.semesterId === "sem_2026" && item.classId === "class_1").students[0];
  const otherContext = { semesterId: "sem_2026", classId: "class_2", courseId: "course_ev" };
  const wrongContext = structuredClone(base);
  wrongContext.teachingNotes.push({ id: "bad_note", personId: student.personId, ...otherContext, type: "课堂观察", text: "虚构观察", tags: [], createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", pinned: false, followUpDate: null, status: "active", archivedAt: null });
  assert.throws(() => validateDatabase(wrongContext), /不属于/);
  const badArchive = structuredClone(base); badArchive.teachingNotes.push({ id: "bad_archive", personId: student.personId, semesterId: null, classId: null, courseId: null, type: "其他", text: "虚构观察", tags: [], createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", pinned: false, followUpDate: null, status: "archived", archivedAt: null });
  assert.throws(() => validateDatabase(badArchive), /不一致/);
  const badDate = structuredClone(base); badDate.learningGoals.push({ id: "bad_goal", personId: student.personId, title: "虚构目标", description: "", courseId: null, startDate: "2026-02-31", dueDate: null, status: "not_started", progress: [], createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", completedAt: null });
  assert.throws(() => validateDatabase(badDate), /有效/);
  const leap = structuredClone(base); leap.learningGoals.push({ id: "leap_goal", personId: student.personId, title: "虚构目标", description: "", courseId: null, startDate: "2028-02-29", dueDate: "2028-03-01", status: "not_started", progress: [], createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", completedAt: null });
  assert.doesNotThrow(() => validateDatabase(leap));
});

test("v3 SQL保持auth.uid/CAS/RLS边界、4MiB并要求全部档案数组", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260812_v3_profiles.sql", import.meta.url), "utf8");
  assert.match(sql, /p_payload->>'version' is distinct from '3\.0'/);
  assert.match(sql, /v_owner_id uuid := auth\.uid\(\)/);
  assert.doesNotMatch(sql, /p_owner_id/i);
  assert.match(sql, /octet_length\(p_payload::text\) > 4194304/);
  for (const key of ["people", "teachingNotes", "learningGoals", "followUps", "profileEvents"]) assert.match(sql, new RegExp(`p_payload->'${key}'`));
  assert.match(sql, /offset 20/i);
});
