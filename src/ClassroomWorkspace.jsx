import React, { useEffect, useMemo, useState } from "react";
import {
  ATTENDANCE_STATUSES,
  assertWritableSemester,
  drawStudent,
  makeId,
  validateAttendanceSession,
} from "./core.mjs";
import {
  recentWorkspaceOfferings,
  recordWorkspacePerformance,
  rememberWorkspaceOffering,
  startWorkspaceAttendance,
  workspaceAttendanceForDate,
  workspaceOffering,
  workspaceWarnings,
} from "./workspace-core.mjs";

function todayText() { return new Date().toISOString().slice(0, 10); }

function contextLabel(context) {
  return `${context.semester.name}｜${context.classItem.name}｜${context.course.name}${context.archived ? "（归档）" : ""}`;
}

function sessionExcludedIds(session) {
  if (!session) return [];
  return Object.entries(session.records).filter(([, records]) => records.some((record) => ["缺勤", "病假", "事假"].includes(record.status))).map(([studentId]) => studentId);
}

export default function ClassroomWorkspace({ data, commitData, syncStatus, notify, openPage }) {
  const contexts = useMemo(() => recentWorkspaceOfferings(data, { includeArchived: true }), [data]);
  const fallbackId = contexts.find((item) => !item.archived)?.offering.id ?? contexts[0]?.offering.id ?? "";
  const [offeringId, setOfferingId] = useState(() => workspaceOffering(data, data.settings.workspaceContext.offeringId)?.offering.id ?? fallbackId);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  const [drawnStudent, setDrawnStudent] = useState(null);
  const context = workspaceOffering(data, offeringId);
  const warnings = context ? workspaceWarnings(data, offeringId) : [];
  const todaySession = context ? workspaceAttendanceForDate(data, offeringId, todayText()) : null;

  useEffect(() => {
    if (!workspaceOffering(data, offeringId) && fallbackId) setOfferingId(fallbackId);
  }, [data, offeringId, fallbackId]);

  function chooseOffering(nextId) {
    try {
      commitData(rememberWorkspaceOffering(data, nextId));
      setOfferingId(nextId);
      setAttendanceOpen(false);
      setDraft(null);
      setDrawnStudent(null);
      notify("课堂已切换；考勤、抽名、课堂表现和预警将共用这个班级课程");
    } catch (error) { notify(error.message); }
  }

  function openAttendance() {
    if (!context) return notify("请先选择班级课程，数据未改动");
    if (context.archived) return notify("这是归档学期，只能查看历史记录，数据未改动");
    try {
      const started = startWorkspaceAttendance(data, { offeringId, date: todayText(), sectionCount: data.settings.defaultSections });
      if (started.created) commitData(started.data);
      const session = started.data.attendanceSessions.find((item) => item.id === started.sessionId);
      setDraft(structuredClone(session));
      setAttendanceOpen(true);
      setDirty(false);
      notify(started.created ? "本次考勤表已建立，选择状态后请保存" : "已继续今天的考勤表");
    } catch (error) { notify(error.message); }
  }

  function changeAttendance(studentId, sectionIndex, field, value) {
    setDraft((current) => {
      const next = structuredClone(current);
      next.records[studentId][sectionIndex][field] = value;
      if (field === "status" && value !== "其他") next.records[studentId][sectionIndex].note = "";
      return next;
    });
    setDirty(true);
  }

  function allPresent() {
    setDraft((current) => {
      const next = structuredClone(current);
      Object.values(next.records).forEach((records) => records.forEach((record) => { record.status = "出勤"; record.note = ""; }));
      return next;
    });
    setDirty(true);
  }

  function saveAttendance() {
    if (!draft) return;
    try {
      assertWritableSemester(data, draft.semesterId);
      const errors = validateAttendanceSession(draft);
      if (errors.length) throw new Error(`${errors[0]}；数据尚未保存`);
      const next = structuredClone(data);
      const index = next.attendanceSessions.findIndex((item) => item.id === draft.id);
      if (index < 0) throw new Error("考勤表已不存在，数据尚未保存；请重新打开");
      next.attendanceSessions[index] = structuredClone(draft);
      commitData(next);
      setDirty(false);
      notify("考勤已保存在本机；云模式会继续核对云端版本");
    } catch (error) { notify(error.message); }
  }

  function drawOne() {
    if (!context || context.archived) return notify("归档学期不能继续抽名，数据未改动");
    try {
      assertWritableSemester(data, context.offering.semesterId);
      const excludedIds = sessionExcludedIds(todaySession);
      const counts = data.drawHistory.filter((item) => item.semesterId === context.offering.semesterId && item.classId === context.offering.classId && item.courseId === context.offering.courseId).reduce((map, item) => ({ ...map, [item.studentId]: (map[item.studentId] ?? 0) + 1 }), {});
      const student = drawStudent(context.students, { mode: "pure", excludedIds, counts });
      const next = structuredClone(data);
      next.drawHistory.push({ id: makeId("draw"), semesterId: context.offering.semesterId, classId: context.offering.classId, courseId: context.offering.courseId, studentId: student.id, mode: "pure", time: new Date().toISOString() });
      commitData(next);
      setDrawnStudent(student);
      notify("已完成纯随机抽名；今日缺勤、病假和事假学生未参与");
    } catch (error) { notify(error.message); }
  }

  function addPreset(delta, reason) {
    if (!drawnStudent) return;
    try {
      commitData(recordWorkspacePerformance(data, { offeringId, studentId: drawnStudent.id, delta, reason }));
      notify(`已为 ${drawnStudent.name} 记录“${reason}”`);
    } catch (error) { notify(error.message); }
  }

  if (!contexts.length) return <section className="panel"><h2>课堂工作台</h2><p>还没有班级课程。请先到“基础数据”添加学期、班级、课程和名单。</p><button onClick={() => openPage("setup")}>前往基础数据</button></section>;

  const visibleStudents = draft ? context.students.filter((student) => !abnormalOnly || draft.records[student.id].some((record) => record.status !== "出勤")) : [];
  const saveLabel = dirty ? "有未保存的考勤修改" : attendanceOpen ? "本节考勤已保存" : syncStatus;

  return <>
    <section className="workspace-context panel" aria-labelledby="workspace-context-title">
      <div><p className="eyebrow">一次选择，全程保持</p><h2 id="workspace-context-title">课堂工作台</h2><p>考勤、抽名、课堂表现和预警共用同一个班级课程。</p></div>
      <label>当前班级课程<select value={offeringId} onChange={(event) => chooseOffering(event.target.value)}>{contexts.map((item) => <option key={item.offering.id} value={item.offering.id}>{contextLabel(item)}</option>)}</select></label>
    </section>
    {context?.archived ? <section className="panel archived-workspace"><p className="eyebrow">归档只读</p><h2>{context.classItem.name} · {context.course.name}</h2><p>该学期已经归档。课堂操作不会显示，历史考勤和报表仍可查看。</p><div className="button-row"><button onClick={() => openPage("attendance")}>查看历史考勤</button><button onClick={() => openPage("reports")}>查看历史报表</button></div></section> : <>
      <section className="workspace-status" role="status" aria-live="polite"><strong>{saveLabel}</strong><span>{dirty ? "当前改动只在页面中，离开前请点“保存本次考勤”" : "业务数据先保存在本机；云模式再核对版本后同步"}</span></section>
      <section className="workspace-grid">
        <article className="panel workspace-action"><p className="eyebrow">本节考勤</p><h2>{todaySession ? "继续今天的考勤" : "开始今天的考勤"}</h2><p>{todaySession ? `${todaySession.sectionCount} 节 · 已建立考勤表` : `默认 ${data.settings.defaultSections} 节 · 全班先按出勤建立`}</p><button className="primary" onClick={openAttendance}>{todaySession ? "继续考勤" : "开始考勤"}</button></article>
        <article className="panel workspace-action"><p className="eyebrow">纯随机抽名</p><h2>{drawnStudent ? drawnStudent.name : "准备抽一名学生"}</h2><p>{drawnStudent ? (drawnStudent.studentNo || "未填写学号") : "自动排除今日缺勤、病假和事假"}</p><button className="primary" onClick={drawOne}>抽一名学生</button>{drawnStudent && <div className="preset-actions" aria-label="课堂表现快捷记录"><button onClick={() => addPreset(1, "主动回答")}>+1 主动回答</button><button onClick={() => addPreset(2, "完成挑战")}>+2 完成挑战</button><button onClick={() => addPreset(-1, "课堂提醒")}>-1 课堂提醒</button></div>}</article>
        <article className="panel workspace-warnings"><p className="eyebrow">本班预警</p><h2>{warnings.length} 条需关注</h2>{warnings.length ? <ul>{warnings.slice(0, 5).map((item, index) => <li key={`${item.student.id}-${item.reason}-${index}`}><strong>{item.student.name}</strong><span>{item.reason}</span></li>)}</ul> : <p>当前没有达到阈值的学生。</p>}<button onClick={() => openPage("reports")}>查看预警报表</button></article>
      </section>
      {attendanceOpen && draft && <section className="panel attendance-editor workspace-attendance"><div className="section-heading"><div><p className="eyebrow">异常学生快速标记</p><h2>{context.classItem.name} · {draft.sectionCount} 节</h2><p className="muted">投屏保护：工作台不显示“其他”状态的备注；请到“考勤”页新增或修改该备注。</p></div><div className="button-row"><button onClick={allPresent}>一键全勤</button><button className={abnormalOnly ? "active-filter" : ""} onClick={() => setAbnormalOnly((value) => !value)}>{abnormalOnly ? "显示全班" : "只看异常"}</button><button className="primary" onClick={saveAttendance}>保存本次考勤</button></div></div><div className="table-scroll"><table><thead><tr><th>学生</th>{Array.from({ length: draft.sectionCount }, (_, index) => <th key={index}>第{index + 1}节</th>)}</tr></thead><tbody>{visibleStudents.map((student) => <tr key={student.id}><td><strong>{student.name}</strong><small>{student.studentNo || "未填写学号"}</small></td>{draft.records[student.id].map((record, index) => <td key={index}><select aria-label={`${student.name}第${index + 1}节状态`} className={`status-${record.status}`} value={record.status} onChange={(event) => changeAttendance(student.id, index, "status", event.target.value)}>{ATTENDANCE_STATUSES.filter((status) => status !== "其他").map((status) => <option key={status}>{status}</option>)}<option value="其他" disabled>其他（备注请到考勤页维护）</option></select></td>)}</tr>)}</tbody></table></div></section>}
    </>}
  </>;
}
