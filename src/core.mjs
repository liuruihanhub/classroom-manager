export const DATA_VERSION = "3.0";
export const LEGACY_DATA_VERSIONS = Object.freeze(["1.1", "1.2", "2.0"]);
export const ATTENDANCE_STATUSES = ["出勤", "缺勤", "迟到", "早退", "病假", "事假", "其他"];
export const DEFAULT_ATTENDANCE_RULES = { "出勤": 0, "缺勤": -5, "迟到": -2, "早退": -2, "病假": 0, "事假": 0, "其他": 0 };
export const DEFAULT_SCORE_COMPONENTS = [
  { id: "score_attendance", name: "考勤", kind: "attendance", weight: 20, defaultScore: 70 },
  { id: "score_performance", name: "课堂表现", kind: "performance", weight: 40, defaultScore: 70 },
  { id: "score_homework", name: "作业", kind: "manual", weight: 40, defaultScore: 70 },
];

export function createDefaultScoreConfig() {
  return { components: DEFAULT_SCORE_COMPONENTS.map((item) => ({ ...item })), attendanceRules: { ...DEFAULT_ATTENDANCE_RULES }, overrides: {} };
}

export function scoreConfigFor(offering) {
  return offering?.scoreConfig ?? createDefaultScoreConfig();
}

export function migrateScoreConfiguration(candidate) {
  const copy = structuredClone(candidate);
  if (!Array.isArray(copy?.offerings) || !Array.isArray(copy?.scoreItems)) return copy;
  const legacyPracticeType = ["实训", "操作"].join("");
  copy.offerings.forEach((offering) => {
    if (offering.scoreConfig !== undefined) return;
    offering.scoreConfig = createDefaultScoreConfig();
    const legacyItems = copy.scoreItems.filter((item) => item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId && item.type === legacyPracticeType);
    if (!legacyItems.length) return;
    const componentId = `score_legacy_${offering.id}`;
    offering.scoreConfig.components.push({ id: componentId, name: "历史成绩（迁移）", kind: "manual", weight: 0, defaultScore: 70 });
    legacyItems.forEach((item) => { item.componentId = componentId; });
  });
  return copy;
}

function deterministicPersonId(studentId) {
  const encoded = [...String(studentId)].map((character) => character.codePointAt(0).toString(16)).join("_");
  return `person_v3_${encoded}`;
}

export function migrateDatabaseToV3(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("待升级数据不是有效对象");
  if (candidate.version === DATA_VERSION) return structuredClone(candidate);
  if (!LEGACY_DATA_VERSIONS.includes(candidate.version)) throw new Error(`数据版本不兼容：只支持 ${LEGACY_DATA_VERSIONS.join(" / ")} 升级到 ${DATA_VERSION}`);
  const copy = migrateScoreConfiguration(candidate);
  if (!copy.settings || typeof copy.settings !== "object" || Array.isArray(copy.settings)) throw new Error("旧数据缺少 settings，无法安全升级");
  if (copy.settings.workspaceContext === undefined) copy.settings.workspaceContext = { offeringId: null, recentOfferingIds: [] };
  if (copy.settings.onboarding === undefined) copy.settings.onboarding = { completedVersion: null };
  if (copy.settings.onboarding.completedVersion !== DATA_VERSION) copy.settings.onboarding.completedVersion = null;
  const peopleById = new Map(Array.isArray(copy.people) ? copy.people.map((person) => [person.id, person]) : []);
  (copy.semesterRosters ?? []).forEach((roster) => (roster.students ?? []).forEach((student) => {
    if (typeof student.personId !== "string" || !student.personId.trim()) student.personId = deterministicPersonId(student.id);
    if (!peopleById.has(student.personId)) peopleById.set(student.personId, {
      id: student.personId,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      teachingTip: "",
      tags: [],
      watchlisted: false,
    });
  }));
  copy.people = [...peopleById.values()];
  if (!Array.isArray(copy.teachingNotes)) copy.teachingNotes = [];
  if (!Array.isArray(copy.learningGoals)) copy.learningGoals = [];
  if (!Array.isArray(copy.followUps)) copy.followUps = [];
  if (!Array.isArray(copy.profileEvents)) copy.profileEvents = [];
  copy.version = DATA_VERSION;
  return copy;
}

export const migrateDatabaseToV2 = migrateDatabaseToV3;

export function migrateAndValidateDatabase(candidate) {
  return validateDatabase(migrateDatabaseToV3(candidate));
}

export function makeId(prefix = "id", now = Date.now(), random = Math.random) {
  return `${prefix}_${now.toString(36)}_${Math.floor(random() * 1e9).toString(36)}`;
}

export function createEmptyData() {
  return {
    version: DATA_VERSION,
    exportedAt: null,
    settings: {
      teacherName: "教师",
      warningThresholds: { absent: 3, late: 3, early: 3 },
      defaultSections: 2,
      backupReminderDays: 7,
      lastBackupAt: null,
      workspaceContext: { offeringId: null, recentOfferingIds: [] },
      onboarding: { completedVersion: null },
    },
    semesters: [], classes: [], semesterRosters: [], courses: [], offerings: [],
    attendanceSessions: [], scoreItems: [], performanceEvents: [], drawHistory: [],
    people: [], teachingNotes: [], learningGoals: [], followUps: [], profileEvents: [],
  };
}

export function normalizeStudentNo(value) {
  return String(value ?? "").trim();
}

export function parseDelimitedLine(line, delimiter) {
  const result = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { result.push(current); current = ""; }
    else current += char;
  }
  result.push(current);
  return result;
}

export function parseRosterText(text) {
  const rows = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const parsed = [];
  const errors = [];
  let columns = null;
  rows.forEach((line, index) => {
    const delimiter = line.includes("\t") ? "\t" : ",";
    const cells = parseDelimitedLine(line, delimiter).map((cell) => cell.trim());
    if (index === 0) {
      const studentNoIndex = cells.findIndex((cell) => /学号|student\s*no/i.test(cell));
      const nameIndex = cells.findIndex((cell) => /姓名|name/i.test(cell));
      if (nameIndex >= 0) { columns = { studentNoIndex, nameIndex }; return; }
    }
    const studentNo = normalizeStudentNo(columns ? (columns.studentNoIndex >= 0 ? cells[columns.studentNoIndex] : "") : (cells.length > 1 ? cells[0] : ""));
    const name = String(columns ? cells[columns.nameIndex] : (cells.length > 1 ? cells[1] : cells[0]) ?? "").trim();
    if (!name) errors.push(`第 ${index + 1} 行缺少姓名`);
    else parsed.push({ id: makeId("stu"), studentNo, name });
  });
  const duplicates = parsed.filter((student, index) => student.studentNo && parsed.findIndex((item) => item.studentNo === student.studentNo) !== index);
  if (duplicates.length) errors.push(`重复学号：${[...new Set(duplicates.map((item) => item.studentNo))].join("、")}`);
  return { students: parsed, errors };
}

export function validateRoster(students, existing = [], ignoreId = null) {
  const errors = [];
  const seen = new Set(existing.filter((item) => item.id !== ignoreId).map((item) => normalizeStudentNo(item.studentNo)).filter(Boolean));
  students.forEach((student, index) => {
    const no = normalizeStudentNo(student.studentNo);
    if (!String(student.name ?? "").trim()) errors.push(`第 ${index + 1} 行姓名为空`);
    if (no && seen.has(no)) errors.push(`学号 ${no} 在班级内重复`);
    if (no) seen.add(no);
  });
  return errors;
}

export function rosterFor(data, semesterId, classId) {
  return data.semesterRosters.find((item) => item.semesterId === semesterId && item.classId === classId);
}

export function studentsFor(data, reference) {
  return rosterFor(data, reference?.semesterId, reference?.classId)?.students ?? [];
}

export function assertWritableSemester(data, semesterId) {
  const semester = data.semesters.find((item) => item.id === semesterId);
  if (!semester) throw new Error("学期不存在");
  if (semester.archived) throw new Error("归档学期只读，不能修改");
  return semester;
}

export function assertValidEventDelta(data, reference, value) {
  const delta = Number(value);
  if (!Number.isFinite(delta) || delta === 0) throw new Error("课堂表现事件分值必须是非零有限数字");
  if (Math.abs(delta) > 100) throw new Error("单次事件绝对值不能超过 100 分");
  return delta;
}

function offeringById(data, offeringId) {
  const offering = data.offerings.find((item) => item.id === offeringId);
  if (!offering) throw new Error("班级课程不存在");
  return offering;
}

function writableScoreConfig(data, offeringId) {
  const offering = offeringById(data, offeringId);
  assertWritableSemester(data, offering.semesterId);
  offering.scoreConfig ??= createDefaultScoreConfig();
  return { offering, config: offering.scoreConfig };
}

function validateComponentInput(config, componentId, patch) {
  const current = config.components.find((item) => item.id === componentId);
  if (!current) throw new Error("成绩项不存在");
  const name = String(patch.name ?? current.name).trim();
  const weight = Number(patch.weight ?? current.weight);
  const defaultScore = Number(patch.defaultScore ?? current.defaultScore);
  if (!name) throw new Error("成绩项名称不能为空");
  if (config.components.some((item) => item.id !== componentId && item.name === name)) throw new Error(`成绩项名称重复：${name}`);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1000) throw new Error("权重必须是 0 到 1000 的有限数字");
  if (!Number.isFinite(defaultScore) || defaultScore < 0 || defaultScore > 100) throw new Error("初始分必须是 0 到 100 的有限数字");
  return { name, weight, defaultScore };
}

export function updateScoreComponent(data, { offeringId, componentId, name, weight, defaultScore }) {
  const { offering, config } = writableScoreConfig(data, offeringId);
  const component = config.components.find((item) => item.id === componentId);
  const values = validateComponentInput(config, componentId, { name, weight, defaultScore });
  const totalWeight = config.components.reduce((sum, item) => sum + (item.id === componentId ? values.weight : Number(item.weight)), 0);
  if (totalWeight <= 0) throw new Error("至少一个成绩项的权重必须大于 0");
  if (values.name !== component.name) data.scoreItems.filter((item) => item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId && !item.componentId && item.type === component.name).forEach((item) => { item.type = values.name; });
  Object.assign(component, values);
}

export function addScoreComponent(data, { offeringId, id = makeId("component"), name, weight = 10, defaultScore = 70 }) {
  const { config } = writableScoreConfig(data, offeringId);
  if (config.components.length >= 20) throw new Error("每个班级课程最多设置 20 个成绩项");
  if (config.components.some((item) => item.id === id)) throw new Error("成绩项 id 重复");
  config.components.push({ id, name: "待校验", kind: "manual", weight: 0, defaultScore: 70 });
  try { updateScoreComponent(data, { offeringId, componentId: id, name, weight, defaultScore }); }
  catch (error) { config.components = config.components.filter((item) => item.id !== id); throw error; }
  return id;
}

export function deleteScoreComponent(data, { offeringId, componentId }) {
  const { offering, config } = writableScoreConfig(data, offeringId);
  const component = config.components.find((item) => item.id === componentId);
  if (!component) throw new Error("成绩项不存在");
  if (component.kind === "attendance") throw new Error("考勤自动计分项不能删除");
  const hasScoreHistory = data.scoreItems.some((item) => item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId && (item.componentId === component.id || (!item.componentId && item.type === component.name)));
  const hasEventHistory = component.kind === "performance" && data.performanceEvents.some((item) => item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId);
  if (hasScoreHistory || hasEventHistory) throw new Error("该成绩项已有历史记录，不能删除；可把权重设为 0");
  config.components = config.components.filter((item) => item.id !== componentId);
  Object.values(config.overrides).forEach((row) => { delete row[componentId]; });
}

export function setStudentBaseScore(data, { offeringId, studentId, componentId, value, eventId = makeId("profile_event"), time = new Date().toISOString() }) {
  const { offering, config } = writableScoreConfig(data, offeringId);
  const student = studentsFor(data, offering).find((item) => item.id === studentId);
  if (!student) throw new Error("学生不在当前班级课程名单中");
  const component = config.components.find((item) => item.id === componentId);
  if (!component) throw new Error("成绩项不存在");
  const valid = validateScore(value, 100);
  if (!valid.ok) throw new Error(valid.error);
  config.overrides[studentId] ??= {};
  config.overrides[studentId][componentId] = valid.value;
  data.profileEvents.push({ id: eventId, personId: student.personId, semesterId: offering.semesterId, classId: offering.classId, courseId: offering.courseId, type: "score_change", entityId: componentId, detail: `${component.name}初始分调整为 ${valid.value}`, time });
}

export function setAttendanceScoreRule(data, { offeringId, status, value }) {
  const { config } = writableScoreConfig(data, offeringId);
  if (!ATTENDANCE_STATUSES.includes(status)) throw new Error("考勤状态无效");
  const score = Number(value);
  if (!Number.isFinite(score) || score < -100 || score > 100) throw new Error("考勤计分规则必须是 -100 到 100 的有限数字");
  config.attendanceRules[status] = score;
}

export function hasStudentReferences(data, studentId) {
  return data.attendanceSessions.some((session) => Object.hasOwn(session.records, studentId)) ||
    data.scoreItems.some((item) => Object.hasOwn(item.scores ?? {}, studentId)) ||
    data.performanceEvents.some((item) => item.studentId === studentId) ||
    data.drawHistory.some((item) => item.studentId === studentId);
}

export function deleteStudentSafely(data, { semesterId, classId, studentId }) {
  assertWritableSemester(data, semesterId);
  const roster = rosterFor(data, semesterId, classId);
  if (!roster) throw new Error("学期班级名单不存在");
  if (hasStudentReferences(data, studentId)) throw new Error("该学生已有考勤、成绩、事件或抽名历史，不能删除；可保留学生并在抽名时排除");
  const before = roster.students.length;
  roster.students = roster.students.filter((student) => student.id !== studentId);
  if (roster.students.length === before) throw new Error("学生不存在");
}

export function createAttendanceSession({ semesterId, courseId, classId, date, sectionCount = 2, students, id = makeId("att") }) {
  const count = Math.max(1, Math.min(12, Number(sectionCount) || 2));
  const records = {};
  students.forEach((student) => {
    records[student.id] = Array.from({ length: count }, () => ({ status: "出勤", note: "" }));
  });
  return { id, semesterId, courseId, classId, date, sectionCount: count, createdAt: new Date().toISOString(), records };
}

export function validateAttendanceSession(session) {
  const errors = [];
  Object.entries(session.records ?? {}).forEach(([studentId, sections]) => {
    if (!Array.isArray(sections) || sections.length !== session.sectionCount) errors.push(`${studentId} 的节次记录不完整`);
    (sections ?? []).forEach((record, index) => {
      if (!ATTENDANCE_STATUSES.includes(record.status)) errors.push(`${studentId} 第 ${index + 1} 节状态无效`);
      if (record.status === "其他" && !String(record.note ?? "").trim()) errors.push(`${studentId} 第 ${index + 1} 节“其他”必须填写备注`);
    });
  });
  return errors;
}

export function attendanceStats(data, filters = {}) {
  const sessions = data.attendanceSessions.filter((session) =>
    (!filters.semesterId || session.semesterId === filters.semesterId) &&
    (!filters.courseId || session.courseId === filters.courseId) &&
    (!filters.classId || session.classId === filters.classId));
  const byStudent = {};
  sessions.forEach((session) => {
    Object.entries(session.records).forEach(([studentId, sections]) => {
      byStudent[studentId] ??= Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0]));
      sections.forEach((record) => { byStudent[studentId][record.status] += 1; });
    });
  });
  return byStudent;
}

export function warningRows(data, filters = {}) {
  const thresholds = data.settings.warningThresholds;
  const rows = [];
  data.offerings.filter((offering) =>
    (!filters.semesterId || offering.semesterId === filters.semesterId) &&
    (!filters.courseId || offering.courseId === filters.courseId) &&
    (!filters.classId || offering.classId === filters.classId)).forEach((offering) => {
      const stats = attendanceStats(data, offering);
      const classItem = data.classes.find((item) => item.id === offering.classId);
      const course = data.courses.find((item) => item.id === offering.courseId);
      studentsFor(data, offering).forEach((student) => {
        const counts = stats[student.id] ?? {};
        [["缺勤", thresholds.absent, "节"], ["迟到", thresholds.late, "次"], ["早退", thresholds.early, "次"]].forEach(([status, threshold, unit]) => {
          if ((counts[status] ?? 0) >= threshold) {
            const records = data.attendanceSessions.filter((session) => session.semesterId === offering.semesterId && session.classId === offering.classId && session.courseId === offering.courseId).flatMap((session) => (session.records[student.id] ?? []).map((record, index) => ({ ...record, date: session.date, section: index + 1 })).filter((record) => record.status === status));
            rows.push({ student, classItem, course, semesterId: offering.semesterId, status, count: counts[status], reason: `${status}${counts[status]}${unit}`, records });
          }
        });
      });
    });
  return rows;
}

export function validateScore(value, max) {
  const score = Number(value);
  const maximum = Number(max);
  if (!Number.isFinite(score)) return { ok: false, error: "成绩必须是数字" };
  if (score < 0) return { ok: false, error: "成绩不能为负数" };
  if (score > maximum) return { ok: false, error: `成绩不能超过满分 ${maximum}` };
  return { ok: true, value: score };
}

export function studentScores(data, { semesterId, courseId, classId, studentId }) {
  const offering = data.offerings.find((item) => item.semesterId === semesterId && item.courseId === courseId && item.classId === classId);
  const config = scoreConfigFor(offering);
  const attendance = attendanceStats(data, { semesterId, courseId, classId })[studentId] ?? {};
  const events = data.performanceEvents.filter((event) => !event.revokedAt && event.semesterId === semesterId && event.courseId === courseId && event.classId === classId && event.studentId === studentId).reduce((sum, event) => sum + Number(event.delta), 0);
  const components = config.components.map((component) => {
    const override = config.overrides?.[studentId]?.[component.id];
    const legacyItems = data.scoreItems.filter((item) => item.semesterId === semesterId && item.courseId === courseId && item.classId === classId && (item.componentId === component.id || (!item.componentId && item.type === component.name)));
    const legacyMaximum = legacyItems.reduce((sum, item) => sum + Number(item.max), 0);
    const legacyScore = legacyItems.reduce((sum, item) => sum + Number(item.scores?.[studentId] ?? 0), 0);
    const base = override !== undefined ? Number(override) : legacyMaximum > 0 ? legacyScore / legacyMaximum * 100 : Number(component.defaultScore);
    const adjustment = component.kind === "attendance"
      ? ATTENDANCE_STATUSES.reduce((sum, status) => sum + Number(attendance[status] ?? 0) * Number(config.attendanceRules?.[status] ?? DEFAULT_ATTENDANCE_RULES[status]), 0)
      : component.kind === "performance" ? events : 0;
    const score = Math.round(Math.max(0, Math.min(100, base + adjustment)) * 100) / 100;
    return { ...component, base: Math.round(base * 100) / 100, adjustment, score };
  });
  const totalWeight = components.reduce((sum, item) => sum + Number(item.weight), 0);
  const total = totalWeight > 0 ? components.reduce((sum, item) => sum + item.score * Number(item.weight), 0) / totalWeight : 0;
  return { ...Object.fromEntries(components.map((item) => [item.name, item.score])), components, 总分: Math.round(total * 100) / 100, totalWeight };
}

export function eligibleStudents(students, excludedIds = []) {
  const excluded = new Set(excludedIds);
  return students.filter((student) => !excluded.has(student.id));
}

export function drawStudent(students, { mode = "pure", excludedIds = [], counts = {}, rng = Math.random } = {}) {
  const pool = eligibleStudents(students, excludedIds);
  if (!pool.length) throw new Error("没有可参与抽名的学生");
  if (mode === "pure") return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  const weights = pool.map((student) => 1 / (Number(counts[student.id] ?? 0) + 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = rng() * total;
  for (let index = 0; index < pool.length; index += 1) {
    cursor -= weights[index];
    if (cursor <= 0) return pool[index];
  }
  return pool[pool.length - 1];
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
}

function assertText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空文本`);
}

function assertOptionalText(value, name, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${name} 必须是最多 ${maxLength} 字的文本`);
}

function assertIsoDateTime(value, name, optional = false) {
  if (optional && value === null) return;
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error(`${name} 必须是有效日期时间`);
}

function assertDate(value, name, optional = false) {
  if (optional && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`${name} 必须是有效的 YYYY-MM-DD 日期`);
}

function assertTags(tags, name) {
  assertArray(tags, name);
  if (tags.length > 20) throw new Error(`${name} 最多 20 个标签`);
  const seen = new Set();
  tags.forEach((tag) => {
    if (typeof tag !== "string" || !tag.trim() || tag.length > 40) throw new Error(`${name} 标签必须是 1 到 40 字的文本`);
    if (seen.has(tag)) throw new Error(`${name} 存在重复标签：${tag}`);
    seen.add(tag);
  });
}

function assertUniqueIds(items, name, globalIds) {
  const local = new Set();
  items.forEach((item) => {
    assertObject(item, `${name} 项`); assertText(item.id, `${name}.id`);
    if (local.has(item.id) || globalIds.has(item.id)) throw new Error(`${name} 存在重复 id：${item.id}`);
    local.add(item.id); globalIds.add(item.id);
  });
}

function assertReference(set, id, name) {
  if (!set.has(id)) throw new Error(`${name} 引用了不存在的 id：${id}`);
}

function assertLegacyMaxScores(maxScores, name) {
  assertObject(maxScores, name);
  Object.entries(maxScores).forEach(([type, raw]) => {
    const value = Number(raw);
    if (!type.trim() || !Number.isFinite(value) || value <= 0 || value > 1000) throw new Error(`${name}.${type} 必须是 0 到 1000 之间的有限正数`);
  });
}

function assertScoreConfig(config, offering, data) {
  assertObject(config, "offering.scoreConfig");
  assertArray(config.components, "offering.scoreConfig.components");
  if (!config.components.length || config.components.length > 20) throw new Error("成绩项数量必须是 1 到 20 个");
  const ids = new Set(); const names = new Set(); let attendanceCount = 0; let positiveWeight = 0;
  config.components.forEach((component) => {
    assertObject(component, "scoreComponent"); assertText(component.id, "scoreComponent.id"); assertText(component.name, "scoreComponent.name");
    if (ids.has(component.id)) throw new Error(`重复成绩项 id：${component.id}`); ids.add(component.id);
    if (names.has(component.name)) throw new Error(`重复成绩项名称：${component.name}`); names.add(component.name);
    if (!["attendance", "performance", "manual"].includes(component.kind)) throw new Error(`成绩项类型非法：${component.kind}`);
    if (component.kind === "attendance") attendanceCount += 1;
    const weight = component.weight; const defaultScore = component.defaultScore;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1000) throw new Error("成绩项权重必须是 0 到 1000 的有限数字");
    if (typeof defaultScore !== "number" || !Number.isFinite(defaultScore) || defaultScore < 0 || defaultScore > 100) throw new Error("成绩项初始分必须是 0 到 100 的有限数字");
    positiveWeight += weight;
  });
  if (attendanceCount !== 1) throw new Error("必须且只能保留一个考勤自动计分项");
  if (positiveWeight <= 0) throw new Error("至少一个成绩项权重必须大于 0");
  assertObject(config.attendanceRules, "offering.scoreConfig.attendanceRules");
  ATTENDANCE_STATUSES.forEach((status) => { const value = config.attendanceRules[status]; if (typeof value !== "number" || !Number.isFinite(value) || value < -100 || value > 100) throw new Error(`${status}计分规则必须是 -100 到 100 的有限数字`); });
  assertObject(config.overrides, "offering.scoreConfig.overrides");
  const students = new Set(studentsFor(data, offering).map((student) => student.id));
  Object.entries(config.overrides).forEach(([studentId, row]) => {
    if (!students.has(studentId)) throw new Error(`成绩初始分引用名单外学生：${studentId}`);
    assertObject(row, `成绩初始分 ${studentId}`);
    Object.entries(row).forEach(([componentId, score]) => { if (!ids.has(componentId)) throw new Error(`成绩初始分引用不存在的成绩项：${componentId}`); if (typeof score !== "number" || !Number.isFinite(score)) throw new Error("成绩初始分必须是有限数字"); const valid = validateScore(score, 100); if (!valid.ok) throw new Error(valid.error); });
  });
}

function assertRecordReference(data, reference, name, sets) {
  assertReference(sets.semesters, reference.semesterId, `${name}.semesterId`);
  assertReference(sets.classes, reference.classId, `${name}.classId`);
  assertReference(sets.courses, reference.courseId, `${name}.courseId`);
  if (!data.offerings.some((item) => item.semesterId === reference.semesterId && item.classId === reference.classId && item.courseId === reference.courseId)) throw new Error(`${name} 未挂载到对应教学组合`);
}

export function validateDatabase(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("备份内容不是有效对象");
  if (candidate.version !== DATA_VERSION) throw new Error(`数据版本不兼容：需要 ${DATA_VERSION}`);
  assertObject(candidate.settings, "settings");
  assertObject(candidate.settings.warningThresholds, "settings.warningThresholds");
  [["absent", candidate.settings.warningThresholds.absent], ["late", candidate.settings.warningThresholds.late], ["early", candidate.settings.warningThresholds.early]].forEach(([key, value]) => {
    if (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000) throw new Error(`预警阈值 ${key} 必须是 1 到 1000 的整数`);
  });
  if (!Number.isInteger(Number(candidate.settings.defaultSections)) || Number(candidate.settings.defaultSections) < 1 || Number(candidate.settings.defaultSections) > 12) throw new Error("默认节数必须是 1 到 12 的整数");
  if (!Number.isInteger(Number(candidate.settings.backupReminderDays)) || Number(candidate.settings.backupReminderDays) < 1 || Number(candidate.settings.backupReminderDays) > 365) throw new Error("备份提醒天数必须是 1 到 365 的整数");
  ["semesters", "classes", "semesterRosters", "courses", "offerings", "attendanceSessions", "scoreItems", "performanceEvents", "drawHistory", "people", "teachingNotes", "learningGoals", "followUps", "profileEvents"].forEach((key) => assertArray(candidate[key], key));
  const globalIds = new Set();
  ["semesters", "classes", "semesterRosters", "courses", "offerings", "attendanceSessions", "scoreItems", "performanceEvents", "drawHistory", "people", "teachingNotes", "learningGoals", "followUps", "profileEvents"].forEach((key) => assertUniqueIds(candidate[key], key, globalIds));
  candidate.semesters.forEach((item) => { assertText(item.name, "semester.name"); if (typeof item.archived !== "boolean") throw new Error("semester.archived 必须是布尔值"); });
  candidate.classes.forEach((item) => assertText(item.name, "class.name"));
  candidate.courses.forEach((item) => { assertText(item.name, "course.name"); if (item.maxScores !== undefined) assertLegacyMaxScores(item.maxScores, `课程 ${item.name} maxScores`); });
  const sets = { semesters: new Set(candidate.semesters.map((item) => item.id)), classes: new Set(candidate.classes.map((item) => item.id)), courses: new Set(candidate.courses.map((item) => item.id)), people: new Set(candidate.people.map((item) => item.id)) };
  candidate.people.forEach((person) => {
    assertIsoDateTime(person.createdAt, "person.createdAt");
    assertIsoDateTime(person.updatedAt, "person.updatedAt");
    assertOptionalText(person.teachingTip, "person.teachingTip", 500);
    assertTags(person.tags, "person.tags");
    if (typeof person.watchlisted !== "boolean") throw new Error("person.watchlisted 必须是布尔值");
  });
  const rosterCombos = new Set();
  const studentIds = new Set();
  const semesterPersonIds = new Map();
  candidate.semesterRosters.forEach((roster) => {
    assertReference(sets.semesters, roster.semesterId, "semesterRoster.semesterId");
    assertReference(sets.classes, roster.classId, "semesterRoster.classId");
    const combo = `${roster.semesterId}|${roster.classId}`; if (rosterCombos.has(combo)) throw new Error(`重复学期班级名单：${combo}`); rosterCombos.add(combo);
    assertArray(roster.students, "semesterRoster.students");
    const errors = validateRoster(roster.students); if (errors.length) throw new Error(`名单 ${combo}：${errors.join("；")}`);
    const rosterPersonIds = new Set();
    roster.students.forEach((student) => {
      assertText(student.id, "student.id");
      if (typeof student.studentNo !== "string") throw new Error("student.studentNo 必须是文本（可为空）");
      assertText(student.name, "student.name");
      assertText(student.personId, "student.personId");
      assertReference(sets.people, student.personId, "student.personId");
      if (rosterPersonIds.has(student.personId)) throw new Error(`同一学期班级名单 personId 重复：${student.personId}`);
      rosterPersonIds.add(student.personId);
      semesterPersonIds.set(roster.semesterId, semesterPersonIds.get(roster.semesterId) ?? new Set());
      if (semesterPersonIds.get(roster.semesterId).has(student.personId)) throw new Error(`同一学期 personId 挂载到多个名单学生：${student.personId}`);
      semesterPersonIds.get(roster.semesterId).add(student.personId);
      if (studentIds.has(student.id) || globalIds.has(student.id)) throw new Error(`重复学生 id：${student.id}`);
      studentIds.add(student.id); globalIds.add(student.id);
    });
  });
  const offeringCombos = new Set();
  candidate.offerings.forEach((offering) => {
    assertReference(sets.semesters, offering.semesterId, "offering.semesterId"); assertReference(sets.classes, offering.classId, "offering.classId"); assertReference(sets.courses, offering.courseId, "offering.courseId");
    if (!rosterCombos.has(`${offering.semesterId}|${offering.classId}`)) throw new Error("offering 缺少对应学期班级名单");
    const combo = `${offering.semesterId}|${offering.classId}|${offering.courseId}`; if (offeringCombos.has(combo)) throw new Error(`重复教学组合：${combo}`); offeringCombos.add(combo);
    if (offering.maxScores !== undefined) assertLegacyMaxScores(offering.maxScores, `教学组合 ${combo} maxScores`);
    if (offering.scoreConfig !== undefined) assertScoreConfig(offering.scoreConfig, offering, candidate);
  });
  assertObject(candidate.settings.workspaceContext, "settings.workspaceContext");
  const currentOfferingId = candidate.settings.workspaceContext.offeringId;
  if (currentOfferingId !== null && (typeof currentOfferingId !== "string" || !candidate.offerings.some((item) => item.id === currentOfferingId))) throw new Error("课堂工作台当前班级课程不存在");
  assertArray(candidate.settings.workspaceContext.recentOfferingIds, "settings.workspaceContext.recentOfferingIds");
  if (candidate.settings.workspaceContext.recentOfferingIds.length > 8) throw new Error("课堂工作台最近班级课程最多保留 8 个");
  const recentIds = new Set();
  candidate.settings.workspaceContext.recentOfferingIds.forEach((id) => {
    if (typeof id !== "string" || !candidate.offerings.some((item) => item.id === id)) throw new Error(`课堂工作台最近班级课程不存在：${id}`);
    if (recentIds.has(id)) throw new Error(`课堂工作台最近班级课程重复：${id}`);
    recentIds.add(id);
  });
  assertObject(candidate.settings.onboarding, "settings.onboarding");
  if (![null, DATA_VERSION].includes(candidate.settings.onboarding.completedVersion)) throw new Error("首次使用引导完成版本无效");
  candidate.attendanceSessions.forEach((session) => {
    assertRecordReference(candidate, session, "attendance", sets);
    if (!Number.isInteger(session.sectionCount) || session.sectionCount < 1 || session.sectionCount > 12) throw new Error("考勤 sectionCount 必须是 1 到 12 的整数");
    assertObject(session.records, "attendance.records");
    const roster = rosterFor(candidate, session.semesterId, session.classId); const expected = new Set(roster.students.map((item) => item.id)); const actual = new Set(Object.keys(session.records));
    if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) throw new Error(`考勤 ${session.id} 的学生记录必须与学期班级名单完全一致`);
    const errors = validateAttendanceSession(session);
    if (errors.length) throw new Error(`考勤记录 ${session.id}：${errors.join("；")}`);
  });
  candidate.scoreItems.forEach((item) => {
    assertRecordReference(candidate, item, "scoreItem", sets); assertText(item.type, "scoreItem.type"); assertText(item.title, "scoreItem.title");
    if (!Number.isFinite(Number(item.max)) || Number(item.max) <= 0 || Number(item.max) > 1000) throw new Error("成绩项目满分必须是有限正数");
    assertObject(item.scores, "scoreItem.scores"); const validStudents = new Set(studentsFor(candidate, item).map((student) => student.id));
    if (item.componentId !== undefined) { assertText(item.componentId, "scoreItem.componentId"); const offering = candidate.offerings.find((entry) => entry.semesterId === item.semesterId && entry.classId === item.classId && entry.courseId === item.courseId); if (!scoreConfigFor(offering).components.some((component) => component.id === item.componentId)) throw new Error(`scoreItem 引用不存在的成绩项：${item.componentId}`); }
    Object.entries(item.scores).forEach(([studentId, score]) => { if (!validStudents.has(studentId)) throw new Error(`scoreItem 引用名单外学生：${studentId}`); const valid = validateScore(score, item.max); if (!valid.ok) throw new Error(valid.error); });
  });
  candidate.performanceEvents.forEach((event) => {
    assertRecordReference(candidate, event, "performanceEvent", sets); if (!studentsFor(candidate, event).some((student) => student.id === event.studentId)) throw new Error(`performanceEvent 引用名单外学生：${event.studentId}`);
    assertValidEventDelta(candidate, event, event.delta); assertText(event.reason, "performanceEvent.reason");
  });
  candidate.drawHistory.forEach((item) => {
    assertRecordReference(candidate, item, "drawHistory", sets); if (!studentsFor(candidate, item).some((student) => student.id === item.studentId)) throw new Error(`drawHistory 引用名单外学生：${item.studentId}`);
    if (!['weighted', 'pure'].includes(item.mode)) throw new Error(`drawHistory 模式非法：${item.mode}`);
  });
  const validateOptionalContext = (item, name, personId) => {
    [["semesterId", sets.semesters], ["classId", sets.classes], ["courseId", sets.courses]].forEach(([key, set]) => {
      if (item[key] !== null) { assertText(item[key], `${name}.${key}`); assertReference(set, item[key], `${name}.${key}`); }
    });
    if (item.classId !== null && item.semesterId === null) throw new Error(`${name} 班级上下文缺少学期`);
    if (item.classId !== null && !rosterCombos.has(`${item.semesterId}|${item.classId}`)) throw new Error(`${name} 班级上下文没有对应学期名单`);
    if (item.courseId !== null && (item.semesterId === null || item.classId === null || !candidate.offerings.some((offering) => offering.semesterId === item.semesterId && offering.classId === item.classId && offering.courseId === item.courseId))) throw new Error(`${name} 课程上下文未挂载到对应学期班级`);
    if (item.semesterId !== null) {
      const contextRosters = candidate.semesterRosters.filter((roster) => roster.semesterId === item.semesterId && (item.classId === null || roster.classId === item.classId));
      if (!contextRosters.some((roster) => roster.students.some((student) => student.personId === personId))) throw new Error(`${name} 的学生档案不属于所选学期班级`);
    }
  };
  candidate.teachingNotes.forEach((note) => {
    assertReference(sets.people, note.personId, "teachingNote.personId");
    validateOptionalContext(note, "teachingNote", note.personId);
    if (!["课堂观察", "学习困难", "学习优势", "作业跟进", "实训表现", "沟通记录", "其他"].includes(note.type)) throw new Error(`教学备注类型非法：${note.type}`);
    if (typeof note.text !== "string" || note.text.trim().length < 1 || note.text.length > 1000) throw new Error("教学备注正文必须是 1 到 1000 字的纯文本");
    assertTags(note.tags, "teachingNote.tags");
    assertIsoDateTime(note.createdAt, "teachingNote.createdAt"); assertIsoDateTime(note.updatedAt, "teachingNote.updatedAt");
    if (typeof note.pinned !== "boolean") throw new Error("teachingNote.pinned 必须是布尔值");
    assertDate(note.followUpDate, "teachingNote.followUpDate", true);
    if (!["active", "completed", "archived"].includes(note.status)) throw new Error(`教学备注状态非法：${note.status}`);
    assertIsoDateTime(note.archivedAt, "teachingNote.archivedAt", true);
    if ((note.status === "archived") !== (note.archivedAt !== null)) throw new Error("教学备注归档状态与 archivedAt 不一致");
  });
  candidate.learningGoals.forEach((goal) => {
    assertReference(sets.people, goal.personId, "learningGoal.personId");
    if (goal.courseId !== null) assertReference(sets.courses, goal.courseId, "learningGoal.courseId");
    if (typeof goal.title !== "string" || goal.title.trim().length < 1 || goal.title.length > 120) throw new Error("学习目标标题必须是 1 到 120 字");
    assertOptionalText(goal.description, "learningGoal.description", 1000);
    assertDate(goal.startDate, "learningGoal.startDate"); assertDate(goal.dueDate, "learningGoal.dueDate", true);
    if (goal.dueDate !== null && goal.dueDate < goal.startDate) throw new Error("学习目标截止日期不能早于开始日期");
    if (!["not_started", "in_progress", "completed", "paused"].includes(goal.status)) throw new Error(`学习目标状态非法：${goal.status}`);
    assertArray(goal.progress, "learningGoal.progress");
    goal.progress.forEach((entry) => { assertText(entry.id, "goalProgress.id"); assertIsoDateTime(entry.createdAt, "goalProgress.createdAt"); if (typeof entry.text !== "string" || entry.text.trim().length < 1 || entry.text.length > 500) throw new Error("目标进展必须是 1 到 500 字"); });
    if (new Set(goal.progress.map((entry) => entry.id)).size !== goal.progress.length) throw new Error("目标进展 id 重复");
    assertIsoDateTime(goal.createdAt, "learningGoal.createdAt"); assertIsoDateTime(goal.updatedAt, "learningGoal.updatedAt"); assertIsoDateTime(goal.completedAt, "learningGoal.completedAt", true);
    if ((goal.status === "completed") !== (goal.completedAt !== null)) throw new Error("学习目标完成状态与 completedAt 不一致");
  });
  const noteIds = new Set(candidate.teachingNotes.map((item) => item.id));
  candidate.followUps.forEach((followUp) => {
    assertReference(sets.people, followUp.personId, "followUp.personId");
    validateOptionalContext(followUp, "followUp", followUp.personId);
    if (!["note", "attendance", "score", "manual"].includes(followUp.sourceType)) throw new Error(`跟进来源非法：${followUp.sourceType}`);
    if (followUp.sourceId !== null) assertText(followUp.sourceId, "followUp.sourceId");
    if (followUp.sourceType !== "manual" && followUp.sourceId === null) throw new Error("非手动跟进必须引用来源记录");
    if (followUp.sourceType === "note" && !noteIds.has(followUp.sourceId)) throw new Error(`跟进引用不存在的教学备注：${followUp.sourceId}`);
    if (followUp.sourceType === "note" && !candidate.teachingNotes.some((item) => item.id === followUp.sourceId && item.personId === followUp.personId)) throw new Error("跟进来源备注不属于该学生档案");
    if (followUp.sourceType === "attendance") {
      const session = candidate.attendanceSessions.find((item) => item.id === followUp.sourceId);
      if (!session || session.semesterId !== followUp.semesterId || session.classId !== followUp.classId || session.courseId !== followUp.courseId) throw new Error("跟进来源考勤不存在或上下文不一致");
      const contextStudent = rosterFor(candidate, session.semesterId, session.classId)?.students.find((item) => item.personId === followUp.personId);
      if (!contextStudent || !Object.hasOwn(session.records, contextStudent.id)) throw new Error("跟进来源考勤不属于该学生档案");
    }
    if (followUp.sourceType === "score") {
      const scoreItem = candidate.scoreItems.find((item) => item.id === followUp.sourceId);
      const performance = candidate.performanceEvents.find((item) => item.id === followUp.sourceId);
      const source = scoreItem ?? performance;
      if (!source || source.semesterId !== followUp.semesterId || source.classId !== followUp.classId || source.courseId !== followUp.courseId) throw new Error("跟进来源成绩记录不存在或上下文不一致");
      const contextStudent = rosterFor(candidate, source.semesterId, source.classId)?.students.find((item) => item.personId === followUp.personId);
      if (!contextStudent || (scoreItem ? !Object.hasOwn(scoreItem.scores, contextStudent.id) : performance.studentId !== contextStudent.id)) throw new Error("跟进来源成绩记录不属于该学生档案");
    }
    if (typeof followUp.content !== "string" || followUp.content.trim().length < 1 || followUp.content.length > 500) throw new Error("跟进内容必须是 1 到 500 字");
    assertDate(followUp.plannedDate, "followUp.plannedDate");
    if (!["pending", "completed", "cancelled"].includes(followUp.status)) throw new Error(`跟进状态非法：${followUp.status}`);
    assertOptionalText(followUp.completionNote, "followUp.completionNote", 500);
    assertIsoDateTime(followUp.createdAt, "followUp.createdAt"); assertIsoDateTime(followUp.updatedAt, "followUp.updatedAt"); assertIsoDateTime(followUp.completedAt, "followUp.completedAt", true);
    if ((followUp.status === "completed") !== (followUp.completedAt !== null)) throw new Error("跟进完成状态与 completedAt 不一致");
  });
  const deletedNoteEvents = new Map(candidate.profileEvents.filter((event) => event.type === "note_deleted" && typeof event.entityId === "string").map((event) => [event.entityId, event]));
  candidate.profileEvents.forEach((event) => {
    assertReference(sets.people, event.personId, "profileEvent.personId");
    validateOptionalContext(event, "profileEvent", event.personId);
    if (!["note_created", "note_modified", "note_completed", "note_archived", "note_restored", "note_deleted", "goal_created", "goal_modified", "goal_progress", "goal_completed", "followup_created", "followup_completed", "score_change", "association"].includes(event.type)) throw new Error(`档案事实事件类型非法：${event.type}`);
    if (event.entityId !== null) assertText(event.entityId, "profileEvent.entityId");
    if (event.type !== "association" && event.type !== "note_deleted" && event.entityId === null) throw new Error("档案事实事件缺少实体引用");
    if (event.type.startsWith("note_") && event.type !== "note_deleted" && !candidate.teachingNotes.some((item) => item.id === event.entityId && item.personId === event.personId)) {
      const tombstone = deletedNoteEvents.get(event.entityId);
      if (!tombstone || tombstone.personId !== event.personId || tombstone.time < event.time) throw new Error("档案事实事件引用不存在的教学备注或删除墓碑");
    }
    if (event.type === "note_deleted" && !/^永久删除已归档备注：/.test(event.detail)) throw new Error("教学备注删除墓碑摘要无效");
    if (event.type.startsWith("goal_") && !candidate.learningGoals.some((item) => item.id === event.entityId && item.personId === event.personId)) throw new Error("档案事实事件引用不存在的学习目标");
    if (event.type.startsWith("followup_") && !candidate.followUps.some((item) => item.id === event.entityId && item.personId === event.personId)) throw new Error("档案事实事件引用不存在的跟进事项");
    if (event.type === "score_change" && !candidate.offerings.some((item) => item.semesterId === event.semesterId && item.classId === event.classId && item.courseId === event.courseId && scoreConfigFor(item).components.some((component) => component.id === event.entityId))) throw new Error("成绩事实事件引用不存在的成绩项");
    if (typeof event.detail !== "string" || !event.detail.trim() || event.detail.length > 500) throw new Error("档案事实事件说明必须是 1 到 500 字");
    assertIsoDateTime(event.time, "profileEvent.time");
  });
  return structuredClone(candidate);
}

export function exportDatabase(data) {
  const copy = structuredClone(data);
  copy.exportedAt = new Date().toISOString();
  return JSON.stringify(copy, null, 2);
}

export function importDatabaseSafely(jsonText, currentData) {
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch { return { ok: false, error: "JSON 文件格式错误", data: currentData }; }
  try { return { ok: true, data: migrateAndValidateDatabase(parsed) }; }
  catch (error) { return { ok: false, error: error.message, data: currentData }; }
}

export function createFictionalDataset() {
  const data = createEmptyData();
  data.settings.teacherName = "测试教师";
  data.semesters = [
    { id: "sem_2025", name: "2025—2026学年第二学期", archived: true },
    { id: "sem_2026", name: "2026—2027学年第一学期", archived: false },
  ];
  data.courses = [
    { id: "course_ev", name: "新能源汽车结构与原理" },
    { id: "course_diag", name: "汽车故障诊断" },
  ];
  data.classes = Array.from({ length: 6 }, (_, classIndex) => ({
    id: `class_${classIndex + 1}`,
    name: `新能源${classIndex + 1}班`,
  }));
  data.people = data.classes.flatMap((_, classIndex) => Array.from({ length: 60 }, (_, studentIndex) => ({
    id: `person_${classIndex + 1}_${studentIndex + 1}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    teachingTip: "",
    tags: [],
    watchlisted: false,
  })));
  data.semesterRosters = data.semesters.flatMap((semester) => data.classes.map((classItem, classIndex) => ({
    id: `roster_${semester.id}_${classItem.id}`, semesterId: semester.id, classId: classItem.id,
    students: Array.from({ length: 60 }, (_, studentIndex) => ({
      id: `stu_${semester.id}_${classIndex + 1}_${studentIndex + 1}`,
      personId: `person_${classIndex + 1}_${studentIndex + 1}`,
      studentNo: `${classIndex + 1}${String(studentIndex + 1).padStart(4, "0")}`,
      name: `虚构学生${classIndex + 1}-${String(studentIndex + 1).padStart(2, "0")}`,
    })),
  })));
  data.offerings = data.semesters.flatMap((semester) => data.classes.flatMap((classItem) => data.courses.map((course) => ({
    id: `off_${semester.id}_${classItem.id}_${course.id}`, scoreConfig: createDefaultScoreConfig(),
    semesterId: semester.id, classId: classItem.id, courseId: course.id,
  }))));
  const classItem = data.classes[0];
  const students = rosterFor(data, "sem_2026", classItem.id).students;
  const statuses = ["缺勤", "缺勤", "缺勤", "迟到", "迟到", "迟到", "早退", "早退", "早退", "病假", "事假", "其他"];
  statuses.forEach((status, index) => {
    const session = createAttendanceSession({ semesterId: "sem_2026", courseId: "course_ev", classId: classItem.id, date: `2026-09-${String(index + 1).padStart(2, "0")}`, sectionCount: 1, students, id: `att_fixed_${index + 1}` });
    session.records[students[0].id][0] = { status, note: status === "其他" ? "虚构测试备注" : "" };
    data.attendanceSessions.push(session);
  });
  const archivedStudents = rosterFor(data, "sem_2025", classItem.id).students;
  data.attendanceSessions.push(createAttendanceSession({ semesterId: "sem_2025", courseId: "course_ev", classId: classItem.id, date: "2026-06-30", sectionCount: 2, students: archivedStudents, id: "att_archived_sample" }));
  return data;
}
