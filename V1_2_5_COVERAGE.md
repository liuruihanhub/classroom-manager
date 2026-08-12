# v1.2.5 冻结覆盖矩阵与回滚基线

冻结日期：2026-08-12  
冻结版本：`1.2.5`  
结论：本地模式、严格假服务同步、PWA 离线/升级、桌面/375px 手机和独立单页均完成可复现验证。真实 Supabase 与 Cloudflare 生产环境因未提供账号和凭据，仍属于上线前人工验收项，不能表述为已上线。

## 版本迭代记录

| 版本 | 发现的问题 | 有价值的改动 | 量化/浏览器证据 | 全量回归 |
| --- | --- | --- | --- | --- |
| v1.2.0 | v1.1 设备间只能手动传 JSON | 增加 Supabase Auth/Postgres/Realtime 可选层、按账号缓存、CAS 状态机；未配置时完整回退本地模式 | 严格假服务覆盖登录、首次迁移、冲突和退出；`v12-*.png` | 同步测试纳入 57 项套件 |
| v1.2.1 | 冲突可能误覆盖，安全副本不易恢复 | 云端空记录也视为冲突；覆盖前保存并校验本机安全副本；每账号保留最近 3 份 | 100 次旧版本 CAS 全拒绝、100 次离线修改仅上传最终快照；`v125-final-conflict*.png` | 57/57 |
| v1.2.2 | 首屏包偏大、手机同步信息拥挤 | Supabase、Excel、PDF 图像模块按需加载；状态在小屏使用短标签 | 主入口由 399.55 kB/118.30 kB gzip 降至 287.14 kB/88.65 kB gzip；375px 无页面横向溢出 | 57/57 |
| v1.2.3 | 焦点、触控和更新反馈不统一 | `focus-visible`、关键触控 48px、`prefers-reduced-motion`；Service Worker 绕过全部 Supabase 流量 | 同一 Chrome 资料真实完成缓存升级、旧缓存删除及断网重载；见 `v125-pwa-*.png` | 57/57 |
| v1.2.4 | 同步与业务文案偏技术化，课堂入口层级偏深 | 把 revision 对用户显示为“版本号”，错误提示说明数据是否保存和下一步；总览直达“开始考勤” | 桌面总览/名单/考勤/平时分/报表/备份逐页操作 | 初次 55/57：仅 2 条旧文案断言失败；更新断言后 57/57 |
| v1.2.5 | 颜色、卡片、按钮、表格与手机密度不一致 | 青绿色语义 token、统一排版/边框/轻阴影/按钮层级/导航选中态；独立页同步审校 | 1440px 与 375px 最终截图；可见关键按钮最小高度 48px | `npm run test:all` 57/57，`npm audit` 0 漏洞 |

## 需求→代码→测试→浏览器证据→未验证项

| 需求条目 | 代码/配置 | 自动测试 | 浏览器证据 | 未验证项 |
| --- | --- | --- | --- | --- |
| 未配置云端时完整本地回退、无密码门 | `src/use-realtime-sync.jsx`、`src/storage.js`、`src/main.jsx` | `core.test.mjs`、`sync-core.test.mjs` | `v12-local-fallback.png`、`v125-final-dashboard.png` | iOS 真机最终皮肤仍需上线后目检 |
| 教师账号登录、按账号缓存、退出清屏 | `src/supabase-adapter.mjs`、`src/sync-core.mjs`、`src/use-realtime-sync.jsx` | 账号隔离、退出保护、未同步保护 | `v125-final-login.png`、`v12-logout-clears-data.png` | 真实 Supabase Auth 邮件策略与会话刷新 |
| CAS、离线最终快照、Realtime 去重/乱序/自回声 | `src/sync-core.mjs`、SQL RPC | 100 次离线、100 次冲突、重复乱序、自回声 | 严格假服务状态截图 `v12-*` | 两台真实设备的网络延迟与 Realtime 时延 |
| 首次迁移与双端差异冲突，不自动覆盖 | `decideInitialMigration`、`ConflictDecision` | 三条迁移路径、同版本不同内容冲突 | `v12-first-migration-choice.png`、`v125-final-conflict.png` | 真实远端第一次迁移演练 |
| 冲突双版本导出、二次确认、安全副本 | `saveSafetyBackup`、`listSafetyBackups`、冲突页、备份页 | 暂存/正式写入失败、最近 3 份、账号隔离 | `v125-final-conflict*.png`、`v125-final-backup.png` | 浏览器下载目录权限差异 |
| 4 MiB、整库校验、失败不覆盖 | `validateDatabase`、`validateRemotePayload`、SQL RPC | 100 份畸形远端数据及整库攻击集 | `invalid-backup-preserved.png`、`v125-final-backup.png` | 接近 4 MiB 的真实弱网耗时 |
| RLS、最小权限、历史 20 版 | `supabase/migrations/20260811_teacher_database_sync.sql` | SQL 静态安全测试 | 无生产数据库截图 | 必须在真实 Supabase 运行跨账号 RLS 与历史恢复 |
| 6班×60人、2课程、2学期、归档快照 | `scripts/generate-fixture.mjs`、`src/core.mjs` | 固定数据集、归档写守卫 | `v12-local-360-dashboard.png`、`v125-final-setup.png` | 无 |
| 7 状态按节考勤、异常筛选、阈值预警 | `Attendance`、`attendanceStats`、`warningRows` | 缺勤3节/迟到3次/早退3次；病事假不算缺勤 | `v125-final-attendance.png`、`archived-attendance-readonly.png` | 无 |
| 个性化成绩项、权重、初始分、考勤自动计分 | `scoreConfig`、`computeScores`、`Scores` | 初始70、考勤43、总分64.6、边界/事件撤销 | `v125-final-scores.png` | 无 |
| 主系统抽名默认纯随机、排除、加权 | `drawStudent`、`QuickDraw` | 两模式各 10,000 次，覆盖100%，排除0次 | 最终主系统页面操作 | 浏览器随机源不可固定；统计使用可注入源 |
| 报表/Excel/PDF/打印且不产生合并出勤指标 | `Reports`、按需导出模块 | 文案/构建检查、PDF 头与大小 | `v125-final-reports.png` | 真实打印机版式 |
| JSON 备份与安全替换恢复 | `exportDatabase`、`replaceDataAtomically`、`Backup` | 完整往返、畸形/悬空/重复 ID/非法数值全拒绝 | `v125-final-backup.png`、`invalid-backup-preserved.png` | 无 |
| PWA 安装资源、离线壳与更新清旧缓存 | `manifest.webmanifest`、`service-worker.js`、`finalize-pwa.mjs` | 构建资产 200/预缓存/云 API 绕过静态测试 | `v125-pwa-upgrade-before.png`、`v125-pwa-upgrade-after.png`、`v125-pwa-upgrade-offline.png` | iOS 主屏安装必须用生产 HTTPS 真机验证 |
| 独立单 HTML、无网络/账号/Supabase、file:// | `standalone/`、`build-standalone.mjs` | 无外链/单脚本/无同步 SDK；导入攻击测试 | `standalone-file-draw.png`、`v125-final-standalone.png` | 当前 v1.2.5 只改样式文案；`file://` 功能沿用已通过的真实证据 |

## PWA 升级与离线复验结论

1. 用同一 Chrome 151 用户资料安装正式 `workbuddy-classroom-v1.2.5` 缓存。
2. 仅在临时构建中把缓存名改为 `workbuddy-classroom-v1.2.5-upgrade-probe`，显式执行 `registration.update()`。
3. 浏览器返回：新缓存唯一存在，活动 worker 状态为 `activated`，无等待 worker；升级前后截图分别保存。
4. 通过 DevTools Protocol 切换为离线并重载，页面标题仍为“教师课堂管理系统”、主标题仍为“总览”、`navigator.serviceWorker.controller` 为真。
5. 测试后删除探针、临时构建与浏览器资料，重新执行正式构建；正式产物缓存名恢复为 `workbuddy-classroom-v1.2.5`。

## 回滚基线

- `releases/classroom-manager-v1.2.5-static.zip`：可直接发布的 `dist/` 与独立抽名成品。
- `releases/classroom-manager-v1.2.5-source.zip`：v1.2.5 源码、测试、SQL、构建配置和文档，不含 `node_modules`、真实配置或浏览器资料。
- `releases/v1.2.5-SHA256.txt`：两份压缩包的 SHA-256。

回滚不会自动回退 Supabase 表结构。回滚前必须让所有设备停止编辑并分别导出完整 JSON；静态前端回滚后仍应执行虚构账号双设备验收。
