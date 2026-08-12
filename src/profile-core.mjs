import { ATTENDANCE_STATUSES, assertWritableSemester, makeId, rosterFor, studentScores } from "./core.mjs";

export const NOTE_TYPES = Object.freeze(["课堂观察", "学习困难", "学习优势", "作业跟进", "实训表现", "沟通记录", "其他"]);
export const NOTE_STATUSES = Object.freeze(["active", "completed", "archived"]);
export const GOAL_STATUSES = Object.freeze(["not_started", "in_progress", "completed", "paused"]);
export const FOLLOW_UP_STATUSES = Object.freeze(["pending", "completed", "cancelled"]);
export const MAX_CLOUD_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const CAPACITY_WARNING_BYTES = Math.floor(MAX_CLOUD_PAYLOAD_BYTES * 0.85);

function cleanText(value, label, { min = 1, max = 1000 } = {}) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) throw new Error(`${label}必须是 ${min} 到 ${max} 字的纯文本`);
  return text;
}

function cleanOptionalText(value, label, max = 500) {
  const text = String(value ?? "").trim();
  if (text.length > max) throw new Error(`${label}最多 ${max} 字`);
  return text;
}

function cleanTags(tags) {
  const result = [...new Set((Array.isArray(tags) ? tags : String(tags ?? "").split(/[，,]/)).map((tag) => String(tag).trim()).filter(Boolean))];
  if (result.length > 20) throw new Error("每名学生或每条备注最多 20 个标签");
  if (result.some((tag) => tag.length > 40)) throw new Error("每个标签最多 40 字");
  return result;
}

function validDate(value, label, optional = true) {
  const date = String(value ?? "").trim();
  if (!date && optional) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`${label}必须是有效日期`);
  return date;
}

function timestamp(value = new Date().toISOString()) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("时间必须是有效日期时间");
  return value;
}

function person(data, personId) {
  const value = data.people.find((item) => item.id === personId);
  if (!value) throw new Error("学生档案不存在");
  return value;
}

function snapshotById(data, studentId) {
  for (const roster of data.semesterRosters) {
    const student = roster.students.find((item) => item.id === studentId);
    if (student) return { roster, student };
  }
  return null;
}

function validateContext(data, context = {}, personId = null) {
  const semesterId = context.semesterId || null;
  const classId = context.classId || null;
  const courseId = context.courseId || null;
  if (classId && !semesterId) throw new Error("班级上下文缺少学期");
  if (classId && !rosterFor(data, semesterId, classId)) throw new Error("学期班级名单不存在");
  if (courseId && (!semesterId || !classId || !data.offerings.some((item) => item.semesterId === semesterId && item.classId === classId && item.courseId === courseId))) throw new Error("课程没有挂载到该学期班级");
  if (personId && semesterId) {
    const rosters = data.semesterRosters.filter((item) => item.semesterId === semesterId && (!classId || item.classId === classId));
    if (!rosters.some((item) => item.students.some((student) => student.personId === personId))) throw new Error("该学生档案不属于所选学期班级");
  }
  return { semesterId, classId, courseId };
}

function appendProfileEvent(data, { personId, context = {}, type, entityId = null, detail, id = makeId("profile_event"), time = new Date().toISOString() }) {
  person(data, personId);
  const event = { id, personId, ...validateContext(data, context, personId), type, entityId, detail: cleanText(detail, "事实说明", { max: 500 }), time: timestamp(time) };
  if (data.profileEvents.some((item) => item.id === id)) throw new Error("档案事实事件 id 重复");
  data.profileEvents.push(event);
  return event;
}

function atomicMutation(data, operation) {
  const draft = structuredClone(data);
  const result = operation(draft);
  Object.keys(data).forEach((key) => { delete data[key]; });
  Object.assign(data, draft);
  return result;
}

function createPersonRecord(id, now) {
  return { id, createdAt: now, updatedAt: now, teachingTip: "", tags: [], watchlisted: false };
}

export function createPersonForStudent(data, student, { personId = makeId("person"), now = new Date().toISOString() } = {}) {
  if (data.people.some((item) => item.id === personId)) throw new Error("personId 已存在");
  const record = createPersonRecord(personId, timestamp(now));
  student.personId = personId;
  data.people.push(record);
  return personId;
}

export function addRosterStudents(data, { semesterId, classId, students, personIdFactory = () => makeId("person"), now = new Date().toISOString() }) {
  assertWritableSemester(data, semesterId);
  const roster = rosterFor(data, semesterId, classId);
  if (!roster) throw new Error("学期班级名单不存在");
  if (!Array.isArray(students) || !students.length) throw new Error("没有可加入的学生");
  const existingStudentIds = new Set(data.semesterRosters.flatMap((item) => item.students.map((student) => student.id)));
  const existingPersonIds = new Set(data.people.map((item) => item.id));
  const existingNos = new Set(roster.students.map((item) => item.studentNo).filter(Boolean));
  const prepared = students.map((input, index) => {
    const id = String(input.id || makeId("stu")).trim();
    const name = cleanText(input.name, `第 ${index + 1} 行姓名`, { max: 100 });
    const studentNo = String(input.studentNo ?? "").trim();
    const personId = String(personIdFactory(input, index)).trim();
    if (!id || existingStudentIds.has(id)) throw new Error(`学生 id 重复：${id || "空"}`);
    if (!personId || existingPersonIds.has(personId)) throw new Error(`personId 重复：${personId || "空"}`);
    if (studentNo && existingNos.has(studentNo)) throw new Error(`学号 ${studentNo} 在班级内重复`);
    existingStudentIds.add(id); existingPersonIds.add(personId); if (studentNo) existingNos.add(studentNo);
    return { student: { id, studentNo, name, personId }, profile: createPersonRecord(personId, timestamp(now)) };
  });
  roster.students.push(...prepared.map((item) => item.student));
  data.people.push(...prepared.map((item) => item.profile));
  return prepared.map((item) => item.student);
}

export function personSnapshots(data, personId) {
  person(data, personId);
  return data.semesterRosters.flatMap((roster) => roster.students.filter((student) => student.personId === personId).map((student) => ({
    student,
    studentId: student.id,
    semesterId: roster.semesterId,
    classId: roster.classId,
    semester: data.semesters.find((item) => item.id === roster.semesterId),
    classItem: data.classes.find((item) => item.id === roster.classId),
    offerings: data.offerings.filter((item) => item.semesterId === roster.semesterId && item.classId === roster.classId).map((offering) => ({ ...offering, course: data.courses.find((item) => item.id === offering.courseId) })),
  })));
}

export function personSummary(data, personId) {
  const snapshots = personSnapshots(data, personId);
  return {
    personId,
    snapshotCount: snapshots.length,
    snapshotLabels: snapshots.map((item) => `${item.semester?.name ?? item.semesterId} · ${item.classItem?.name ?? item.classId} · ${item.student.name}`),
    noteCount: data.teachingNotes.filter((item) => item.personId === personId).length,
    goalCount: data.learningGoals.filter((item) => item.personId === personId).length,
    followUpCount: data.followUps.filter((item) => item.personId === personId).length,
  };
}

export function findPersonLinkCandidates(data, { studentId }) {
  const selected = snapshotById(data, studentId);
  if (!selected) throw new Error("名单学生不存在");
  const name = selected.student.name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const studentNo = selected.student.studentNo.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  return data.people.filter((item) => item.id !== selected.student.personId).map((item) => ({ item, snapshots: personSnapshots(data, item.id) })).filter(({ snapshots }) => snapshots.some(({ student }) => student.name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") === name || (studentNo && student.studentNo.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") === studentNo))).map(({ item }) => personSummary(data, item.id));
}

export function linkStudentSnapshot(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => linkStudentSnapshot(draft, { ...args, __atomic: true }));
  const { semesterId, classId, studentId, targetPersonId, confirmed = false } = args;
  if (!confirmed) throw new Error("关联前必须核对两个档案摘要并二次确认");
  assertWritableSemester(data, semesterId);
  const roster = rosterFor(data, semesterId, classId);
  const student = roster?.students.find((item) => item.id === studentId);
  if (!student) throw new Error("名单学生不存在");
  person(data, targetPersonId);
  if (data.semesterRosters.filter((item) => item.semesterId === semesterId).some((item) => item.students.some((entry) => entry.id !== studentId && entry.personId === targetPersonId))) throw new Error("同一学期不能把两个名单学生关联到同一档案");
  const oldPersonId = student.personId;
  const boundRecords = [...data.teachingNotes, ...data.followUps].filter((item) => item.personId === oldPersonId && item.semesterId === semesterId && item.classId === classId);
  if (boundRecords.length) throw new Error(`原档案有 ${boundRecords.length} 条绑定该学期班级的备注或跟进；请先调整上下文后再关联`);
  student.personId = targetPersonId;
  const time = timestamp(args.now ?? new Date().toISOString());
  person(data, oldPersonId).updatedAt = time;
  person(data, targetPersonId).updatedAt = time;
  appendProfileEvent(data, { personId: targetPersonId, type: "association", entityId: studentId, detail: `教师确认将 ${semesterId}/${classId}/${studentId} 名单快照关联到现有档案；原档案 ${oldPersonId}`, time });
  return targetPersonId;
}

export function unlinkStudentSnapshot(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => unlinkStudentSnapshot(draft, { ...args, __atomic: true }));
  const { semesterId, classId, studentId, confirmed = false, newPersonId = makeId("person"), now = new Date().toISOString() } = args;
  if (!confirmed) throw new Error("解除关联前必须查看旧档案摘要并二次确认");
  assertWritableSemester(data, semesterId);
  const roster = rosterFor(data, semesterId, classId);
  const student = roster?.students.find((item) => item.id === studentId);
  if (!student) throw new Error("名单学生不存在");
  const oldPersonId = student.personId;
  const oldSummary = personSummary(data, oldPersonId);
  const boundRecords = [...data.teachingNotes, ...data.followUps].filter((item) => item.personId === oldPersonId && item.semesterId === semesterId && item.classId === classId);
  if (boundRecords.length) throw new Error(`旧档案有 ${boundRecords.length} 条绑定该学期班级的备注或跟进；请先保留摘要并把上下文改为长期档案后再解除关联`);
  person(data, oldPersonId).updatedAt = timestamp(now);
  createPersonForStudent(data, student, { personId: newPersonId, now });
  appendProfileEvent(data, { personId: newPersonId, type: "association", entityId: studentId, detail: `教师确认解除 ${semesterId}/${classId}/${studentId} 与旧档案 ${oldPersonId} 的关联；历史课堂 studentId 保持不变`, time: now });
  return { oldPersonId, newPersonId, oldSummary };
}

export function updatePersonProfile(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => updatePersonProfile(draft, { ...args, __atomic: true }));
  const { personId, teachingTip, tags, watchlisted, now = new Date().toISOString() } = args;
  const target = person(data, personId);
  if (teachingTip !== undefined) target.teachingTip = cleanOptionalText(teachingTip, "置顶教学提示", 500);
  if (tags !== undefined) target.tags = cleanTags(tags);
  if (watchlisted !== undefined) target.watchlisted = Boolean(watchlisted);
  target.updatedAt = timestamp(now);
  return target;
}

export function addTagsToPeople(data, { personIds, tags, now = new Date().toISOString() }) {
  const clean = cleanTags(tags);
  if (!clean.length) throw new Error("请至少填写一个教学标签");
  const time = timestamp(now);
  const changes = [...new Set(personIds)].map((personId) => { const target = person(data, personId); return { target, tags: cleanTags([...target.tags, ...clean]) }; });
  changes.forEach(({ target, tags: merged }) => { target.tags = merged; target.updatedAt = time; });
}

export function filterPeople(data, { tag = "", pendingOnly = false, goalStatus = "", semesterId = "", classId = "", courseId = "" } = {}) {
  const normalizedTag = String(tag).normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  return data.people.filter((item) => {
    const snapshots = personSnapshots(data, item.id);
    if (normalizedTag && !item.tags.some((value) => value.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(normalizedTag))) return false;
    if (pendingOnly && !data.followUps.some((entry) => entry.personId === item.id && entry.status === "pending")) return false;
    if (goalStatus && !data.learningGoals.some((entry) => entry.personId === item.id && entry.status === goalStatus)) return false;
    if (semesterId && !snapshots.some((entry) => entry.semesterId === semesterId)) return false;
    if (classId && !snapshots.some((entry) => entry.classId === classId)) return false;
    if (courseId && !snapshots.some((entry) => entry.offerings.some((offering) => offering.courseId === courseId))) return false;
    return true;
  });
}

export function addTeachingNote(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => addTeachingNote(draft, { ...args, __atomic: true }));
  const { personId, context, type, text, tags = [], pinned = false, followUpDate = null, id = makeId("note"), now = new Date().toISOString() } = args;
  person(data, personId);
  if (!NOTE_TYPES.includes(type)) throw new Error("请选择有效的教学备注类型");
  const time = timestamp(now);
  const note = { id, personId, ...validateContext(data, context, personId), type, text: cleanText(text, "教学备注正文"), tags: cleanTags(tags), createdAt: time, updatedAt: time, pinned: Boolean(pinned), followUpDate: validDate(followUpDate, "下次跟进日期"), status: "active", archivedAt: null };
  if (data.teachingNotes.some((item) => item.id === id)) throw new Error("教学备注 id 重复");
  data.teachingNotes.push(note);
  appendProfileEvent(data, { personId, context: note, type: "note_created", entityId: id, detail: `新增${type}备注（正文 ${note.text.length} 字）`, time });
  return note;
}

export function updateTeachingNote(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => updateTeachingNote(draft, { ...args, __atomic: true }));
  const { noteId, type, text, tags, pinned, followUpDate, status, context, now = new Date().toISOString() } = args;
  const note = data.teachingNotes.find((item) => item.id === noteId);
  if (!note) throw new Error("教学备注不存在");
  if (note.status === "archived") throw new Error("已归档备注需先恢复后再修改");
  if (type !== undefined) { if (!NOTE_TYPES.includes(type)) throw new Error("请选择有效的教学备注类型"); note.type = type; }
  if (text !== undefined) note.text = cleanText(text, "教学备注正文");
  if (tags !== undefined) note.tags = cleanTags(tags);
  if (pinned !== undefined) note.pinned = Boolean(pinned);
  if (followUpDate !== undefined) note.followUpDate = validDate(followUpDate, "下次跟进日期");
  if (context !== undefined) Object.assign(note, validateContext(data, context, note.personId));
  const previousStatus = note.status;
  if (status !== undefined) { if (!["active", "completed"].includes(status)) throw new Error("教学备注状态无效"); note.status = status; }
  note.updatedAt = timestamp(now);
  appendProfileEvent(data, { personId: note.personId, context: note, type: previousStatus !== "completed" && note.status === "completed" ? "note_completed" : "note_modified", entityId: note.id, detail: previousStatus !== "completed" && note.status === "completed" ? `完成${note.type}备注的跟进` : `修改${note.type}备注（正文 ${note.text.length} 字）`, time: note.updatedAt });
  return note;
}

export function archiveTeachingNote(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => archiveTeachingNote(draft, { ...args, __atomic: true }));
  const { noteId, now = new Date().toISOString() } = args;
  const note = data.teachingNotes.find((item) => item.id === noteId);
  if (!note) throw new Error("教学备注不存在");
  note.status = "archived"; note.pinned = false; note.archivedAt = timestamp(now); note.updatedAt = note.archivedAt;
  appendProfileEvent(data, { personId: note.personId, context: note, type: "note_archived", entityId: note.id, detail: `归档${note.type}备注`, time: note.updatedAt });
}

export function restoreTeachingNote(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => restoreTeachingNote(draft, { ...args, __atomic: true }));
  const { noteId, now = new Date().toISOString() } = args;
  const note = data.teachingNotes.find((item) => item.id === noteId);
  if (!note || note.status !== "archived") throw new Error("归档备注不存在");
  note.status = "active"; note.archivedAt = null; note.updatedAt = timestamp(now);
  appendProfileEvent(data, { personId: note.personId, context: note, type: "note_restored", entityId: note.id, detail: `恢复${note.type}备注`, time: note.updatedAt });
}

export function permanentlyDeleteTeachingNote(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => permanentlyDeleteTeachingNote(draft, { ...args, __atomic: true }));
  const { noteId, confirmed = false, safetyBackupWriter } = args;
  const index = data.teachingNotes.findIndex((item) => item.id === noteId && item.status === "archived");
  if (index < 0) throw new Error("只有归档备注可以永久删除");
  if (!confirmed) throw new Error("永久删除必须二次确认");
  if (typeof safetyBackupWriter !== "function") throw new Error("永久删除前必须提供安全副本写入器");
  const backup = structuredClone(data);
  const result = safetyBackupWriter(backup);
  if (result !== true) throw new Error("安全副本保存器必须同步返回明确成功，备注未删除");
  const note = data.teachingNotes[index];
  appendProfileEvent(data, { personId: note.personId, context: note, type: "note_deleted", entityId: note.id, detail: `永久删除已归档备注：${note.type}`, time: new Date().toISOString() });
  data.teachingNotes.splice(index, 1);
  data.followUps.forEach((item) => { if (item.sourceType === "note" && item.sourceId === noteId) { item.sourceType = "manual"; item.sourceId = null; } });
  return backup;
}

export function addLearningGoal(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => addLearningGoal(draft, { ...args, __atomic: true }));
  const { personId, title, description = "", courseId = null, startDate, dueDate = null, status = "not_started", id = makeId("goal"), now = new Date().toISOString() } = args;
  person(data, personId);
  if (courseId !== null && !data.courses.some((item) => item.id === courseId)) throw new Error("目标课程不存在");
  if (!GOAL_STATUSES.includes(status)) throw new Error("学习目标状态无效");
  const time = timestamp(now);
  const goal = { id, personId, title: cleanText(title, "学习目标标题", { max: 120 }), description: cleanOptionalText(description, "学习目标说明", 1000), courseId, startDate: validDate(startDate, "开始日期", false), dueDate: validDate(dueDate, "截止日期"), status, progress: [], createdAt: time, updatedAt: time, completedAt: status === "completed" ? time : null };
  if (data.learningGoals.some((item) => item.id === id)) throw new Error("学习目标 id 重复");
  data.learningGoals.push(goal);
  appendProfileEvent(data, { personId, type: "goal_created", entityId: id, detail: `建立学习目标：${goal.title}`, time });
  return goal;
}

export function updateLearningGoal(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => updateLearningGoal(draft, { ...args, __atomic: true }));
  const { goalId, status, title, description, dueDate, now = new Date().toISOString() } = args;
  const goal = data.learningGoals.find((item) => item.id === goalId);
  if (!goal) throw new Error("学习目标不存在");
  const previousStatus = goal.status;
  if (status !== undefined) { if (!GOAL_STATUSES.includes(status)) throw new Error("学习目标状态无效"); goal.status = status; goal.completedAt = status === "completed" ? timestamp(now) : null; }
  if (title !== undefined) goal.title = cleanText(title, "学习目标标题", { max: 120 });
  if (description !== undefined) goal.description = cleanOptionalText(description, "学习目标说明", 1000);
  if (dueDate !== undefined) goal.dueDate = validDate(dueDate, "截止日期");
  if (goal.dueDate !== null && goal.dueDate < goal.startDate) throw new Error("学习目标截止日期不能早于开始日期");
  goal.updatedAt = timestamp(now);
  appendProfileEvent(data, { personId: goal.personId, type: previousStatus !== "completed" && goal.status === "completed" ? "goal_completed" : "goal_modified", entityId: goal.id, detail: previousStatus !== "completed" && goal.status === "completed" ? `完成学习目标：${goal.title}` : `修改学习目标：${goal.title}`, time: goal.updatedAt });
  return goal;
}

export function addGoalProgress(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => addGoalProgress(draft, { ...args, __atomic: true }));
  const { goalId, text, id = makeId("progress"), now = new Date().toISOString() } = args;
  const goal = data.learningGoals.find((item) => item.id === goalId);
  if (!goal) throw new Error("学习目标不存在");
  if (goal.progress.some((item) => item.id === id)) throw new Error("目标进展 id 重复");
  const time = timestamp(now);
  goal.progress.push({ id, text: cleanText(text, "目标进展", { max: 500 }), createdAt: time }); goal.updatedAt = time;
  appendProfileEvent(data, { personId: goal.personId, type: "goal_progress", entityId: goal.id, detail: `目标“${goal.title}”进展：${text}`, time });
}

export function addFollowUp(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => addFollowUp(draft, { ...args, __atomic: true }));
  const { personId, context, sourceType = "manual", sourceId = null, content, plannedDate, id = makeId("follow"), now = new Date().toISOString() } = args;
  person(data, personId);
  if (!["note", "attendance", "score", "manual"].includes(sourceType)) throw new Error("跟进来源无效");
  if (sourceType === "note" && !data.teachingNotes.some((item) => item.id === sourceId && item.personId === personId)) throw new Error("来源备注不存在或不属于该学生");
  const time = timestamp(now);
  if (sourceType !== "manual" && !sourceId) throw new Error("非手动跟进必须选择来源记录");
  const safeContext = validateContext(data, context, personId);
  if (sourceType === "attendance") {
    const source = data.attendanceSessions.find((item) => item.id === sourceId);
    const selected = source && rosterFor(data, source.semesterId, source.classId)?.students.find((item) => item.personId === personId);
    if (!source || !selected || !Object.hasOwn(source.records, selected.id) || source.semesterId !== safeContext.semesterId || source.classId !== safeContext.classId || source.courseId !== safeContext.courseId) throw new Error("来源考勤不存在、上下文不一致或不属于该学生");
  }
  if (sourceType === "score") {
    const scoreItem = data.scoreItems.find((item) => item.id === sourceId);
    const performance = data.performanceEvents.find((item) => item.id === sourceId);
    const source = scoreItem ?? performance;
    const selected = source && rosterFor(data, source.semesterId, source.classId)?.students.find((item) => item.personId === personId);
    if (!source || !selected || source.semesterId !== safeContext.semesterId || source.classId !== safeContext.classId || source.courseId !== safeContext.courseId || (scoreItem ? !Object.hasOwn(scoreItem.scores, selected.id) : performance.studentId !== selected.id)) throw new Error("来源成绩记录不存在、上下文不一致或不属于该学生");
  }
  const followUp = { id, personId, ...safeContext, sourceType, sourceId, content: cleanText(content, "跟进内容", { max: 500 }), plannedDate: validDate(plannedDate, "计划日期", false), status: "pending", completionNote: "", createdAt: time, updatedAt: time, completedAt: null };
  if (data.followUps.some((item) => item.id === id)) throw new Error("跟进事项 id 重复");
  data.followUps.push(followUp);
  appendProfileEvent(data, { personId, context: followUp, type: "followup_created", entityId: id, detail: `安排 ${followUp.plannedDate} 跟进（内容 ${followUp.content.length} 字）`, time });
  return followUp;
}

export function completeFollowUp(data, args) {
  if (!args.__atomic) return atomicMutation(data, (draft) => completeFollowUp(draft, { ...args, __atomic: true }));
  const { followUpId, completionNote = "", linkedNoteText = "", now = new Date().toISOString(), linkedNoteId = makeId("note") } = args;
  const followUp = data.followUps.find((item) => item.id === followUpId);
  if (!followUp) throw new Error("跟进事项不存在");
  if (followUp.status !== "pending") throw new Error("只有待跟进事项可以完成");
  const time = timestamp(now);
  followUp.status = "completed"; followUp.completionNote = cleanOptionalText(completionNote, "完成说明", 500); followUp.updatedAt = time; followUp.completedAt = time;
  appendProfileEvent(data, { personId: followUp.personId, context: followUp, type: "followup_completed", entityId: followUp.id, detail: `完成跟进${followUp.completionNote ? `（说明 ${followUp.completionNote.length} 字）` : ""}`, time });
  if (String(linkedNoteText ?? "").trim()) return addTeachingNote(data, { personId: followUp.personId, context: followUp, type: "沟通记录", text: linkedNoteText, id: linkedNoteId, now: time });
  return null;
}

export function followUpsDue(data, date = new Date().toISOString().slice(0, 10)) {
  return data.followUps.filter((item) => item.status === "pending" && item.plannedDate <= date).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate));
}

export function profileOverview(data, { personId, studentId = null, offeringId = null }) {
  const snapshots = personSnapshots(data, personId);
  const selected = (studentId ? snapshots.find((item) => item.studentId === studentId) : null) ?? snapshots.find((item) => !item.semester?.archived) ?? snapshots.at(-1);
  if (!selected) throw new Error("学生档案没有名单快照");
  const offering = (offeringId ? selected.offerings.find((item) => item.id === offeringId) : null) ?? selected.offerings[0] ?? null;
  const attendance = Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0]));
  data.attendanceSessions.filter((item) => item.semesterId === selected.semesterId && item.classId === selected.classId && (!offering || item.courseId === offering.courseId)).forEach((session) => (session.records[selected.studentId] ?? []).forEach((record) => { attendance[record.status] += 1; }));
  const scores = offering ? studentScores(data, { ...offering, studentId: selected.studentId }) : null;
  return { person: person(data, personId), snapshots, selected, offering, attendance, scores };
}

export function buildTeachingTimeline(data, { personId, semesterId = "", courseId = "", types = [], includeDraws = false } = {}) {
  const snapshots = personSnapshots(data, personId);
  const studentIds = new Set(snapshots.filter((item) => !semesterId || item.semesterId === semesterId).map((item) => item.studentId));
  const allowed = (type) => !types.length || types.includes(type);
  const contextAllowed = (item) => (!semesterId || item.semesterId === semesterId) && (!courseId || item.courseId === courseId);
  const entries = [];
  const auditType = (type) => type.startsWith("note_") ? "note" : type.startsWith("goal_") ? "goal" : type.startsWith("followup_") ? "followUp" : type === "score_change" ? "score" : "association";
  const auditLabel = { note_created: "新增教学备注", note_modified: "修改教学备注", note_completed: "教学备注完成跟进", note_archived: "归档教学备注", note_restored: "恢复教学备注", note_deleted: "永久删除教学备注", goal_created: "建立学习目标", goal_modified: "修改学习目标", goal_progress: "记录目标进展", goal_completed: "完成学习目标", followup_created: "安排跟进", followup_completed: "完成跟进", score_change: "成绩调整", association: "档案关联变更" };
  data.profileEvents.filter((item) => item.personId === personId && contextAllowed(item)).forEach((item) => { const type = auditType(item.type); if (allowed(type)) entries.push({ id: `profile-event:${item.id}`, time: item.time, type, label: auditLabel[item.type], detail: item.detail, semesterId: item.semesterId, courseId: item.courseId }); });
  if (allowed("attendance")) data.attendanceSessions.filter((item) => contextAllowed(item)).forEach((session) => Object.entries(session.records).filter(([studentId]) => studentIds.has(studentId)).forEach(([, records]) => records.forEach((record, section) => { if (record.status !== "出勤") entries.push({ id: `attendance:${session.id}:${section}`, time: `${session.date}T00:00:00.000Z`, type: "attendance", label: "考勤异常", detail: `第${section + 1}节 · ${record.status}${record.note ? ` · ${record.note}` : ""}`, semesterId: session.semesterId, courseId: session.courseId }); })));
  if (allowed("performance")) data.performanceEvents.filter((item) => studentIds.has(item.studentId) && contextAllowed(item)).forEach((item) => entries.push({ id: `performance:${item.id}`, time: item.time ?? item.createdAt ?? "1970-01-01T00:00:00.000Z", type: "performance", label: "课堂表现", detail: `${item.delta > 0 ? "+" : ""}${item.delta} · ${item.reason}${item.revokedAt ? "（已撤销）" : ""}`, semesterId: item.semesterId, courseId: item.courseId }));
  if (includeDraws && allowed("draw")) data.drawHistory.filter((item) => studentIds.has(item.studentId) && contextAllowed(item)).forEach((item) => entries.push({ id: `draw:${item.id}`, time: item.time, type: "draw", label: "课堂抽名", detail: item.mode === "pure" ? "纯随机抽中" : "加权随机抽中", semesterId: item.semesterId, courseId: item.courseId }));
  return entries.sort((a, b) => b.time.localeCompare(a.time));
}

export function recordProfileEvent(data, { personId, semesterId, classId, courseId, type, detail, id = makeId("profile_event"), time = new Date().toISOString() }) {
  if (!["score_change", "association"].includes(type)) throw new Error("档案事实事件类型无效");
  return appendProfileEvent(data, { personId, context: { semesterId, classId, courseId }, type, detail, id, time });
}

export function databaseCapacity(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
  return { bytes, limit: MAX_CLOUD_PAYLOAD_BYTES, ratio: bytes / MAX_CLOUD_PAYLOAD_BYTES, warning: bytes >= CAPACITY_WARNING_BYTES, exceeds: bytes > MAX_CLOUD_PAYLOAD_BYTES };
}
