import React from "react";

export default function Onboarding({ data, sync, complete, reopened, close }) {
  const rosterEntryCount = data.semesterRosters.reduce((sum, roster) => sum + roster.students.length, 0);
  const cloudText = sync.configured
    ? "当前部署已配置账号同步。登录后的修改先写入该账号的本机缓存，再通过版本校验上传；本页面不代表真实云端已完成双设备验收。"
    : sync.invalidConfig
      ? "云同步配置不完整，系统已安全回退本地模式；当前数据不会上传。"
      : "当前未配置云同步，数据只保存在这个浏览器；电脑与手机不会自动同步。";
  return <main className="decision-screen"><section className="decision-panel onboarding-panel">
    <p className="eyebrow">{reopened ? "使用说明" : "首次使用 · 2.0 数据边界确认"}</p>
    <h1>{reopened ? "数据怎样保存、导入和同步" : "先确认数据位置，再开始记录课堂"}</h1>
    <div className="onboarding-steps">
      <article><strong>1</strong><div><h2>先保存在本机</h2><p>{cloudText}</p></div></article>
      <article><strong>2</strong><div><h2>导入会替换整库</h2><p>JSON 恢复会替换当前学期、名单、考勤、成绩和抽名记录，不会自动合并；系统会先校验，并要求两次确认。</p></div></article>
      <article><strong>3</strong><div><h2>独立备份仍然必要</h2><p>云端历史和浏览器缓存都不能代替下载的完整 JSON。建议每周备份，学期归档前再备份一次。</p></div></article>
    </div>
    <div className="metric-grid onboarding-summary"><article><span>学期</span><strong>{data.semesters.length}</strong></article><article><span>班级</span><strong>{data.classes.length}</strong></article><article><span>名单人次</span><strong>{rosterEntryCount}</strong></article><article><span>考勤表</span><strong>{data.attendanceSessions.length}</strong></article></div>
    <p className="privacy-warning">只录入教学所需信息。不要记录身份证号、家庭隐私、医疗信息或其他敏感内容。</p>
    <div className="button-row">{reopened && <button onClick={close}>返回系统</button>}<button className="primary" onClick={complete}>{reopened ? "我已了解" : "确认数据边界并进入系统"}</button></div>
  </section></main>;
}
