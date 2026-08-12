import React, { useEffect, useMemo, useRef, useState } from "react";
import { ATTENDANCE_STATUSES } from "./core.mjs";
import { buildStudentCourseDetail, buildStudentSearchIndex, searchStudents } from "./student-search-core.mjs";

function StudentDetail({ data, target, focus, back }) {
  const detail = buildStudentCourseDetail(data, target);
  const focusRef = useRef(null);
  useEffect(() => { focusRef.current?.focus(); }, [focus]);
  return <div className="student-detail">
    <div className="section-heading"><div><p className="eyebrow">{detail.semester.name} · {detail.classItem.name} · {detail.course.name}</p><h2>{detail.student.name}</h2><p>{detail.student.studentNo ? `学号 ${detail.student.studentNo}` : "未填写学号"}</p><span className="privacy-badge">请勿投屏 · 个人考勤与成绩明细</span></div><button onClick={back}>返回搜索结果</button></div>
    <section className={focus === "attendance" ? "detail-focus" : ""} aria-labelledby="student-attendance-title"><h3 id="student-attendance-title" ref={focus === "attendance" ? focusRef : null} tabIndex="-1">考勤明细</h3><div className="metric-grid detail-metrics">{ATTENDANCE_STATUSES.map((status) => <article key={status}><span>{status}</span><strong>{detail.stats[status] ?? 0}</strong></article>)}</div>{detail.sessions.length ? <div className="table-scroll"><table><thead><tr><th>日期</th><th>节次</th><th>状态</th><th>备注</th></tr></thead><tbody>{detail.sessions.flatMap((session) => session.records.map((record) => <tr key={`${session.id}-${record.section}`}><td>{session.date}</td><td>第{record.section}节</td><td>{record.status}</td><td>{record.note || "—"}</td></tr>))}</tbody></table></div> : <p className="empty">该课程暂无考勤记录</p>}</section>
    <section className={focus === "scores" ? "detail-focus" : ""} aria-labelledby="student-score-title"><h3 id="student-score-title" ref={focus === "scores" ? focusRef : null} tabIndex="-1">平时分明细</h3><div className="table-scroll"><table><thead><tr><th>成绩项</th><th>初始分</th><th>自动调整</th><th>当前分</th></tr></thead><tbody>{detail.scores.components.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.base}</td><td>{item.adjustment > 0 ? `+${item.adjustment}` : item.adjustment}</td><td>{item.score}</td></tr>)}</tbody><tfoot><tr><th colSpan="3">当前加权总分</th><th>{detail.scores.总分}</th></tr></tfoot></table></div></section>
  </div>;
}

export default function StudentSearch({ data, close, workspaceOfferingId }) {
  const activeSemesters = useMemo(() => data.semesters.filter((item) => !item.archived), [data]);
  const workspaceSemesterId = useMemo(() => {
    const offering = data.offerings.find((item) => item.id === workspaceOfferingId);
    return activeSemesters.some((item) => item.id === offering?.semesterId) ? offering.semesterId : "";
  }, [activeSemesters, data.offerings, workspaceOfferingId]);
  const [semesterId, setSemesterId] = useState(() => workspaceSemesterId || (activeSemesters.length === 1 ? activeSemesters[0].id : ""));
  const semester = activeSemesters.find((item) => item.id === semesterId) ?? null;
  const index = useMemo(() => buildStudentSearchIndex(data, semesterId), [data, semesterId]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [courseChoice, setCourseChoice] = useState(null);
  const [detail, setDetail] = useState(null);
  const [keyboardMessage, setKeyboardMessage] = useState("");
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const courseChoiceRef = useRef(null);
  const resultRefs = useRef(new Map());
  useEffect(() => {
    const opener = document.activeElement;
    inputRef.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const allowed = activeSemesters.some((item) => item.id === semesterId);
    if (allowed) return;
    setSemesterId(workspaceSemesterId || (activeSemesters.length === 1 ? activeSemesters[0].id : ""));
  }, [activeSemesters, semesterId, workspaceSemesterId]);
  useEffect(() => { const timer = setTimeout(() => setDebouncedQuery(query), 50); return () => clearTimeout(timer); }, [query]);
  const results = useMemo(() => searchStudents(index, debouncedQuery), [index, debouncedQuery]);
  useEffect(() => { setActiveIndex(0); }, [debouncedQuery, semesterId]);
  useEffect(() => {
    if (!results.length) return;
    resultRefs.current.get(results[activeIndex]?.studentId)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);
  useEffect(() => { if (courseChoice) requestAnimationFrame(() => courseChoiceRef.current?.focus()); }, [courseChoice]);
  function restoreSearchFocus() { setCourseChoice(null); setDetail(null); requestAnimationFrame(() => inputRef.current?.focus()); }
  function openResult(result) {
    if (!result.courses.length) {
      setKeyboardMessage(`${result.name}所在班级尚未关联课程，不能打开明细；请先到“基础数据”关联课程。`);
      return;
    }
    setKeyboardMessage("");
    if (result.courses.length === 1) setDetail({ studentId: result.studentId, offeringId: result.courses[0].offeringId, focus: "attendance" });
    else setCourseChoice(result);
  }
  function onInputKeyDown(event) {
    if (event.key === "ArrowDown" && results.length) { event.preventDefault(); setActiveIndex((value) => Math.min(results.length - 1, value + 1)); }
    else if (event.key === "ArrowUp" && results.length) { event.preventDefault(); setActiveIndex((value) => Math.max(0, value - 1)); }
    else if (event.key === "Enter" && results[activeIndex]) { event.preventDefault(); openResult(results[activeIndex]); }
    else if (event.key === "Escape") { event.preventDefault(); if (query) { setQuery(""); setDebouncedQuery(""); } else close(); }
  }
  function dialogKeyDown(event) {
    if (event.key === "Tab") {
      const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== "Escape" || event.target === inputRef.current) return;
    event.preventDefault();
    if (detail || courseChoice) restoreSearchFocus(); else close();
  }
  return <div className="search-overlay" role="presentation"><section ref={dialogRef} className="search-dialog" role="dialog" aria-modal="true" aria-labelledby="student-search-title" onKeyDown={dialogKeyDown}>
    <header><div><p className="eyebrow">只查找当前在用学期</p><h1 id="student-search-title">全局学生查找</h1></div><button aria-label="关闭学生查找" onClick={close}>关闭</button></header>
    {detail ? <StudentDetail data={data} target={detail} focus={detail.focus} back={restoreSearchFocus} /> : courseChoice ? <div className="course-choice"><button ref={courseChoiceRef} onClick={restoreSearchFocus}>返回搜索结果</button><p className="eyebrow">{courseChoice.className} · 名单第{courseChoice.rosterPosition}位</p><h2>为 {courseChoice.name} 选择课程</h2><p>该学生有多门课程，请明确选择，系统不会默认替你决定。</p>{courseChoice.courses.map((course) => <article key={course.offeringId}><strong>{course.courseName}</strong><div className="button-row"><button onClick={() => setDetail({ studentId: courseChoice.studentId, offeringId: course.offeringId, focus: "attendance" })}>查看考勤明细</button><button onClick={() => setDetail({ studentId: courseChoice.studentId, offeringId: course.offeringId, focus: "scores" })}>查看平时分明细</button></div></article>)}</div> : <>
      {activeSemesters.length > 1 && <label className="semester-search-choice">查找学期<select value={semesterId} onChange={(event) => { setSemesterId(event.target.value); setQuery(""); setDebouncedQuery(""); setKeyboardMessage(""); }}><option value="">请选择当前要查找的学期</option>{activeSemesters.map((item) => <option key={item.id} value={item.id}>{item.name}{item.id === workspaceSemesterId ? "（课堂工作台当前学期）" : ""}</option>)}</select></label>}
      {!semester && <p className="search-guidance" role="status">存在多个使用中学期，且课堂工作台尚未选定当前学期。请先明确选择一个学期，系统不会自动替你决定。</p>}
      <label className="search-field">姓名或非空学号<input ref={inputRef} type="search" maxLength="100" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onInputKeyDown} aria-describedby="search-help search-status" aria-activedescendant={results[activeIndex] ? `search-result-${results[activeIndex].studentId}` : undefined} /></label>
      <p id="search-help" className="muted">输入后约 50 毫秒显示结果；↑↓选择，Enter 打开，Escape 清空或关闭。</p>
      <p id="search-status" role="status" aria-live="polite">{keyboardMessage || (debouncedQuery ? `找到 ${results.length} 条结果` : semester ? `${semester.name}共 ${index.length} 名学生` : "请先选择查找学期")}</p>
      <div className="search-results">{results.map((result, resultIndex) => <article ref={(node) => { if (node) resultRefs.current.set(result.studentId, node); else resultRefs.current.delete(result.studentId); }} data-search-index={resultIndex} id={`search-result-${result.studentId}`} key={result.studentId} className={resultIndex === activeIndex ? "search-result active" : "search-result"} onMouseEnter={() => setActiveIndex(resultIndex)}><div><strong>{result.name}</strong><span>{result.studentNo || "未填写学号"} · {result.className} · 名单第{result.rosterPosition}位</span></div>{result.courses.length ? <div className="search-courses">{result.courses.map((course) => <div key={course.offeringId}><span>{course.courseName}</span><button onClick={() => setDetail({ studentId: result.studentId, offeringId: course.offeringId, focus: "attendance" })}>查看考勤明细</button><button onClick={() => setDetail({ studentId: result.studentId, offeringId: course.offeringId, focus: "scores" })}>查看平时分明细</button></div>)}</div> : <span className="muted">该班级尚未关联课程；请先到“基础数据”关联课程</span>}</article>)}{debouncedQuery && !results.length && <p className="empty">没有找到匹配学生；请核对姓名或已填写的学号。</p>}</div>
    </>}
  </section></div>;
}
