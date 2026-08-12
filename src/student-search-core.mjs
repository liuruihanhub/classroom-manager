import { attendanceStats, studentScores, studentsFor } from "./core.mjs";

export function normalizeSearchText(value, maxLength = 100) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN").slice(0, maxLength);
}

export function buildStudentSearchIndex(data, semesterId) {
  const semester = data.semesters.find((item) => item.id === semesterId && !item.archived);
  if (!semester) return [];
  const classMap = new Map(data.classes.map((item) => [item.id, item]));
  const courseMap = new Map(data.courses.map((item) => [item.id, item]));
  const offeringsByClass = new Map();
  for (const offering of data.offerings.filter((item) => item.semesterId === semester.id)) {
    const course = courseMap.get(offering.courseId);
    if (!course) continue;
    const contexts = offeringsByClass.get(offering.classId) ?? [];
    contexts.push({ offeringId: offering.id, courseId: course.id, courseName: course.name });
    offeringsByClass.set(offering.classId, contexts);
  }
  return data.semesterRosters
    .filter((roster) => roster.semesterId === semester.id && classMap.has(roster.classId))
    .flatMap((roster) => roster.students.map((student, index) => ({
      studentId: student.id,
      studentNo: student.studentNo,
      name: student.name,
      normalizedName: normalizeSearchText(student.name, 200),
      normalizedStudentNo: student.studentNo ? normalizeSearchText(student.studentNo, 200) : "",
      semesterId: semester.id,
      semesterName: semester.name,
      classId: roster.classId,
      className: classMap.get(roster.classId).name,
      rosterPosition: index + 1,
      courses: [...(offeringsByClass.get(roster.classId) ?? [])].sort((left, right) => left.courseName.localeCompare(right.courseName, "zh-CN")),
    })));
}

export function searchStudents(index, query, limit = 40) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const safeLimit = Number.isSafeInteger(limit) ? Math.min(500, Math.max(1, limit)) : 40;
  return index
    .filter((item) => item.normalizedName.includes(normalized) || (item.normalizedStudentNo && item.normalizedStudentNo.includes(normalized)))
    .sort((left, right) => {
      const rank = (item) => item.normalizedStudentNo === normalized ? 0 : item.normalizedName === normalized ? 1 : item.normalizedName.startsWith(normalized) ? 2 : 3;
      return rank(left) - rank(right) || left.className.localeCompare(right.className, "zh-CN") || left.rosterPosition - right.rosterPosition || left.studentId.localeCompare(right.studentId);
    })
    .slice(0, safeLimit);
}

export function buildStudentCourseDetail(data, { offeringId, studentId }) {
  const offering = data.offerings.find((item) => item.id === offeringId);
  if (!offering) throw new Error("所选课程上下文不存在");
  const student = studentsFor(data, offering).find((item) => item.id === studentId);
  if (!student) throw new Error("所选学生不在这个学期班级名单中");
  const classItem = data.classes.find((item) => item.id === offering.classId);
  const course = data.courses.find((item) => item.id === offering.courseId);
  const semester = data.semesters.find((item) => item.id === offering.semesterId);
  const stats = attendanceStats(data, offering)[student.id] ?? {};
  const sessions = data.attendanceSessions
    .filter((item) => item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId)
    .sort((left, right) => right.date.localeCompare(left.date))
    .map((session) => ({ id: session.id, date: session.date, records: session.records[student.id].map((record, index) => ({ section: index + 1, status: record.status, note: record.note })) }));
  return { offering, student, classItem, course, semester, stats, sessions, scores: studentScores(data, { ...offering, studentId }) };
}
