import {
  assertValidEventDelta,
  assertWritableSemester,
  createAttendanceSession,
  makeId,
  rosterFor,
  scoreConfigFor,
  validateDatabase,
  warningRows,
} from "./core.mjs";

export function workspaceOffering(data, offeringId) {
  const offering = data.offerings.find((item) => item.id === offeringId);
  if (!offering) return null;
  const semester = data.semesters.find((item) => item.id === offering.semesterId);
  const classItem = data.classes.find((item) => item.id === offering.classId);
  const course = data.courses.find((item) => item.id === offering.courseId);
  const roster = rosterFor(data, offering.semesterId, offering.classId);
  if (!semester || !classItem || !course || !roster) return null;
  return { offering, semester, classItem, course, roster, students: roster.students, archived: semester.archived };
}

export function rememberWorkspaceOffering(data, offeringId) {
  const context = workspaceOffering(data, offeringId);
  if (!context) throw new Error("无法进入课堂工作台：班级课程不存在，数据未保存");
  const next = structuredClone(data);
  const recent = next.settings.workspaceContext.recentOfferingIds.filter((id) => id !== offeringId);
  next.settings.workspaceContext.offeringId = offeringId;
  next.settings.workspaceContext.recentOfferingIds = [offeringId, ...recent].slice(0, 8);
  return validateDatabase(next);
}

export function recentWorkspaceOfferings(data, { includeArchived = false } = {}) {
  const remembered = data.settings.workspaceContext.recentOfferingIds;
  const ordered = [...remembered, ...data.offerings.map((item) => item.id)].filter((id, index, all) => all.indexOf(id) === index);
  return ordered.map((id) => workspaceOffering(data, id)).filter((context) => context && (includeArchived || !context.archived));
}

export function workspaceAttendanceForDate(data, offeringId, date) {
  const context = workspaceOffering(data, offeringId);
  if (!context) return null;
  return data.attendanceSessions.find((session) => session.semesterId === context.offering.semesterId
    && session.classId === context.offering.classId
    && session.courseId === context.offering.courseId
    && session.date === date) ?? null;
}

export function startWorkspaceAttendance(data, { offeringId, date, sectionCount, id = makeId("att") }) {
  const context = workspaceOffering(data, offeringId);
  if (!context) throw new Error("无法开始考勤：班级课程不存在，数据未保存");
  assertWritableSemester(data, context.offering.semesterId);
  const existing = workspaceAttendanceForDate(data, offeringId, date);
  if (existing) return { data: validateDatabase(data), sessionId: existing.id, created: false };
  const next = structuredClone(data);
  const session = createAttendanceSession({
    semesterId: context.offering.semesterId,
    classId: context.offering.classId,
    courseId: context.offering.courseId,
    date,
    sectionCount,
    students: context.students,
    id,
  });
  next.attendanceSessions.push(session);
  return { data: validateDatabase(next), sessionId: session.id, created: true };
}

export function recordWorkspacePerformance(data, { offeringId, studentId, delta, reason, time = new Date().toISOString(), id = makeId("event") }) {
  const context = workspaceOffering(data, offeringId);
  if (!context) throw new Error("无法记录课堂表现：班级课程不存在，数据未保存");
  assertWritableSemester(data, context.offering.semesterId);
  if (!context.students.some((student) => student.id === studentId)) throw new Error("无法记录课堂表现：学生不在当前名单，数据未保存");
  if (!scoreConfigFor(context.offering).components.some((item) => item.kind === "performance")) throw new Error("当前班级课程未启用课堂表现项，数据未保存");
  const validDelta = assertValidEventDelta(data, context.offering, delta);
  const cleanReason = String(reason ?? "").trim();
  if (!cleanReason) throw new Error("课堂表现事由不能为空，数据未保存");
  const next = structuredClone(data);
  next.performanceEvents.push({
    id,
    semesterId: context.offering.semesterId,
    classId: context.offering.classId,
    courseId: context.offering.courseId,
    studentId,
    delta: validDelta,
    reason: cleanReason,
    time,
    revokedAt: null,
  });
  return validateDatabase(next);
}

export function workspaceWarnings(data, offeringId) {
  const context = workspaceOffering(data, offeringId);
  if (!context) return [];
  return warningRows(data, {
    semesterId: context.offering.semesterId,
    classId: context.offering.classId,
    courseId: context.offering.courseId,
  });
}
