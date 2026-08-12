import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ATTENDANCE_STATUSES, addScoreComponent, assertValidEventDelta, assertWritableSemester, attendanceStats,
  createAttendanceSession, createDefaultScoreConfig, createFictionalDataset, deleteScoreComponent, deleteStudentSafely,
  drawStudent, exportDatabase, importDatabaseSafely, makeId, parseRosterText, rosterFor, scoreConfigFor,
  setAttendanceScoreRule, setStudentBaseScore, studentScores, studentsFor, updateScoreComponent,
  validateAttendanceSession, validateDatabase, validateRoster, warningRows,
} from "./core.mjs";
import { inspectStoredData, loadData, replaceDataAtomically, saveData } from "./storage.js";
import { exportCanvasAsPdf } from "./pdf-export.mjs";
import { useRealtimeSync } from "./use-realtime-sync.jsx";
import { recentWorkspaceOfferings } from "./workspace-core.mjs";
import { addRosterStudents } from "./profile-core.mjs";
import "./styles.css";

const APP_VERSION = "3.0-alpha";
const ClassroomWorkspace = lazy(() => import("./ClassroomWorkspace.jsx"));
const DataHealth = lazy(() => import("./DataHealth.jsx"));
const StudentSearch = lazy(() => import("./StudentSearch.jsx"));
const Onboarding = lazy(() => import("./Onboarding.jsx"));

const NAV = [
  ["dashboard", "总览", "⌂"], ["workspace", "课堂工作台", "▶"], ["setup", "基础数据", "▦"], ["attendance", "考勤", "✓"],
  ["scores", "平时分", "+"], ["draw", "快速抽名", "◎"], ["reports", "报表", "▤"], ["backup", "数据健康与恢复", "⚙"],
];

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function todayText() { return new Date().toISOString().slice(0, 10); }
function classById(data, id) { return data.classes.find((item) => item.id === id); }
function courseById(data, id) { return data.courses.find((item) => item.id === id); }
function semesterById(data, id) { return data.semesters.find((item) => item.id === id); }
function isArchived(data, semesterId) { return Boolean(semesterById(data, semesterId)?.archived); }
function offeringLabel(data, item) { return `${semesterById(data, item.semesterId)?.name ?? "-"}｜${classById(data, item.classId)?.name ?? "-"}｜${courseById(data, item.courseId)?.name ?? "-"}`; }
function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function compactSyncStatus(status) { return ({ "未配置云同步": "本地", "未登录": "未登录", "正在同步": "同步中", "已同步": "已同步", "离线，存在待同步修改": "待同步", "同步冲突": "冲突", "同步失败，可重试": "失败" })[status] ?? status; }

function Toast({ message }) { return message ? <div className="toast" role="status">{message}</div> : null; }

function SyncLogin({ sync, notify }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  async function submit(event) {
    event.preventDefault();
    try { await sync.signIn(email, password); }
    catch (error) { notify(error.message); }
  }
  return <main className="access-screen"><section className="access-card"><div className="brand-mark">课</div><p className="eyebrow">同一教师 · 多设备同步</p><h1>登录课堂管理系统</h1><p className="muted">账号由学校指定管理员创建，不开放页面注册。登录后只读取这个教师账号的数据。</p><form onSubmit={submit} className="access-form"><label>邮箱<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>密码<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary wide" disabled={sync.authLoading}>{sync.authLoading ? "正在登录…" : "登录"}</button></form>{sync.state.error && <p className="error" role="alert">{sync.state.error}</p>}<p className="access-footnote">首次登录必须联网；设备锁屏仍是本机访问的第一道保护。</p></section></main>;
}

function SyncLoading({ sync, notify }) {
  async function signOut() { try { await sync.signOut(); } catch (error) { notify(error.message); } }
  return <main className="access-screen"><section className="access-card"><div className="brand-mark">课</div><p className="eyebrow">{sync.state.status}</p><h1>{sync.startupBlocked ? "暂时无法取得可信数据" : "正在准备课堂数据"}</h1><p className="muted">{sync.state.error ?? "正在核对本机副本、云端版本和数据完整性。"}</p><div className="button-row"><button className="primary" onClick={() => sync.retry()}>{sync.startupBlocked ? "重试连接" : "重新检查"}</button>{sync.session && <button onClick={signOut}>退出账号</button>}</div><p className="access-footnote">首次连接失败且本机没有有效副本时，系统会停止写入，避免把空白数据误当成真实数据。</p></section></main>;
}

function VersionSummary({ title, summary }) {
  return <article className="version-card"><h3>{title}</h3>{summary ? <dl><div><dt>版本号</dt><dd>{summary.revision}</dd></div><div><dt>更新时间</dt><dd>{formatTime(summary.updatedAt)}</dd></div><div><dt>班级</dt><dd>{summary.classCount}</dd></div><div><dt>名单人次</dt><dd>{summary.studentCount}</dd></div><div><dt>考勤表</dt><dd>{summary.attendanceCount}</dd></div></dl> : <p className="muted">云端当前为空</p>}</article>;
}

function SyncDecision({ sync, notify }) {
  const [busy, setBusy] = useState(false);
  const decision = sync.conflict ?? { local: sync.migration?.summary, remote: null, localPayload: sync.migration?.payload, remotePayload: null };
  function exportVersion(kind) {
    const payload = kind === "local" ? decision.localPayload : decision.remotePayload;
    if (!payload) return notify("该版本当前为空");
    downloadBlob(new Blob([exportDatabase(validateDatabase(payload))], { type: "application/json;charset=utf-8" }), `同步${kind === "local" ? "本机" : "云端"}版本-${todayText()}.json`);
    if (kind === "local") sync.markBackup();
    notify(`${kind === "local" ? "本机" : "云端"}版本已导出`);
  }
  async function resolve(choice) {
    const label = choice === "local" ? "以本机覆盖云端" : "以云端为准";
    if (!confirm(`${label}。继续前请先分别导出需要保留的版本，是否继续？`) || !confirm(`再次确认：${label}，系统会先保存本机安全副本。`)) return;
    setBusy(true);
    try { await (choice === "local" ? sync.chooseLocal() : sync.chooseRemote()); notify("版本选择已完成"); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  }
  return <main className="decision-screen"><section className="decision-panel"><p className="eyebrow">{sync.conflict ? "同步冲突" : "首次迁移需要人工选择"}</p><h1>{sync.conflict ? "本机与云端数据不同，系统已停止覆盖" : "发现这台设备中的旧版数据"}</h1><p>两份数据不会自动合并。请先核对摘要、分别导出要保留的版本，再明确选择一份继续使用。</p><div className="version-grid"><VersionSummary title="本机版本" summary={decision.local} /><VersionSummary title="云端版本" summary={decision.remote} /></div><div className="button-row decision-exports"><button onClick={() => exportVersion("local")}>导出本机版本</button><button onClick={() => exportVersion("remote")} disabled={!decision.remotePayload}>导出云端版本</button></div><div className="button-row decision-actions"><button className="primary" disabled={busy} onClick={() => resolve("local")}>保留本机并上传</button><button className="danger" disabled={busy} onClick={() => resolve("remote")}>{decision.remotePayload ? "保留云端版本" : "采用空白云端"}</button></div><p className="privacy-warning">继续前会要求两次确认，并先在当前设备保存一份可导出的本机安全副本。</p></section></main>;
}

function LocalUpgrade({ inspection, complete }) {
  function exportOriginal() {
    downloadBlob(new Blob([inspection.raw], { type: "application/json;charset=utf-8" }), `课堂管理升级前原始数据-${todayText()}.json`);
  }
  if (inspection.kind === "invalid") return <main className="decision-screen"><section className="decision-panel"><p className="eyebrow">旧数据升级已停止</p><h1>原数据无法安全升级</h1><p>{inspection.error}。系统没有覆盖浏览器中的原数据。请先导出原始文件，再使用 v1.2.5 回滚版检查或从有效 JSON 备份恢复。</p><div className="button-row"><button className="primary" onClick={exportOriginal}>导出原始数据</button></div></section></main>;
  function confirmUpgrade() {
    if (!confirm(`将 ${inspection.sourceVersion} 数据升级为 3.0。现有 ID、名单快照和课堂记录会保留，且不会按同名自动关联档案，是否继续？`)) return;
    complete();
  }
  return <main className="decision-screen"><section className="decision-panel"><p className="eyebrow">3.0 旧数据升级</p><h1>先核对摘要，再升级本机数据</h1><p>当前数据仍保存在这台设备的浏览器中。升级不会自动上传，也不会删除未知旧字段；每个旧名单快照先建立独立档案，不按姓名或学号自动合并。</p><div className="metric-grid upgrade-summary"><article><span>来源版本</span><strong>{inspection.sourceVersion}</strong></article><article><span>学期</span><strong>{inspection.summary.semesterCount}</strong></article><article><span>班级</span><strong>{inspection.summary.classCount}</strong></article><article><span>名单人次</span><strong>{inspection.summary.studentCount}</strong></article><article><span>考勤表</span><strong>{inspection.summary.attendanceCount}</strong></article></div><div className="button-row"><button onClick={exportOriginal}>先导出升级前数据</button><button className="primary" onClick={confirmUpgrade}>确认升级到 3.0</button></div><p className="privacy-warning">下一步只替换本机浏览器内的旧格式；未配置云同步时不会上传任何数据。</p></section></main>;
}

function App() {
  const [localInspection, setLocalInspection] = useState(inspectStoredData);
  const [data, setData] = useState(() => localInspection.data ?? loadData());
  const [page, setPage] = useState("dashboard");
  const [notice, setNotice] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const sync = useRealtimeSync({ setData, notify: setNotice });
  const title = NAV.find(([id]) => id === page)?.[1];
  useEffect(() => { if (!notice) return undefined; const timer = setTimeout(() => setNotice(""), 2600); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    const ready = () => setUpdateReady(true);
    window.addEventListener("workbuddy:pwa-update-ready", ready);
    navigator.serviceWorker.getRegistration().then((registration) => { if (registration?.waiting) ready(); }).catch(() => {});
    return () => window.removeEventListener("workbuddy:pwa-update-ready", ready);
  }, []);
  useEffect(() => { const shortcuts = (event) => { if (event.key === "Escape") setMenuOpen(false); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); } else if (event.key === "/" && !/input|textarea|select/i.test(event.target?.tagName ?? "")) { event.preventDefault(); setSearchOpen(true); } }; window.addEventListener("keydown", shortcuts); return () => window.removeEventListener("keydown", shortcuts); }, []);
  function commitData(candidate, { atomic = false } = {}) {
    const validated = validateDatabase(candidate);
    if (sync.configured) void sync.save(validated).catch((error) => setNotice(error.message));
    else if (atomic) replaceDataAtomically(validated);
    else saveData(validated);
    setData(validated);
    return validated;
  }
  function update(mutator, message) {
    try {
      const next = structuredClone(data); mutator(next); commitData(next);
      if (message) setNotice(message);
    } catch (error) { setNotice(error.message); }
  }
  function completeLocalUpgrade() {
    try {
      const upgraded = replaceDataAtomically(localInspection.data);
      setData(upgraded);
      setLocalInspection({ kind: "current", data: upgraded, sourceVersion: upgraded.version, raw: JSON.stringify(upgraded) });
      setNotice("3.0 本机数据升级完成；数据仍保存在当前浏览器");
    } catch (error) { setNotice(`升级失败：${error.message}。原数据未改动。`); }
  }
  function completeOnboarding() {
    try {
      if (data.settings.onboarding.completedVersion !== "3.0") {
        const next = structuredClone(data);
        next.settings.onboarding.completedVersion = "3.0";
        commitData(next, { atomic: true });
        setNotice("使用说明已确认；可在“数据健康与恢复”中再次打开");
      }
      setGuideOpen(false);
    } catch (error) { setNotice(`无法保存使用确认：${error.message}。业务数据未改动。`); }
  }
  if (!sync.configured && ["legacy", "invalid"].includes(localInspection.kind)) return <><LocalUpgrade inspection={localInspection} complete={completeLocalUpgrade} /><Toast message={notice} /></>;
  if (sync.configured && sync.authLoading && !sync.session) return <><SyncLoading sync={sync} notify={setNotice} /><Toast message={notice} /></>;
  if (sync.configured && sync.startupBlocked) return <><SyncLoading sync={sync} notify={setNotice} /><Toast message={notice} /></>;
  if (sync.configured && !sync.session) return <><SyncLogin sync={sync} notify={setNotice} /><Toast message={notice} /></>;
  if (sync.configured && (sync.migration || sync.conflict)) return <><SyncDecision sync={sync} notify={setNotice} /><Toast message={notice} /></>;
  if (sync.configured && !sync.ready) return <><SyncLoading sync={sync} notify={setNotice} /><Toast message={notice} /></>;
  if (guideOpen || data.settings.onboarding.completedVersion !== "3.0") return <><Suspense fallback={<main className="decision-screen"><section className="decision-panel" role="status">正在准备使用说明…</section></main>}><Onboarding data={data} sync={sync} complete={completeOnboarding} reopened={guideOpen && data.settings.onboarding.completedVersion === "3.0"} close={() => setGuideOpen(false)} /></Suspense><Toast message={notice} /></>;
  async function logout() { try { await sync.signOut(); } catch (error) { setNotice(error.message); } }
  return <div className="shell">
    <aside id="primary-navigation" className={menuOpen ? "sidebar open" : "sidebar"}>
      <div className="brand"><span className="brand-mark small">课</span><span><strong>课堂管理</strong><small>{sync.configured ? "账号同步工作台" : "本地数据工作台"}</small></span></div>
      <nav>{NAV.map(([id, label, icon]) => <button key={id} className={page === id ? "active" : ""} aria-current={page === id ? "page" : undefined} onClick={() => { setPage(id); setMenuOpen(false); }}><span>{icon}</span>{label}</button>)}</nav>
      <div className="local-note"><strong>{sync.state.status}</strong><span>{sync.configured ? `最近同步：${formatTime(sync.state.lastSyncedAt)}` : sync.invalidConfig ? "配置不完整，已安全回退本地" : "设备内保存 · 手动 JSON 迁移"}</span></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><button className="menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="打开导航" aria-controls="primary-navigation" aria-expanded={menuOpen}>☰</button><div><p className="eyebrow">教师课堂管理系统 v{APP_VERSION}</p><h1>{title}</h1></div><div className="top-actions"><button className="search-launch" onClick={() => setSearchOpen(true)}>查找学生 <kbd>Ctrl K</kbd></button><span className={`privacy-pill sync-${sync.state.status === "已同步" ? "ok" : "notice"}`} role="status" aria-live="polite" title={`同步状态：${sync.state.status}`}><span aria-hidden="true">●</span><span className="status-full">{sync.state.status}</span><span className="status-compact">{compactSyncStatus(sync.state.status)}</span></span>{sync.configured && sync.state.status === "同步失败，可重试" && <button onClick={() => sync.retry()}>重试</button>}{sync.configured && <button onClick={logout}>退出</button>}</div></header>
      {updateReady && <aside className="update-banner" role="status" aria-live="polite"><strong>新版本已下载</strong><span>当前窗口不会强制刷新，本机数据保持不变。请先确认数据已保存，再关闭所有本系统窗口后重新打开。</span></aside>}
      <div className="page">
        {page === "dashboard" && <Dashboard data={data} setPage={setPage} cloudConfigured={sync.configured} />}
        {page === "workspace" && <Suspense fallback={<section className="panel"><p>正在打开课堂工作台…</p></section>}><ClassroomWorkspace data={data} commitData={commitData} syncStatus={sync.state.status} notify={setNotice} openPage={setPage} /></Suspense>}
        {page === "setup" && <Setup data={data} update={update} notify={setNotice} />}
        {page === "attendance" && <Attendance data={data} update={update} notify={setNotice} />}
        {page === "scores" && <Scores data={data} update={update} notify={setNotice} />}
        {page === "draw" && <QuickDraw data={data} update={update} notify={setNotice} />}
        {page === "reports" && <Reports data={data} />}
        {page === "backup" && <Suspense fallback={<section className="panel"><p>正在打开数据健康与恢复…</p></section>}><DataHealth data={data} replaceData={(next) => commitData(next, { atomic: true })} update={update} notify={setNotice} sync={sync} reopenOnboarding={() => setGuideOpen(true)} /></Suspense>}
      </div>
    </main>
    {menuOpen && <button className="nav-overlay" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    <Toast message={notice} />
    {searchOpen && <Suspense fallback={<div className="search-overlay"><section className="search-dialog" role="status">正在准备当前学期名单…</section></div>}><StudentSearch data={data} workspaceOfferingId={data.settings.workspaceContext.offeringId} close={() => setSearchOpen(false)} /></Suspense>}
  </div>;
}

function Dashboard({ data, setPage, cloudConfigured }) {
  const recentContext = recentWorkspaceOfferings(data)[0] ?? null;
  const activeSemesters = data.semesters.filter((item) => !item.archived);
  const activeSemester = recentContext?.semester ?? (activeSemesters.length === 1 ? activeSemesters[0] : null);
  const warnings = warningRows(data, activeSemester ? { semesterId: activeSemester.id } : {});
  const activeSemesterIds = new Set(activeSemesters.map((item) => item.id));
  const rosterEntryCount = data.semesterRosters.filter((item) => activeSemester ? item.semesterId === activeSemester.id : activeSemesterIds.has(item.semesterId)).reduce((sum, item) => sum + item.students.length, 0);
  const backupAge = data.settings.lastBackupAt ? Math.floor((Date.now() - new Date(data.settings.lastBackupAt).getTime()) / 86400000) : null;
  return <>
    <section className="hero-panel"><div><p className="eyebrow">今天 · {new Date().toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" })}</p><h2>{recentContext ? `继续 ${recentContext.classItem.name} · ${recentContext.course.name}` : "先进入课堂工作台"}</h2><p>一次选择班级课程，即可连续完成考勤、抽名、课堂表现和预警查看。{cloudConfigured ? "修改会先保存在本机，再核对云端版本后同步。" : "当前是本地模式，数据只保存在这个浏览器。"}</p></div><button className="primary" onClick={() => setPage("workspace")}>{recentContext ? "继续最近课堂" : "打开课堂工作台"}</button></section>
    <section className="metric-grid">
      <article><span>班级</span><strong>{data.classes.length}</strong><small>{rosterEntryCount} 名单人次</small></article>
      <article><span>课程</span><strong>{data.courses.length}</strong><small>{data.offerings.length} 个班级课程</small></article>
      <article><span>考勤表</span><strong>{data.attendanceSessions.length}</strong><small>按节统计7种状态</small></article>
      <article className={warnings.length ? "warning-card" : ""}><span>预警</span><strong>{warnings.length}</strong><small>缺勤 / 迟到 / 早退</small></article>
    </section>
    <section className="two-column"><article className="panel"><div className="section-heading"><div><p className="eyebrow">当前状态</p><h2>使用中学期</h2></div></div>{activeSemester ? <div className="semester-overview"><strong>{activeSemester.name}</strong><p>{data.offerings.filter((item) => item.semesterId === activeSemester.id).length} 个班级课程组合正在使用</p></div> : activeSemesters.length > 1 ? <Empty text="有多个使用中学期，请先在课堂工作台明确选择当前班级课程" /> : <Empty text="尚未创建在用学期" />}</article>
      <article className="panel"><div className="section-heading"><div><p className="eyebrow">数据安全</p><h2>备份提醒</h2></div></div><p>{backupAge === null ? "还没有独立 JSON 备份。" : `最近一次完整备份是 ${backupAge} 天前。`}</p><button onClick={() => setPage("backup")}>立即备份</button></article></section>
  </>;
}

function Empty({ text }) { return <div className="empty">{text}</div>; }
function FieldSelect({ label, value, onChange, options, placeholder = "请选择" }) { return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{placeholder}</option>{options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>; }

function Setup({ data, update, notify }) {
  const [classId, setClassId] = useState(data.classes[0]?.id ?? "");
  const [semesterId, setSemesterId] = useState(data.semesters.find((item) => !item.archived)?.id ?? data.semesters[0]?.id ?? "");
  const [courseId, setCourseId] = useState(data.courses[0]?.id ?? "");
  const [paste, setPaste] = useState("");
  const [preview, setPreview] = useState(null);
  const classItem = classById(data, classId);
  const roster = rosterFor(data, semesterId, classId);
  const rosterStudents = roster?.students ?? [];

  function addNamed(kind) {
    const label = kind === "semester" ? "学期" : kind === "class" ? "班级" : "课程";
    const name = prompt(`请输入${label}名称`);
    if (!name?.trim()) return;
    update((next) => {
      if (kind === "semester") { const item = { id: makeId("sem"), name: name.trim(), archived: false }; next.semesters.push(item); setSemesterId(item.id); }
      if (kind === "class") { const item = { id: makeId("class"), name: name.trim() }; next.classes.push(item); if (semesterId) { assertWritableSemester(next, semesterId); next.semesterRosters.push({ id: makeId("roster"), semesterId, classId: item.id, students: [] }); } setClassId(item.id); }
      if (kind === "course") { const item = { id: makeId("course"), name: name.trim() }; next.courses.push(item); setCourseId(item.id); }
    }, `${label}已创建`);
  }

  function previewText(text = paste) { if (isArchived(data, semesterId)) return notify("归档学期名单只读"); const result = parseRosterText(text); const existingErrors = validateRoster(result.students, rosterStudents); setPreview({ ...result, errors: [...result.errors, ...existingErrors] }); }
  async function readRosterFile(file) {
    if (!file) return;
    try {
      let rows;
      if (/\.csv$/i.test(file.name)) rows = parseRosterText(await file.text());
      else {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
        const header = matrix[0].map(String);
        const noIndex = header.findIndex((value) => /学号|student\s*no/i.test(value));
        const nameIndex = header.findIndex((value) => /姓名|name/i.test(value));
        if (nameIndex < 0) throw new Error("无法识别“姓名”列；学号列可以省略");
        rows = { students: matrix.slice(1).filter((row) => (noIndex >= 0 && row[noIndex]) || row[nameIndex]).map((row) => ({ id: makeId("stu"), studentNo: noIndex >= 0 ? String(row[noIndex] ?? "").trim() : "", name: String(row[nameIndex] ?? "").trim() })), errors: [] };
      }
      if (isArchived(data, semesterId)) throw new Error("归档学期名单只读");
      const errors = [...rows.errors, ...validateRoster(rows.students, rosterStudents)];
      setPreview({ ...rows, errors });
    } catch (error) { notify(error.message); }
  }
  function confirmPreview() {
    if (!classItem || !preview || preview.errors.length) return;
    update((next) => addRosterStudents(next, { semesterId, classId, students: preview.students }), `已导入 ${preview.students.length} 名学生，并为每人建立独立教学档案`);
    setPreview(null); setPaste("");
  }
  function addStudent() {
    const studentNo = prompt("请输入学号（可留空；填写时按文本保存）"); if (studentNo === null) return;
    const name = prompt("请输入姓名"); if (!name) return;
    const student = { id: makeId("stu"), studentNo: String(studentNo).trim(), name: name.trim() };
    if (!roster) return notify("尚未建立名单：请先选择学期并添加班级课程");
    const errors = validateRoster([student], rosterStudents); if (errors.length) return notify(errors[0]);
    update((next) => addRosterStudents(next, { semesterId, classId, students: [student] }), "学生已新增，并建立独立教学档案");
  }
  function editStudent(student) {
    const studentNo = prompt("修改学号（可留空）", student.studentNo); if (studentNo === null) return;
    const name = prompt("修改姓名", student.name); if (name === null) return;
    const changed = { ...student, studentNo: String(studentNo).trim(), name: name.trim() };
    const errors = validateRoster([changed], rosterStudents, student.id); if (errors.length) return notify(errors[0]);
    update((next) => { assertWritableSemester(next, semesterId); Object.assign(rosterFor(next, semesterId, classId).students.find((item) => item.id === student.id), changed); }, "学生信息已修改");
  }
  function archiveSemester(item) {
    if (!confirm(`归档后“${item.name}”将只读，是否继续？`) || !confirm("再次确认：归档后不能直接修改历史记录。")) return;
    update((next) => { next.semesters.find((semester) => semester.id === item.id).archived = true; }, "学期已归档");
  }
  function cloneSemester(item) {
    const name = prompt("新学期名称", `${item.name}（复用）`); if (!name) return;
    update((next) => {
      const semester = { id: makeId("sem"), name: name.trim(), archived: false };
      next.semesters.push(semester);
      const idMap = new Map();
      next.semesterRosters.filter((rosterItem) => rosterItem.semesterId === item.id).forEach((rosterItem) => {
        const students = rosterItem.students.map((student) => { const copy = { ...student, id: makeId("stu") }; idMap.set(student.id, copy.id); return copy; });
        next.semesterRosters.push({ id: makeId("roster"), semesterId: semester.id, classId: rosterItem.classId, students });
      });
      next.offerings.filter((offering) => offering.semesterId === item.id).forEach((offering) => next.offerings.push({ ...offering, id: makeId("off"), semesterId: semester.id, scoreConfig: { ...scoreConfigFor(offering), components: scoreConfigFor(offering).components.map((component) => ({ ...component })), attendanceRules: { ...scoreConfigFor(offering).attendanceRules }, overrides: {} } }));
      setSemesterId(semester.id);
    }, "已复用班级名单和课程结构，未复制历史记录");
  }
  function mountCourse() {
    if (!semesterId || !classId || !courseId) return notify("请完整选择学期、班级和课程");
    if (isArchived(data, semesterId)) return notify("归档学期只读");
    if (data.offerings.some((item) => item.semesterId === semesterId && item.classId === classId && item.courseId === courseId)) return notify("这个班级课程已经存在，数据未重复添加");
    update((next) => { assertWritableSemester(next, semesterId); if (!rosterFor(next, semesterId, classId)) next.semesterRosters.push({ id: makeId("roster"), semesterId, classId, students: [] }); next.offerings.push({ id: makeId("off"), semesterId, classId, courseId, scoreConfig: createDefaultScoreConfig() }); }, "班级课程已添加");
  }
  return <>
    <section className="toolbar-panel"><div><p className="eyebrow">基础结构</p><h2>学期、班级与课程</h2></div><div className="button-row"><button onClick={() => addNamed("semester")}>＋ 学期</button><button onClick={() => addNamed("class")}>＋ 班级</button><button onClick={() => addNamed("course")}>＋ 课程</button></div></section>
    <section className="panel"><div className="section-heading"><h2>学期管理</h2></div><div className="card-list">{data.semesters.map((item) => <article key={item.id} className="mini-card"><div><strong>{item.name}</strong><span className={item.archived ? "tag gray" : "tag"}>{item.archived ? "已归档 · 只读" : "使用中"}</span></div><div className="button-row"><button onClick={() => cloneSemester(item)}>复用结构</button>{!item.archived && <button className="danger-text" onClick={() => archiveSemester(item)}>归档</button>}</div></article>)}</div></section>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">班级课程</p><h2>班级共用一份名单，课程分别记录</h2></div></div><div className="form-grid three"><FieldSelect label="学期" value={semesterId} onChange={setSemesterId} options={data.semesters} /><FieldSelect label="班级" value={classId} onChange={setClassId} options={data.classes} /><FieldSelect label="课程" value={courseId} onChange={setCourseId} options={data.courses} /></div><button className="primary" onClick={mountCourse}>添加班级课程</button><div className="chip-list">{data.offerings.filter((item) => !semesterId || item.semesterId === semesterId).map((item) => <span key={item.id}>{offeringLabel(data, item)}</span>)}</div></section>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">名单维护</p><h2>{classItem?.name ?? "请先创建班级"}</h2><span className="privacy-badge">请勿投屏 · 含学生名单</span></div><div className="button-row"><button onClick={addStudent} disabled={!classItem}>手动新增学生</button><label className="file-button">导入 Excel / CSV<input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => readRosterFile(event.target.files[0])} disabled={!classItem} /></label></div></div>
      <div className="form-grid two"><label>批量粘贴（姓名必填，学号可选）<textarea rows="6" placeholder={'姓名\n虚构学生甲\n虚构学生乙'} value={paste} onChange={(event) => setPaste(event.target.value)} /></label><div className="import-help"><strong>导入规则</strong><p>可以只提供“姓名”一列；如填写学号，将按文本保留前导零，且同班级内不能重复。确认预览后才写入。</p><button onClick={() => previewText()} disabled={!classItem || !paste.trim()}>解析并预览</button></div></div>
      {preview && <div className="preview-box"><div className="section-heading"><h3>导入预览 · {preview.students.length} 人</h3><button className="primary" disabled={preview.errors.length > 0} onClick={confirmPreview}>确认写入</button></div>{preview.errors.length > 0 && <ul className="error-list">{preview.errors.map((error) => <li key={error}>{error}</li>)}</ul>}<div className="table-scroll"><table><thead><tr><th>学号（可选）</th><th>姓名</th></tr></thead><tbody>{preview.students.slice(0, 12).map((student) => <tr key={student.id}><td>{student.studentNo || "—"}</td><td>{student.name}</td></tr>)}</tbody></table></div></div>}
      {roster ? <div className="table-scroll"><table><thead><tr><th>#</th><th>学号（可选）</th><th>姓名</th><th>操作</th></tr></thead><tbody>{rosterStudents.map((student, index) => <tr key={student.id}><td>{index + 1}</td><td>{student.studentNo || "—"}</td><td>{student.name}</td><td><button onClick={() => editStudent(student)} disabled={isArchived(data, semesterId)}>修改</button><button className="danger-text" disabled={isArchived(data, semesterId)} onClick={() => { if (!confirm(`删除 ${student.name}？已有历史引用时系统会阻止删除。`) || !confirm("再次确认删除无历史引用的该学生？")) return; try { update((next) => deleteStudentSafely(next, { semesterId, classId, studentId: student.id }), "学生已删除"); } catch (error) { notify(error.message); } }}>删除</button></td></tr>)}</tbody></table></div> : <Empty text="添加班级课程后即可建立本学期名单" />}
    </section>
  </>;
}

function OfferingPicker({ data, value, onChange, includeArchived = false }) {
  const items = data.offerings.filter((item) => includeArchived || !isArchived(data, item.semesterId));
  return <label>学期 / 班级 / 课程<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">请选择班级课程</option>{items.map((item) => <option value={item.id} key={item.id}>{offeringLabel(data, item)}</option>)}</select></label>;
}

function Attendance({ data, update, notify }) {
  const [offeringId, setOfferingId] = useState(data.offerings.find((item) => !isArchived(data, item.semesterId))?.id ?? "");
  const [date, setDate] = useState(todayText());
  const [sections, setSections] = useState(data.settings.defaultSections);
  const [draft, setDraft] = useState(null);
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  const offering = data.offerings.find((item) => item.id === offeringId);
  const classItem = classById(data, offering?.classId);
  const rosterStudents = studentsFor(data, offering);
  const sessions = data.attendanceSessions.filter((item) => !offering || (item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId)).sort((a, b) => b.date.localeCompare(a.date));
  function create() {
    if (!offering || !rosterStudents.length) return notify("无法生成考勤：请先选择已有学生的班级课程");
    if (isArchived(data, offering.semesterId)) return notify("归档学期只读");
    setDraft(createAttendanceSession({ semesterId: offering.semesterId, classId: offering.classId, courseId: offering.courseId, date, sectionCount: sections, students: rosterStudents }));
  }
  function change(studentId, sectionIndex, key, value) {
    setDraft((current) => { const next = structuredClone(current); next.records[studentId][sectionIndex][key] = value; if (key === "status" && value !== "其他") next.records[studentId][sectionIndex].note = ""; return next; });
  }
  function save() {
    if (isArchived(data, draft.semesterId)) return notify("归档学期只读，不能保存考勤");
    const errors = validateAttendanceSession(draft); if (errors.length) return notify(errors[0]);
    update((next) => { assertWritableSemester(next, draft.semesterId); const index = next.attendanceSessions.findIndex((item) => item.id === draft.id); if (index >= 0) next.attendanceSessions[index] = draft; else next.attendanceSessions.push(draft); }, "考勤表已保存");
  }
  function allPresent() { setDraft((current) => { const next = structuredClone(current); Object.values(next.records).forEach((records) => records.forEach((record) => Object.assign(record, { status: "出勤", note: "" }))); return next; }); }
  const visibleStudents = rosterStudents.filter((student) => !abnormalOnly || draft?.records[student.id]?.some((record) => record.status !== "出勤"));
  return <>
    <section className="toolbar-panel"><div><p className="eyebrow">按节记录</p><h2>新建或继续考勤</h2></div><button className="primary" onClick={create}>生成考勤表</button></section>
    <section className="panel"><div className="form-grid three"><OfferingPicker data={data} value={offeringId} onChange={(value) => { setOfferingId(value); setDraft(null); }} includeArchived /><label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label>本次课节数<input type="number" min="1" max="12" value={sections} onChange={(event) => setSections(Number(event.target.value))} /></label></div></section>
    {draft && <section className="panel attendance-editor"><div className="section-heading"><div><p className="eyebrow">{draft.date} · {draft.sectionCount}节</p><h2>{classItem.name}{isArchived(data, draft.semesterId) ? "（归档只读）" : ""}</h2></div><div className="button-row"><button onClick={allPresent} disabled={isArchived(data, draft.semesterId)}>一键全勤</button><button className={abnormalOnly ? "active-filter" : ""} onClick={() => setAbnormalOnly(!abnormalOnly)}>只看异常</button><button className="primary" onClick={save} disabled={isArchived(data, draft.semesterId)}>保存考勤</button></div></div><div className="table-scroll"><table><thead><tr><th>学生</th>{Array.from({ length: draft.sectionCount }, (_, index) => <th key={index}>第{index + 1}节</th>)}</tr></thead><tbody>{visibleStudents.map((student) => <tr key={student.id}><td><strong>{student.name}</strong><small>{student.studentNo || "未填写学号"}</small></td>{draft.records[student.id].map((record, index) => <td key={index}><select aria-label={`${student.name}第${index + 1}节考勤状态`} disabled={isArchived(data, draft.semesterId)} className={`status-${record.status}`} value={record.status} onChange={(event) => change(student.id, index, "status", event.target.value)}>{ATTENDANCE_STATUSES.map((status) => <option key={status}>{status}</option>)}</select>{record.status === "其他" && <input aria-label={`${student.name}第${index + 1}节其他状态备注`} disabled={isArchived(data, draft.semesterId)} className="note-input" placeholder="必填备注" value={record.note} onChange={(event) => change(student.id, index, "note", event.target.value)} />}</td>)}</tr>)}</tbody></table></div></section>}
    <section className="panel"><div className="section-heading"><h2>历史考勤表</h2></div>{sessions.length ? <div className="card-list">{sessions.slice(0, 20).map((session) => <article className="mini-card" key={session.id}><div><strong>{session.date} · {session.sectionCount}节</strong><span>{classById(data, session.classId)?.name} / {courseById(data, session.courseId)?.name}</span></div><button onClick={() => { setOfferingId(data.offerings.find((item) => item.semesterId === session.semesterId && item.classId === session.classId && item.courseId === session.courseId)?.id ?? ""); setDraft(structuredClone(session)); }}>查看{isArchived(data, session.semesterId) ? "（只读）" : " / 编辑"}</button></article>)}</div> : <Empty text="尚无考勤记录" />}</section>
  </>;
}

function Scores({ data, update, notify }) {
  const [offeringId, setOfferingId] = useState(data.offerings.find((item) => !isArchived(data, item.semesterId))?.id ?? "");
  const [studentId, setStudentId] = useState("");
  const [delta, setDelta] = useState(2);
  const [reason, setReason] = useState("回答问题表现好");
  const offering = data.offerings.find((item) => item.id === offeringId);
  const rosterStudents = studentsFor(data, offering);
  const config = scoreConfigFor(offering);
  const selectedScores = offering && studentId ? studentScores(data, { ...offering, studentId }) : null;
  useEffect(() => { if (!rosterStudents.some((item) => item.id === studentId)) setStudentId(rosterStudents[0]?.id ?? ""); }, [offeringId, data.semesterRosters.length, studentId]);
  function editComponent(component) {
    if (!offering) return;
    const name = prompt("成绩项名称", component.name); if (name === null) return;
    const weight = prompt("权重（系统按全部权重归一化）", component.weight); if (weight === null) return;
    const defaultScore = prompt("学生初始分（0—100）", component.defaultScore); if (defaultScore === null) return;
    update((next) => updateScoreComponent(next, { offeringId: offering.id, componentId: component.id, name, weight, defaultScore }), "成绩项设置已更新");
  }
  function addComponent() {
    if (!offering) return notify("请先选择班级课程");
    const name = prompt("新增成绩项名称（例如：课堂练习）"); if (!name?.trim()) return;
    const weight = prompt("权重", "10"); if (weight === null) return;
    const defaultScore = prompt("学生初始分（0—100）", "70"); if (defaultScore === null) return;
    update((next) => addScoreComponent(next, { offeringId: offering.id, name, weight, defaultScore }), "自定义成绩项已新增");
  }
  function removeComponent(component) {
    if (!offering) return;
    if (!confirm(`删除成绩项“${component.name}”？已有历史记录时系统会阻止删除。`) || !confirm("再次确认删除该成绩项？")) return;
    update((next) => deleteScoreComponent(next, { offeringId: offering.id, componentId: component.id }), "成绩项已删除");
  }
  function addEvent() {
    if (!offering || !studentId || !reason.trim()) return notify("学生、非零分值和事由均为必填");
    let validDelta; try { assertWritableSemester(data, offering.semesterId); validDelta = assertValidEventDelta(data, offering, delta); } catch (error) { return notify(error.message); }
    update((next) => { assertWritableSemester(next, offering.semesterId); next.performanceEvents.push({ semesterId: offering.semesterId, classId: offering.classId, courseId: offering.courseId, studentId, delta: validDelta, reason: reason.trim(), time: new Date().toISOString(), revokedAt: null, id: makeId("event") }); }, "课堂表现事件已记录");
  }
  const events = data.performanceEvents.filter((item) => !offering || (item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId)).sort((a, b) => b.time.localeCompare(a.time));
  return <>
    <section className="toolbar-panel"><div><p className="eyebrow">个性化平时分</p><h2>每个学期、班级、课程独立配置</h2></div><div className="button-row"><span className="privacy-pill">默认初始分 70 · 考勤自动计分</span><span className="privacy-badge">请勿投屏 · 含学生成绩</span></div></section>
    <section className="panel"><OfferingPicker data={data} value={offeringId} onChange={setOfferingId} />{offering && <><div className="section-heading score-config-heading"><div><h2>成绩项与权重</h2><p>最终成绩按当前全部权重归一化计算；权重可随时修改。</p></div><button onClick={addComponent} disabled={isArchived(data, offering.semesterId)}>＋ 自定义成绩项</button></div><div className="card-list">{config.components.map((component) => <article className="mini-card" key={component.id}><div><strong>{component.name}</strong><span>{component.kind === "attendance" ? "考勤自动计分" : component.kind === "performance" ? "课堂事件自动加减" : "教师手动评分"} · 权重 {component.weight} · 初始分 {component.defaultScore}</span></div><div className="button-row"><button onClick={() => editComponent(component)} disabled={isArchived(data, offering.semesterId)}>修改</button>{component.kind !== "attendance" && <button className="danger-text" onClick={() => removeComponent(component)} disabled={isArchived(data, offering.semesterId)}>删除</button>}</div></article>)}</div><div className="student-total">当前权重合计 <strong>{config.components.reduce((sum, item) => sum + Number(item.weight), 0)}</strong><span>（系统自动归一化）</span></div><div className="section-heading score-config-heading"><div><h2>考勤自动计分规则</h2><p>每出现一次对应状态，就在该学生的考勤初始分上自动加减。</p></div></div><div className="score-rules">{ATTENDANCE_STATUSES.map((status) => <label key={`${offering.id}-${status}`}>{status}<input type="number" min="-100" max="100" defaultValue={config.attendanceRules[status]} disabled={isArchived(data, offering.semesterId)} onBlur={(event) => update((next) => setAttendanceScoreRule(next, { offeringId: offering.id, status, value: event.target.value }), `${status}计分规则已更新`)} /></label>)}</div></>}</section>
    {offering && <section className="panel"><div className="section-heading"><div><p className="eyebrow">学生初始分与实时结果</p><h2>姓名是唯一必填项</h2></div></div><div className="table-scroll"><table className="score-table"><thead><tr><th>学生</th>{config.components.map((component) => <th key={component.id}>{component.name}<small>初始分 → 当前分</small></th>)}<th>加权总分</th></tr></thead><tbody>{rosterStudents.map((student) => { const scores = studentScores(data, { ...offering, studentId: student.id }); return <tr key={student.id}><td><strong>{student.name}</strong><small>{student.studentNo || "未填写学号"}</small></td>{scores.components.map((component) => <td key={component.id}><input key={`${student.id}-${component.id}-${component.base}`} type="number" min="0" max="100" defaultValue={component.base} disabled={isArchived(data, offering.semesterId)} aria-label={`${student.name}${component.name}初始分`} onBlur={(event) => update((next) => setStudentBaseScore(next, { offeringId: offering.id, studentId: student.id, componentId: component.id, value: event.target.value }), `${student.name}的${component.name}初始分已更新`)} /><small>→ {component.score}{component.adjustment ? `（自动${component.adjustment > 0 ? "+" : ""}${component.adjustment}）` : ""}</small></td>)}<td><strong>{scores.总分}</strong></td></tr>; })}</tbody></table></div></section>}
    <section className="two-column"><article className="panel"><div className="section-heading"><div><p className="eyebrow">课堂实时事件</p><h2>记录带事由的加减分</h2></div></div>{config.components.some((item) => item.kind === "performance") ? <><label>学生<select value={studentId} onChange={(event) => setStudentId(event.target.value)}>{rosterStudents.map((student) => <option key={student.id} value={student.id}>{student.name}{student.studentNo ? ` · ${student.studentNo}` : ""}</option>)}</select></label><div className="form-grid two"><label>分值（正或负）<input type="number" value={delta} onChange={(event) => setDelta(Number(event.target.value))} /></label><label>事由<input value={reason} onChange={(event) => setReason(event.target.value)} /></label></div><button className="primary" onClick={addEvent}>保存课堂表现</button>{selectedScores && <div className="student-total">当前加权总分 <strong>{selectedScores.总分}</strong></div>}</> : <Empty text="当前班级课程未启用课堂表现项" />}</article><article className="panel"><div className="section-heading"><div><p className="eyebrow">计分说明</p><h2>规则清楚，可随时调整</h2></div></div><p>每名学生先使用各成绩项的初始分。考勤按状态自动加减；课堂表现事件自动累计；教师可直接修改任意学生的初始分。</p><p>病假、事假默认不扣分，教师可在上方规则中按课程实际情况修改。</p></article></section>
    <section className="panel"><div className="section-heading"><h2>课堂表现事件明细</h2></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>学生</th><th>分值</th><th>事由</th><th>状态 / 操作</th></tr></thead><tbody>{events.map((event) => { const student = studentsFor(data, event).find((item) => item.id === event.studentId); return <tr key={event.id} className={event.revokedAt ? "revoked" : ""}><td>{formatTime(event.time)}</td><td>{student?.name}</td><td className={event.delta > 0 ? "positive" : "negative"}>{event.delta > 0 ? "+" : ""}{event.delta}</td><td>{event.reason}</td><td>{event.revokedAt ? "已撤销" : <><button onClick={() => { if (isArchived(data, event.semesterId)) return notify("归档学期只读"); const nextDelta = prompt("修改分值", event.delta); const nextReason = prompt("修改事由", event.reason); if (nextDelta === null || !nextReason?.trim()) return; let validDelta; try { validDelta = assertValidEventDelta(data, event, nextDelta); } catch (error) { return notify(error.message); } update((next) => { assertWritableSemester(next, event.semesterId); Object.assign(next.performanceEvents.find((item) => item.id === event.id), { delta: validDelta, reason: nextReason.trim(), modifiedAt: new Date().toISOString() }); }, "事件已修改"); }}>修改</button><button className="danger-text" onClick={() => { if (isArchived(data, event.semesterId)) return notify("归档学期只读"); if (confirm("撤销该事件？原记录会保留并标记为已撤销。")) update((next) => { assertWritableSemester(next, event.semesterId); next.performanceEvents.find((item) => item.id === event.id).revokedAt = new Date().toISOString(); }, "事件已撤销"); }}>撤销</button></>}</td></tr>; })}</tbody></table></div></section>
  </>;
}

function QuickDraw({ data, update, notify }) {
  const [offeringId, setOfferingId] = useState(data.offerings.find((item) => !isArchived(data, item.semesterId))?.id ?? "");
  const [mode, setMode] = useState("pure");
  const [excluded, setExcluded] = useState([]);
  const [result, setResult] = useState(null);
  const offering = data.offerings.find((item) => item.id === offeringId);
  const classItem = classById(data, offering?.classId);
  const rosterStudents = studentsFor(data, offering);
  const performanceEnabled = scoreConfigFor(offering).components.some((item) => item.kind === "performance");
  const history = data.drawHistory.filter((item) => !offering || (item.classId === offering.classId && item.courseId === offering.courseId && item.semesterId === offering.semesterId));
  const counts = history.reduce((map, item) => ({ ...map, [item.studentId]: (map[item.studentId] ?? 0) + 1 }), {});
  useEffect(() => {
    if (!offering) return;
    const todaySessions = data.attendanceSessions.filter((item) => item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId && item.date === todayText());
    const notParticipating = new Set();
    todaySessions.forEach((session) => Object.entries(session.records).forEach(([studentId, records]) => { if (records.some((record) => ["缺勤", "病假", "事假"].includes(record.status))) notParticipating.add(studentId); }));
    setExcluded([...notParticipating]);
  }, [offeringId]);
  function draw() {
    try {
      assertWritableSemester(data, offering.semesterId);
      const student = drawStudent(rosterStudents, { mode, excludedIds: excluded, counts });
      setResult(student);
      update((next) => { assertWritableSemester(next, offering.semesterId); next.drawHistory.push({ semesterId: offering.semesterId, classId: offering.classId, courseId: offering.courseId, studentId: student.id, time: new Date().toISOString(), mode, id: makeId("draw") }); }, `抽中：${student.name}`);
    } catch (error) { notify(error.message); }
  }
  return <><section className="toolbar-panel"><div><p className="eyebrow">主系统内置</p><h2>快速抽名与课堂加分</h2></div><span className="tag">默认纯随机 · 排除今日缺勤 / 病假 / 事假</span></section><section className="panel"><div className="form-grid two"><OfferingPicker data={data} value={offeringId} onChange={setOfferingId} /><label>抽名模式<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="pure">纯随机</option><option value="weighted">加权随机（均衡覆盖）</option></select></label></div><div className="draw-stage"><p>{result ? "本次抽中" : "准备抽名"}</p><strong>{result?.name ?? "—"}</strong><span>{result ? (result.studentNo || "未填写学号") : "选择班级课程后开始"}</span><button className="primary jumbo" onClick={draw} disabled={!rosterStudents.length}>抽一名学生</button></div>{result && performanceEnabled && <div className="quick-score"><span>记录课堂表现：</span>{[-1, 1, 2].map((delta) => <button key={delta} onClick={() => { const reason = prompt("请输入事由", delta > 0 ? "回答问题" : "课堂表现需改进"); if (reason?.trim()) update((next) => { assertWritableSemester(next, offering.semesterId); const validDelta = assertValidEventDelta(next, offering, delta); next.performanceEvents.push({ semesterId: offering.semesterId, classId: offering.classId, courseId: offering.courseId, studentId: result.id, delta: validDelta, reason: reason.trim(), time: new Date().toISOString(), revokedAt: null, id: makeId("event") }); }, "课堂表现已保存"); }}>{delta > 0 ? "+" : ""}{delta}</button>)}</div>}<details><summary>本次排除学生（{excluded.length}）</summary><div className="student-checks">{rosterStudents.map((student) => <label key={student.id}><input type="checkbox" checked={excluded.includes(student.id)} onChange={() => setExcluded((current) => current.includes(student.id) ? current.filter((id) => id !== student.id) : [...current, student.id])} />{student.name}</label>)}</div></details></section></>;
}

function buildReport(data, type, offering, studentId) {
  if (!offering) return { title: "请选择班级课程", headers: [], rows: [] };
  const classItem = classById(data, offering.classId); const course = courseById(data, offering.courseId); const stats = attendanceStats(data, offering);
  if (type === "warnings") {
    const rows = warningRows(data, offering).map((item) => [item.student.studentNo, item.student.name, item.classItem.name, item.course.name, item.reason, item.records.map((record) => `${record.date} 第${record.section}节`).join("；")]);
    return { title: "异常预警", headers: ["学号", "姓名", "班级", "课程", "触发原因", "相关记录"], rows };
  }
  if (type === "course") {
    const offerings = data.offerings.filter((item) => item.semesterId === offering.semesterId && item.courseId === offering.courseId);
    const componentNames = [...new Set(offerings.flatMap((item) => scoreConfigFor(item).components.map((component) => component.name)))];
    const rows = offerings.flatMap((current) => { const currentClass = classById(data, current.classId); const currentStats = attendanceStats(data, current); return studentsFor(data, current).map((student) => { const counts = currentStats[student.id] ?? {}; const scores = studentScores(data, { ...current, studentId: student.id }); return [currentClass.name, student.studentNo, student.name, ...ATTENDANCE_STATUSES.map((status) => counts[status] ?? 0), ...componentNames.map((name) => scores.components.find((component) => component.name === name)?.score ?? "—"), scores.总分]; }); });
    return { title: `${course.name} · 跨班级汇总`, headers: ["班级", "学号", "姓名", ...ATTENDANCE_STATUSES, ...componentNames, "加权总分"], rows };
  }
  const reportStudents = studentsFor(data, offering);
  const componentNames = scoreConfigFor(offering).components.map((component) => component.name);
  const baseRows = reportStudents.map((student) => { const counts = stats[student.id] ?? {}; const scores = studentScores(data, { ...offering, studentId: student.id }); return { student, row: [student.studentNo, student.name, ...ATTENDANCE_STATUSES.map((status) => counts[status] ?? 0), ...scores.components.map((component) => component.score), scores.总分] }; });
  if (type === "student") {
    const student = reportStudents.find((item) => item.id === studentId) ?? reportStudents[0];
    const row = baseRows.find((item) => item.student.id === student?.id)?.row;
    const attendanceRows = data.attendanceSessions.filter((item) => item.semesterId === offering.semesterId && item.classId === offering.classId && item.courseId === offering.courseId).flatMap((session) => (session.records[student?.id] ?? []).map((record, index) => [session.date, `第${index + 1}节`, record.status, record.note || "—"]));
    const events = data.performanceEvents.filter((item) => item.studentId === student?.id && item.semesterId === offering.semesterId && item.courseId === offering.courseId && !item.revokedAt).map((item) => [formatTime(item.time), item.delta, item.reason]);
    return { title: `${student?.name ?? "学生"} · 个人明细`, headers: ["学号", "姓名", ...ATTENDANCE_STATUSES, ...componentNames, "加权总分"], rows: row ? [row] : [], extras: [{ title: "考勤明细", headers: ["日期", "节次", "状态", "备注"], rows: attendanceRows }, { title: "课堂表现事件", headers: ["事件时间", "分值", "事由"], rows: events }] };
  }
  const sorted = baseRows.map((item) => item.row).sort((a, b) => Number(b.at(-1)) - Number(a.at(-1))).map((row, index) => [...row, index + 1]);
  return { title: `${classItem.name} · ${course.name}汇总`, headers: ["学号", "姓名", ...ATTENDANCE_STATUSES, ...componentNames, "加权总分", "排名"], rows: sorted };
}

function Reports({ data }) {
  const [offeringId, setOfferingId] = useState(data.offerings[0]?.id ?? "");
  const [type, setType] = useState("class");
  const [studentId, setStudentId] = useState("");
  const reportRef = useRef(null);
  const offering = data.offerings.find((item) => item.id === offeringId);
  const classItem = classById(data, offering?.classId);
  const reportStudents = studentsFor(data, offering);
  const report = useMemo(() => buildReport(data, type, offering, studentId), [data, type, offeringId, studentId]);
  async function exportPdf() {
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(reportRef.current, { scale: 1.5, backgroundColor: "#ffffff" });
    await exportCanvasAsPdf(canvas, `${report.title}.pdf`);
  }
  async function exportExcel() {
    const XLSX = await import("xlsx");
    const extraRows = (report.extras ?? []).flatMap((section) => [[], [section.title], section.headers, ...section.rows]);
    const sheet = XLSX.utils.aoa_to_sheet([[report.title], report.headers, ...report.rows, ...extraRows]);
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, "报表"); XLSX.writeFile(workbook, `${report.title}.xlsx`);
  }
  return <><section className="toolbar-panel"><div><p className="eyebrow">分状态独立统计</p><h2>各状态次数、个性化平时分与预警</h2></div><div className="button-row"><span className="privacy-badge">请勿投屏 · 含学生信息</span><button onClick={exportExcel}>导出 Excel</button><button onClick={exportPdf}>导出 PDF</button><button onClick={() => window.print()}>打印</button></div></section><section className="panel no-print"><div className="form-grid three"><OfferingPicker data={data} value={offeringId} onChange={setOfferingId} includeArchived /><label>报表类型<select value={type} onChange={(event) => setType(event.target.value)}><option value="student">单个学生明细</option><option value="class">班级课程汇总</option><option value="course">课程跨班级汇总</option><option value="warnings">异常预警</option></select></label>{type === "student" && <label>学生<select value={studentId} onChange={(event) => setStudentId(event.target.value)}>{reportStudents.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>}</div><p className="privacy-warning">导出文件含学生信息，请仅保存在受保护设备，并避免发送给无关人员。</p></section><section className="report-sheet" ref={reportRef}><div className="report-heading"><span>教师课堂管理系统</span><h2>{report.title}</h2><p>生成时间：{formatTime(new Date().toISOString())}</p></div><div className="table-scroll"><table><thead><tr>{report.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{report.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>{(report.extras ?? []).map((section) => <section key={section.title}><h3>{section.title}</h3><div className="table-scroll"><table><thead><tr>{section.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{section.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div></section>)}</section></>;
}

createRoot(document.getElementById("root")).render(<App />);

if (import.meta.env.PROD && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    const announceWaiting = () => window.dispatchEvent(new Event("workbuddy:pwa-update-ready"));
    if (registration.waiting) announceWaiting();
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) announceWaiting();
      });
    });
  }).catch(() => {}));
}
