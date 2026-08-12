import React, { useEffect, useState } from "react";
import { createFictionalDataset, exportDatabase, importDatabaseSafely } from "./core.mjs";
import { classifySyncIssue, summarizeHistoryRecord } from "./data-health-core.mjs";

function todayText() { return new Date().toISOString().slice(0, 10); }
function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function Empty({ text }) { return <div className="empty">{text}</div>; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

export default function DataHealth({ data, replaceData, update, notify, sync, reopenOnboarding }) {
  const [pending, setPending] = useState(null);
  const safetyBackups = sync.safetyBackups?.() ?? [];
  const syncIssue = classifySyncIssue({ status: sync.state.status, error: sync.state.error, online: navigator.onLine });
  const canRetry = sync.configured && ["network", "service", "failed"].includes(syncIssue.code);
  useEffect(() => {
    if (!sync.configured || !sync.session?.user?.id) return;
    void sync.loadHistory().catch(() => {});
  }, [sync.configured, sync.loadHistory, sync.session?.user?.id]);

  function exportJson() {
    const next = structuredClone(data);
    next.settings.lastBackupAt = new Date().toISOString();
    replaceData(next);
    downloadBlob(new Blob([exportDatabase(next)], { type: "application/json;charset=utf-8" }), `课堂管理完整备份-${todayText()}.json`);
    sync.markBackup();
    notify("当前本机版本已导出；恢复云端历史前置条件已满足");
  }
  async function selectBackup(file) {
    if (!file) return;
    const result = importDatabaseSafely(await file.text(), data);
    if (!result.ok) { setPending(null); return notify(`导入失败：${result.error}。当前数据未改动。`); }
    setPending(result.data); notify("文件校验通过，尚未替换当前数据");
  }
  function restore() {
    if (!pending) return;
    if (!confirm("导入会完整替换当前数据，不会自动合并。是否继续？") || !confirm("再次确认：请确保已导出当前版本，确定替换整库？")) return;
    try { replaceData(pending); setPending(null); notify(sync.configured ? "整库已保存在本机并进入受保护同步" : "整库恢复成功"); }
    catch (error) { notify(`恢复失败：${error.message}。原数据未改动。`); }
  }
  function exportSafety(item) {
    downloadBlob(new Blob([exportDatabase(item.payload)], { type: "application/json;charset=utf-8" }), `课堂管理本机安全副本-${item.createdAt.slice(0, 10)}-${item.key.slice(-6)}.json`);
    notify("本机安全副本已导出，可在 JSON 恢复区重新导入");
  }
  function exportHistory(record) {
    downloadBlob(new Blob([exportDatabase(record.payload)], { type: "application/json;charset=utf-8" }), `课堂管理云端历史-v${record.revision}-${todayText()}.json`);
    notify(`云端历史版本 ${record.revision} 已导出`);
  }
  async function restoreCloudHistory(record) {
    if (!sync.backupReady) return notify("恢复尚未开始：请先点“导出当前本机版本”，当前数据未改动");
    if (!confirm(`将云端历史版本 ${record.revision} 作为一个新版本提交。历史行不会被修改，是否继续？`) || !confirm("再次确认：恢复会替换当前整库；当前本机版本已导出，系统还会再保存一份本机安全副本。")) return;
    try { await sync.restoreHistory(record); notify(`历史版本 ${record.revision} 已通过版本校验恢复为新的云端版本`); }
    catch (error) { notify(error.message); }
  }
  function loadFixture() {
    if (!confirm("此操作将用6班×60人的虚构验收数据替换当前数据。是否继续？") || !confirm("再次确认替换当前数据？")) return;
    const fixture = createFictionalDataset(); fixture.settings.onboarding.completedVersion = "2.0";
    replaceData(fixture); notify("虚构验收数据已载入");
  }

  return <>
    <section className="hero-panel backup-hero"><div><p className="eyebrow">数据健康中心</p><h2>{syncIssue.title}</h2><p>{syncIssue.action}</p></div><div className="button-row"><span className="privacy-badge">请勿投屏 · 含备份与账号状态</span>{canRetry && <button onClick={() => sync.retry().catch((error) => notify(`${error.message}；本机数据已保留，请检查网络或登录后重试`))}>{syncIssue.code === "network" ? "重新连接" : "重试同步"}</button>}<button onClick={reopenOnboarding}>查看使用说明</button><button className="primary" onClick={exportJson}>导出当前本机版本</button></div></section>
    <section className="health-grid"><article className="panel health-card"><span>同步状态</span><strong>{sync.state.status}</strong><small>{sync.state.error ?? "没有待处理错误"}</small></article><article className="panel health-card"><span>当前云端版本号</span><strong>{sync.configured ? sync.accountInfo.revision : "—"}</strong><small>{sync.configured ? `最近同步：${formatTime(sync.state.lastSyncedAt)}` : "本地模式没有云端版本号"}</small></article><article className="panel health-card"><span>本机待同步</span><strong>{sync.accountInfo.pending ? "1 份最终快照" : "0"}</strong><small>{sync.accountInfo.queuedAt ? `保存于 ${formatTime(sync.accountInfo.queuedAt)}` : "没有排队中的修改"}</small></article><article className="panel health-card"><span>本机安全副本</span><strong>{safetyBackups.length}</strong><small>每个账号最多保留最近 3 份</small></article></section>
    {sync.configured && <section className="panel"><div className="section-heading"><div><p className="eyebrow">云端最近 20 个历史版本</p><h2>恢复会新建版本，不会修改历史行</h2></div><button onClick={() => sync.loadHistory().catch((error) => notify(error.message))} disabled={sync.historyLoading}>{sync.historyLoading ? "正在读取…" : "刷新云端历史"}</button></div><p>先导出当前本机版本，再选择历史快照。系统会完整校验快照和大小，并用当前版本号做原子提交；若另一台设备已更新，将进入冲突而不是覆盖。</p>{sync.historyError && <p className="error" role="alert">云端历史读取失败：{sync.historyError}。本机数据未改动，请检查网络或登录状态后重试。</p>}{!sync.historyLoading && !sync.history.length ? <Empty text="当前没有可恢复的云端历史版本" /> : <div className="table-scroll"><table><thead><tr><th>版本</th><th>保存时间</th><th>班级</th><th>名单人次</th><th>考勤表</th><th>操作</th></tr></thead><tbody>{sync.history.map((record) => { const summary = summarizeHistoryRecord(record); return <tr key={record.revision}><td>v{record.revision}</td><td>{formatTime(record.archived_at)}</td><td>{summary.classCount}</td><td>{summary.studentCount}</td><td>{summary.attendanceCount}</td><td><button onClick={() => exportHistory(record)}>导出此版本</button><button className="danger" onClick={() => restoreCloudHistory(record)}>恢复为新版本</button></td></tr>; })}</tbody></table></div>}<p className={sync.backupReady ? "success-box" : "privacy-warning"}>{sync.backupReady ? "当前本机版本已导出，可以选择历史版本恢复。" : "恢复按钮不会直接覆盖：必须先点页面顶部“导出当前本机版本”。"}</p></section>}
    {sync.configured && <section className="panel"><div className="section-heading"><div><p className="eyebrow">按当前账号隔离</p><h2>本机安全副本</h2></div></div>{safetyBackups.length ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>原因</th><th>操作</th></tr></thead><tbody>{safetyBackups.map((item) => <tr key={item.key}><td>{formatTime(item.createdAt)}</td><td>{item.reason}</td><td><button onClick={() => exportSafety(item)}>导出此副本</button></td></tr>)}</tbody></table></div> : <Empty text="当前账号还没有冲突或恢复前安全副本" />}</section>}
    <section className="two-column"><article className="panel"><div className="section-heading"><div><p className="eyebrow">安全整库恢复</p><h2>先校验，再替换</h2></div></div><p>错误版本、畸形 JSON、重复学号或无效考勤会被拒绝；校验失败时，当前数据不会改变。</p><div className="button-row"><button onClick={exportJson}>先导出当前数据</button><label className="file-button">选择 JSON<input type="file" accept=".json" onChange={(event) => selectBackup(event.target.files[0])} /></label></div>{pending && <div className="success-box"><strong>文件校验通过</strong><p>{pending.classes.length} 个班级，{pending.attendanceSessions.length} 张考勤表</p><button className="danger" onClick={restore}>确认替换全部数据</button></div>}</article><article className="panel"><div className="section-heading"><div><p className="eyebrow">数据边界</p><h2>保存位置与恢复提醒</h2></div></div>{sync.configured ? <><p>修改先保存在当前账号的本机缓存，再尝试同步。退出账号后不会显示上一账号数据。</p><p>Supabase Free 可能休眠或限额，不能代替独立备份；假服务测试不等于真实云端上线。</p></> : <p>当前是本地模式。清理浏览器数据、卸载浏览器或设备损坏都可能造成数据丢失。</p>}<p>最近完整备份：{formatTime(data.settings.lastBackupAt)}</p></article></section>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">预警设置</p><h2>同一学期、同一课程累计阈值</h2></div></div><div className="form-grid three">{[["absent", "缺勤（节）"], ["late", "迟到（次）"], ["early", "早退（次）"]].map(([key, label]) => <label key={key}>{label}<input type="number" min="1" value={data.settings.warningThresholds[key]} onChange={(event) => update((next) => { next.settings.warningThresholds[key] = Math.max(1, Number(event.target.value)); }, "预警阈值已保存")} /></label>)}</div></section>
    <section className="panel test-fixture"><div><p className="eyebrow">仅用于验收演示</p><h2>载入可复现虚构数据</h2><p>6个班级、每班60人、2门课程、2个学期（含归档）及固定预警样例。</p></div><button onClick={loadFixture}>载入虚构数据集</button></section>
  </>;
}
