# 教师课堂管理系统 2.0 迭代记录

> Critic 回查冻结文档触发暂停，经跨任务原始用户消息核验确认后续变更优先，未改动数据模型。

## 2.0-alpha：课堂工作台与无损升级入口

完成日期：2026-08-12  
版本：`2.0.0-alpha.0`  
结论：通过本阶段门槛，可以进入 beta1。此结论不代表真实 Supabase 或 Cloudflare Pages 已上线。

### 问题与改动

| 发现的问题 | 实施改动 | 课堂价值 |
| --- | --- | --- |
| 总览、考勤、抽名、课堂表现分散，容易切错班级或课程 | 新增共享单一班级课程上下文的“课堂工作台”；最近课堂从总览直达 | 减少课中切换和误记 |
| 旧版 1.1/1.2 数据缺少 2.0 设置字段 | 增加纯函数迁移、显式本机升级摘要、升级前原文件导出和原子写入 | 升级失败不改原数据，未知字段和业务 ID 不丢失 |
| 工作台快捷操作可能绕过归档限制 | 考勤、课堂表现、抽名均在业务层校验归档学期 | 历史学期保持只读 |
| 新工作台可能拉高首屏体积 | 使用 `React.lazy` 按需加载工作台 | 保持课堂打开速度 |
| 云端仍可能写入旧版本结构 | 新增 2.0 CAS RPC 迁移，使用 `auth.uid()`、4 MiB 门禁和最近 20 版历史 | 避免旧客户端静默覆盖 2.0 数据 |

### 需求→代码→测试→浏览器证据→未验证项

| 需求条目 | 代码 | 自动测试 | 真实浏览器证据 | 未验证项 |
| --- | --- | --- | --- | --- |
| 1.1/1.2→2.0 无损、确定、幂等迁移；失败不写存储 | `src/core.mjs` 的 `migrateDatabaseToV2` / `migrateAndValidateDatabase`；`src/storage.js` 的 `inspectStoredData` | 1.1/1.2 各 100 次迁移一致；100 次失败保持原对象且写入次数为 0 | 旧数据升级界面已在应用内浏览器看到真实摘要；应用内浏览器确认框控制异常，未把该次操作计为通过 | 真实教师旧备份只允许由教师在上线前另行备份后验收；本项目测试只使用虚构数据 |
| 升级必须先显示来源和影响，不能自动覆盖/上传 | `src/main.jsx` 的 `LocalUpgrade`；确认后 `replaceDataAtomically` | 迁移纯函数、存储零写入攻击测试 | alpha Chrome 复测使用空白浏览器，不覆盖该旧数据分支 | 云端旧 payload 的首次人工确认将在 beta1 引导统一复验 |
| 总览最近课堂到可编辑考勤不超过 2 次主要点击 | `Dashboard`；`src/ClassroomWorkspace.jsx`；`src/workspace-core.mjs` | 工作台上下文、当天考勤复用、60 人快照和归档守卫 | `browser-evidence/v20-alpha-two-click-proof.json`：`primaryClicks=2`、60 行、120 个可用状态选择；`v20-alpha-two-click-proof.png` | iPhone/iPad 真机触控仍需 HTTPS 上线后验收 |
| 工作台抽名后记录课堂表现不超过 2 次且只新增 1 条 | `ClassroomWorkspace` 的 `drawOne` / `addPreset`；`recordWorkspacePerformance` | 同一上下文、严格事件值、一次调用一条记录 | 同一证据 JSON：`performanceClicks=2`、事件 `0→1`；截图显示抽中学生和快捷按钮 | 浏览器随机源不可重放；分布正确性由可注入随机源的 10,000 次测试验证 |
| 工作台归档只读 | `workspace-core.mjs` 业务守卫；归档页面隐藏写入口 | 归档考勤和事件写入均抛出 | 桌面操作只使用在用学期；已有 v1.2.5 归档考勤只读截图 | 工作台归档皮肤将在 rc1 最终全站截图中复验 |
| 2.0 payload 的 CAS/RLS 边界 | `supabase/migrations/20260812_v2_payload.sql`；原 v1.2 SQL 保留用于回滚 | SQL 静态检查版本、`auth.uid()`、无 owner 参数、4 MiB、CAS、20 版历史、最小授权 | 无生产数据库截图 | 必须在真实 Supabase 项目实跑 RPC、RLS 跨账号和历史恢复 |
| 首屏入口包 raw <300 KB、gzip <95 KB | `React.lazy` / `Suspense` 按需加载工作台 | `npm run test:all` 构建检查 | 正式构建：入口 `294.75 kB`，gzip `90.50 kB`；工作台独立块 `8.59/3.32 kB` | 校园网与 iOS 真机冷启动耗时待真实部署验证 |
| 375px 无页面横向溢出、关键触控 48px | `src/styles.css` 工作台响应式规则 | 静态样式和既有移动测试 | 同一 Chrome 状态证据：宽度 `375/375/375`、无溢出、最小可见按钮 48px；`v20-alpha-workspace-mobile.png` | Safari 字体与安全区需真机验收 |
| 不破坏 v1.2.5、本地优先、PWA 与独立单页 | 原业务测试、`service-worker.js`、`standalone/` | 全量 64/64；独立页无外链/同步 SDK；PWA 资源检查 | v1.2.5 PWA 离线/升级证据与独立页证据继续保留 | 2.0 最终 PWA 升级需在 rc1 对正式候选产物重做 |

### 量化结果

- `npm.cmd run test:all`：64/64，通过 64、失败 0、跳过 0、TODO 0。
- 构建入口：294.75 kB raw / 90.50 kB gzip；工作台按需块 8.59/3.32 kB。
- 独立抽名单页：389,649 bytes；仍为单一 HTML。
- Chrome 桌面：最近课堂→可编辑考勤 2 次主要点击；60 行、120 个可用状态选择。
- Chrome 桌面：抽名→课堂表现入账 2 次主要点击；只新增 1 条事件。
- Chrome 375px：无页面横向溢出，最小可见按钮 48px。

### 失败与修复记录

1. 首次直接执行 `npm run test:all` 被本机 PowerShell 执行策略拦截，业务测试未启动；改用 `npm.cmd run test:all` 后 64/64。
2. `Start-Process` 因当前 Windows 环境同时存在大小写不同的 `Path/PATH` 项而失败；未留下后台服务，随后使用可终止的受控预览任务。
3. 浏览器扩展式 Chrome 连接不可用；改用本机 `C:\Program Files\Google\Chrome\Application\chrome.exe` 和隔离上下文进行同品牌实测。
4. 首次调试端口方案遗留的临时 Chrome 缓存被 Vite 文件监听，引发 `EBUSY` 并终止预览；停止准确端口进程、校验并删除唯一临时目录，改用正式 `dist` 预览后通过。
5. 首次 Playwright 定位把带图标的导航误当成精确纯文本，未触发业务操作；改为按可访问名称后通过。生产代码未为测试增加特殊分支。

### 阶段未验证项

- 未提供真实 Supabase/Cloudflare 账号或凭据，因此真实 Auth 邮件策略、跨账号 RLS、CAS RPC、Realtime 延迟、Free 休眠恢复与双真机同步尚未验收。
- 未在 iPhone/iPad 真机 Safari 上验收；当前只有本机 Chrome 的 375px 视口证据。
- 上述项目明确保留到 rc1/上线清单，严格假服务结果不表述为真实云端上线。

## 2.0-beta1：数据健康、历史恢复与首次引导

完成日期：2026-08-12  
版本：`2.0.0-beta.1`  
结论：通过本阶段门槛，可以进入 beta2。严格假服务仅证明客户端 React Hook 与协议语义，不能替代真实 Supabase 验收。

### 问题与改动

| 发现的问题 | 实施改动 | 数据可靠性价值 |
| --- | --- | --- |
| 同步状态、版本号、待同步快照和安全副本分散 | 新增按需加载的“数据健康与恢复”页，集中显示状态、当前版本、最近同步、待同步和每账号安全副本 | 教师能先判断数据是否安全，再决定重试或恢复 |
| 云端有历史但客户端不能安全恢复 | 读取最近 20 版、完整校验 schema/引用/4 MiB；先导出当前版本并另存安全副本，再以主记录 CAS 新提交 | 历史行只读，恢复不会静默覆盖其他设备 |
| 断网、登录过期、免费服务恢复提示相同 | `classifySyncIssue` 与协调器分别输出网络、认证、服务恢复、冲突的结论和下一步 | 说明“发生什么、数据是否保留、接下来做什么” |
| 首次使用不清楚本地/云端边界 | 首次或 2.0 大版本升级显示一次引导；确认后写入 `completedVersion=2.0`，数据健康页可重开 | 防止把本地模式误认为已同步，明确 JSON 导入会替换整库 |
| 登录成功后认证状态过早结束，远端尚未加载时可能短暂显示 0 学期/0 班 | 登录成功不再自行清除加载态，只由完整账号初始化结束加载 | 修复真实浏览器严格假服务发现的空白引导竞态 |
| 数据健康 UI 使入口包逼近上限 | `DataHealth.jsx` 独立懒加载，删除 `main.jsx` 中已无用途的旧备份组件 | 入口保持低于 300/95 KB，beta2 必须继续拆块 |

### 需求→代码→测试→浏览器证据→未验证项

| 需求条目 | 代码/SQL | 自动测试 | 正式构建浏览器证据 | 未验证项 |
| --- | --- | --- | --- | --- |
| 历史 RLS/owner 隔离，客户端不接受可伪造 owner 参数；历史不可直接写删 | `20260811_teacher_database_sync.sql` 的 history RLS/force RLS/select-only grant；`supabase-adapter.mjs` 的闭包 `userId` 查询 | SQL/适配层静态检查；跨账号历史、重复 revision、>20 条全拒绝 | 严格假服务按固定虚构账号查询；不对浏览器暴露 owner 参数 | 真实 Supabase 必须用两个 Auth 账号交叉查询验证 RLS |
| 恢复=读历史→完整校验/大小→当前本机安全副本→主记录 CAS 新提交 | `data-health-core.mjs`；`use-realtime-sync.jsx.restoreHistory`；`DataHealth.jsx` | 100 次成功恢复；每次仅 1 份恢复前副本、JSON 可再导入、主 revision +1、旧历史不变 | `v20-beta1-sync-hook-state.json`：v7→v8，v3 仍在；安全副本下载并通过界面 JSON 恢复 | 真实 Supabase 事务延迟和 4 MiB 临界弱网耗时 |
| 恢复期间另一设备抢先写入必须冲突 | 协调器 CAS 与 `restoreHistory` 冲突出口 | 100 次陈旧 revision 全拒绝，静默覆盖 0 | 假服务另一设备先写到 v13；恢复后仍 v13、教师名不变，显示冲突；`v20-beta1-sync-conflict.png` | 两台真实设备 Realtime 到达顺序 |
| 导出后任何业务修改使恢复资格失效 | `save()` 首先 `setBackupReady(false)`；恢复前强制检查 | 源码与恢复状态测试 | 修改缺勤阈值后恢复：确认框 0 个、远端 revision 不变、提示重新导出 | 无 |
| 断网/会话过期恢复失败且本机与队列保留 | `safeMessage`、`SyncCoordinator.fail`、账号缓存最终快照 | 账号过期与断网均保留 `current/pending` | 过期会话显示“本机数据和待同步修改均已保留”；断网恢复保留 generation 2、远端不变；移动截图 `v20-beta1-offline-restore-mobile.png` | 真实 Auth refresh token 轮换与 Free 休眠时长 |
| 首次/大版本引导出现一次、刷新不重复、可重开 | `settings.onboarding.completedVersion`；`Onboarding`；数据健康入口 | 2.0 迁移/字段严格校验；登录加载竞态静态回归 | 本地构建与严格假服务均实测：首次出现、确认、刷新不重复、数据健康页重开；`v20-beta1-data-health-local.png` | 真机 Safari 的键盘/安全区 |
| 本地数据边界与恢复警告 | 引导明确本机保存、同步不是默认、JSON 整库替换、独立备份 | 文案静态检查 | `v20-beta1-browser-state.json` 四项均 true，实际下载 JSON version=2.0/settings 存在 | 无 |
| 入口 raw<300 KB/gzip<95 KB | `DataHealth` 懒加载 | 构建门禁 | 最终未配置构建入口 298.40/91.46 KB；DataHealth 10.42/3.75 KB | 余量仅 1.60 KB，beta2/rc 新页面必须继续独立拆块 |

### 量化与浏览器结果

- `npm.cmd run test:all`：71/71，通过 71、失败 0、跳过 0、TODO 0。
- 云历史：成功恢复 100 次；陈旧 revision 拒绝 100/100；畸形/超限历史拒绝 100/100。
- 恢复前安全副本：每轮唯一 1 份、100/100 可重新导入；历史目标行 100/100 保持不变。
- 严格假服务浏览器：首次引导、成功恢复、资格失效、抢先写冲突、过期会话、断网恢复共 6 组全部通过。
- 未配置本地 Chrome：首次引导文案 4/4，下载 JSON 有效，刷新不重复，可重开；375px 无页面溢出、按钮最小 48px。
- 构建：入口 298.40 kB raw / 91.46 kB gzip；数据健康块 10.42/3.75 kB；独立页 389,649 bytes。

### 失败与修复记录

1. 初次新测试为 68/70：安全副本导出会按设计更新 `exportedAt`，原断言错误地要求逐字节相同；改为验证可导入和全部业务数据一致。RLS 断言也按 SQL 的等价写法修正。
2. 下一次为 70/71：测试用 JSON 字段顺序比较历史行，不能证明语义不变；改为按 revision 定位并逐字段/整 payload 深比较后通过。
3. 严格假服务首次登录出现网络错误：CORS 预检缺少 `x-supabase-api-version`；只修测试服务协议，无生产降级。
4. 随后发现真实认证竞态：登录成功后引导短暂显示空白摘要；修复生产 Hook 的加载态所有权，重新构建验证。
5. 假 Realtime 首次错误返回了不匹配的绑定，协调器进入离线待同步；按 Supabase Realtime 客户端协议返回无绑定映射的成功响应后，实际 RPC 才正常通过。
6. 375px 假服务复测首次无法点击屏外侧栏：验收脚本改为先通过真实“打开导航”按钮进入，随后离线恢复通过。

### 阶段未验证项

- 没有真实 Supabase/Cloudflare 凭据；真实双设备、RLS 跨账号、Auth 刷新、Realtime 延迟、免费服务休眠/恢复仍未验证。
- 假服务没有模拟 Supabase 的所有限额和网络抖动，只证明正式前端对 Auth/REST/RPC/Realtime 的本阶段客户端语义。
- 没有 iPhone/iPad 真机；375px 是本机 Chrome 移动视口。

## 2.0-beta2：当前学期全局学生查找

完成日期：2026-08-12  
版本：`2.0.0-beta.2`  
结论：通过本阶段门槛，可以进入 rc1。搜索只在教师明确的使用中学期内建立本机内存索引，不上传索引或查询词。

### 问题与改动

| 发现的问题 | 实施改动 | 课堂价值 |
| --- | --- | --- |
| 同时存在多个使用中学期时，数组第一项可能被误当作当前学期 | 优先采用课堂工作台当前课程所属学期；多个在用学期显示“查找学期”选择，未明确时不搜索 | 不会把学生定位到错误学期 |
| 同名学生、空学号与多课程可能产生误选 | 每条结果以 `student.id` 区分，空学号不参与匹配；显示班级与全部课程，课程多于一门时要求明确选择 | 防止把考勤或成绩看成另一位同名学生/另一门课 |
| 搜索跳转只打开泛化页面，仍需重新选人 | 新增学生课程明细：携带 `studentId + offeringId` 直接展示该生该课程的考勤与平时分 | 从查找到事实明细一步到位 |
| 零课程结果按 Enter 会进入无按钮死页 | 保持在结果页，明确提示先到“基础数据”关联课程 | 没有死路，数据不改变 |
| 键盘活动项可能移出视口，模态 Tab 可泄漏到背后页面 | 活动结果 `scrollIntoView(nearest)`；Tab/Shift+Tab 锁定；进入课程选择主动聚焦返回按钮；返回保留查询并恢复焦点 | 键盘和投屏操作可连续完成 |
| 名称来自导入文件，存在脚本/XSS 风险 | 查询做 NFKC/trim/大小写归一和 100 字符上限，不拼接正则；结果只用 React 文本节点 | 恶意名称以普通文字显示，不执行 |

### 需求→代码→测试→浏览器证据→未验证项

| 需求条目 | 代码 | 自动测试 | 正式构建浏览器证据 | 未验证项 |
| --- | --- | --- | --- | --- |
| 当前在用学期；工作台优先；多个学期显式选择；归档排除 | `StudentSearch.jsx` 的 `workspaceSemesterId/semesterId`；`buildStudentSearchIndex` | 360 人索引只含指定学期；归档 ID 为 0 | `v20-beta2-browser-state.json`：工作台学期默认 `sem_2026`、选项明确标记；切换后查询清空；归档专有姓名结果 0 | iPhone/iPad 真机原生 select 样式 |
| 同名、空学号、多课程不误选 | `student-search-core.mjs` 以 `studentId` 建索引；课程上下文数组 | 同名跨班两个独立 ID；空查询/空学号 0；两门课程均保留 | 两个结果 ID/班级不同，各显示 2 门课；Enter 出现 2 张课程选择卡，未静默进入明细 | 无 |
| 精确定位学生的考勤/成绩 | `buildStudentCourseDetail`；`StudentDetail` | 固定学生/course_ev：12 条考勤、缺勤/迟到/早退各 3、3 个成绩项 | 浏览器显示“新能源1班 · 新能源汽车结构与原理”；考勤 12 行、成绩 3 行 | 当前是只读明细；直接编辑仍通过原考勤/成绩页面完成 |
| 查询归一、无正则/XSS、超长输入 | `normalizeSearchText/searchStudents`；React 文本呈现 | 100 个脚本式姓名全部按文本命中；全角学号匹配；源码无 `RegExp/eval/fetch/innerHTML` | 恶意 `<img onerror>` 名称可见，DOM 图片 0、执行标记 false；超长输入无结果 | 浏览器证据用 2 个恶意姓名，完整 100 个由自动测试覆盖 |
| 键盘、滚动、返回状态、焦点锁定 | `onInputKeyDown/dialogKeyDown/resultRefs/courseChoiceRef` | 源码门禁 Arrow/Enter/Escape/scroll/focus trap | ArrowDown 到第 25 项仍在滚动区可见；课程页 Escape 返回后查询为“同名学生”且输入框聚焦；Tab 双向锁定 | 屏幕阅读器实际朗读需真机/辅助技术用户验证 |
| 零课程与无结果有可恢复提示 | `openResult` 零课程提前返回 | 零课程上下文数组为空；无结果/超长输入 | 零课程 Enter 留在结果页并说明下一步；无结果文案显示 | 无 |
| 360 人下 1000 次搜索 p95<100ms | `searchStudents` 实际函数 | 最终全量：p50 0.010ms、p95 0.019ms、max 0.606ms | 真实界面 50ms 防抖后响应；无页面错误 | 校园低端 iPhone 实际 CPU 未测 |
| 懒加载与入口体积 | `main.jsx` 的 `React.lazy(StudentSearch)` | 构建产物静态检查 | 入口 299.16/91.73 KB；搜索块 11.10/3.90 KB | raw 余量 0.84 KB，rc1 不得再向入口堆代码 |
| 375px 无溢出、触控≥48px | 搜索全屏移动样式 | CSS 静态门禁 | `375/375/375`、无溢出、搜索模态最小可见按钮 48px；`v20-beta2-search-mobile.png` | Safari 安全区和中文输入法待真机 |

### 量化与浏览器结果

- 阶段测试：77/77，通过 77、失败 0、跳过 0、TODO 0。
- 搜索性能：1000 次真实 `searchStudents`；360 人；最终全量 p50 0.010ms、p95 0.019ms、max 0.606ms。
- 正式构建：入口 299.16 kB raw / 91.73 kB gzip；搜索块 11.10/3.90 kB；独立页 389,649 bytes。
- Chrome 桌面：归档排除、多学期、同名、多课程、考勤/成绩精确定位、零课程、XSS、键盘/焦点共 12 组通过；页面错误 0、失败资源 0。
- Chrome 375px：页面无横向溢出，搜索模态宽 375px，最小可见按钮 48px。

### 失败与修复记录

1. `agent-browser` 能打开本机页面，但 CLI 初始化需要临时联网且多步往返未形成完整证据链；按监督要求关闭隔离会话并清理 4178 端口。此项记为工具环境失败，不计作应用通过或失败。
2. 第一轮 Playwright 暴露真实缺陷：Enter 进入多课程页后搜索框卸载，焦点落到主体，Escape 无法返回。增加课程选择页初始焦点后整链通过。
3. 第二轮应用业务断言 13/14 通过；唯一失败是证据脚本用不适配原生 `<select>` 的方式读选项，返回空数组。改为直接读取 `select.options`，未修改生产分支，最终全通过。

### 阶段未验证项

- 没有真实 Supabase/Cloudflare 凭据；真实双设备、RLS、Realtime 延迟等 beta1 未验证项不因搜索通过而消失。
- 没有 iPhone/iPad 真机；375px 为本机 Chrome 移动视口。
- 搜索结果是当前学期名单快照中的“名单人次”；v3 建立稳定 `personId` 前不做跨学期同人自动合并。

## 2.0-rc1：视觉、文案、可访问性与安全更新协议

完成日期：2026-08-12  
版本：`2.0.0-rc.1`  
结论：RC1 门槛通过，可以进入 2.0 正式版冻结。最终发布构建已恢复为未配置云端的本地模式；严格假服务只证明客户端语义，真实 Supabase/Cloudflare 仍列为上线前未验证项。

### 问题与改动

| 发现的问题 | 实施改动 | 课堂与数据价值 |
| --- | --- | --- |
| 页面颜色、标题、卡片、状态和焦点规则分散 | 把页面/表面/文字/边框/主操作/成功/警告/危险/焦点/图表整理为语义 CSS token；统一排版、轻阴影、按钮层级、48px 移动触控和 `focus-visible` | 桌面保持密度，手机可快速点按，状态不只靠颜色 |
| 课堂投屏可能误带成绩或备注 | 工作台和抽名投屏区不显示成绩、敏感备注或“其他”备注输入；名单、成绩、报表、个人明细、数据健康明确“请勿投屏”；打印只保留报表主体 | 降低课堂公开屏幕泄露学生隐私的风险 |
| 同步/更新提示偏技术化或会强制刷新 | 同步错误说明原因、数据是否保留和下一步；更新使用 waiting worker，不自动 `skipWaiting`，持续提示关闭所有系统窗口后重开 | 不在教师录入中途强制接管旧页面，避免 mixed-version 懒块失败 |
| 运行时缓存写入没有绑定 fetch 生命周期 | 同源成功响应的 `cache.put` 串入 `respondWith` Promise；缓存失败被隔离，不阻断有效网络响应 | 在线打开过的按需页面能可靠离线重开，存储配额失败仍可继续在线使用 |
| 首次说明仍推高入口体积 | `Onboarding` 独立懒加载，搜索、数据健康和课堂工作台继续分块 | 正式本地入口保持 300/95 KB 严格门槛内 |

### 需求→代码→测试→浏览器证据→未验证项

| 需求条目 | 代码 | 自动测试 | 正式构建浏览器证据 | 未验证项 |
| --- | --- | --- | --- | --- |
| 语义 token、统一层级、轻阴影、120–220ms 动效、减少动效 | `src/styles.css` | `tests/v2-rc1.test.mjs` 静态门禁 | `v20-rc1-browser-state.json`：10 个页面/状态共 626 个可见控件，无未命名按钮、无未标注输入、无重复 ID/标题跳级；reduced-motion 通过 | VoiceOver/NVDA 实际朗读需真机辅助技术复验 |
| 隐私投屏与安全打印 | `ClassroomWorkspace.jsx`、`main.jsx`、`StudentSearch.jsx`、`DataHealth.jsx`、打印 CSS | 投屏敏感词与打印规则测试 | 工作台/抽名无成绩或敏感备注；报表打印时侧栏、顶栏、筛选、隐私提示均隐藏，仅报表主体保留 | 真实投影仪和打印机驱动边距 |
| 375/768/1440、200% 等效、长姓名/班名 | 响应式 CSS 与表格局部滚动 | 移动样式门禁 | 1440/768/720/375 均无页面横向溢出；720/375 可见按钮最小 48px；长中文仍在容器内 | iPhone/iPad Safari 安全区和中文输入法 |
| 同步状态读屏、错误恢复、危险操作二次确认 | `main.jsx`、`sync-core.mjs`、`data-health-core.mjs` | aria-live、错误文案、删除/归档/整库恢复双确认 | 正式本地页无语义缺口；严格假服务登录/恢复/冲突/过期/断网 6/6 | 真实 Auth token 轮换与 Free 休眠时长 |
| 等待式 PWA 更新，不破坏旧标签或旧 hash | `public/service-worker.js`、`main.jsx` | 无 `skipWaiting`、waiting/updatefound、持久更新提示静态测试 | `v20-rc1-pwa-state.json`：beta2 旧页仍可加载专属旧懒块；RC1 waiting 时 beta2 cache 保留；关闭全部旧页后仅剩 RC1 cache；三阶段业务 JSON 逐字节一致 | iOS Safari 对 waiting worker 的实际提示与多窗口生命周期 |
| 在线首开按需块后离线可靠重开；云 API 不缓存 | `cacheSuccessfulSameOrigin`、Supabase 路径旁路 | 缓存写入 Promise 与失败隔离静态测试 | 删除懒块后“在线首次打开→断开所有传输→冷开数据健康/搜索”20/20；实际 REST 探针请求成功但缓存命中为 0；最终停服冷开通过 | 校园设备存储配额耗尽只能现场验证降级文案 |
| 入口 raw<300 KB/gzip<95 KB，独立页边界不变 | `Onboarding`/工作台/搜索/健康懒加载；独立单页原构建 | 全量构建与独立页扫描 | 最终未配置入口 298.32/91.56 KB；独立页 389,649 bytes、无外链/同步配置 | raw 余量 1.68 KB，2.0 正式版不得向入口新增业务代码 |

### 量化与浏览器结果

- `npm.cmd run test:all`：83/83，通过 83、失败 0、跳过 0、TODO 0。
- 正式本地构建：入口 298.32 kB raw / 91.56 kB gzip；CSS 25.33/5.55 kB；按需页均独立分块。
- RC 全站浏览器：10 个页面/状态语义通过；1440/768/720/375 视口通过；打印、投屏隐私、reduced-motion、运行错误 0 均通过。
- PWA：等待式 beta2→RC1 更新、旧缓存延后删除、无旧客户端后激活、新缓存唯一、业务数据不变全部通过；按需块离线重复命中 20/20。
- 严格假服务：首次引导一次性、历史恢复、业务修改使恢复资格失效、抢先写冲突、过期会话、断网恢复共 6/6 通过；明确不代表真实 Supabase 上线。

### 失败与修复记录

1. `agent-browser` 本轮系统无可执行文件，`npx` 又因 npm 缓存权限报 `EPERM`；按既有监督要求停止该路径，用本机 Chrome + Playwright，不把工具失败计作应用失败或通过。
2. PWA 首次脚本漏接“载入虚构数据”的两次确认框，浏览器默认取消，证据失败；只修脚本确认处理后重跑。
3. 随后停服壳可打开但两个懒块缺失。先发现更新时序仍在 `activating`，继续攻击后确认生产 `cache.put` 未进入 fetch 完成链；修为等待写入且缓存失败不阻断网络响应。
4. Critic 进一步指出自动 `skipWaiting` 会让旧标签与新 hash 混用；改为 waiting worker 协议，并用持久 Chrome 资料实测旧页、旧懒块、双缓存等待、关窗激活与清旧缓存。
5. 严格假服务首次复验为 5/6：点击按需加载的使用说明后脚本立即 `isVisible()`，未等待懒块；改为等待最终标题，重置假服务后 6/6。生产同步业务未因此改动。

### 阶段未验证项

- 没有真实 Supabase/Cloudflare 凭据；真实双设备、RLS 跨账号、Realtime 延迟、Auth 刷新、免费服务休眠/恢复和生产回滚仍未验证。
- 没有 iPhone/iPad 真机；375px 与 PWA 生命周期证据来自本机 Chrome。
- `cache.put` 配额失败已保证不阻断在线响应，但真实 iOS 存储压力清理行为只能在 HTTPS 真机验证。

## 2.0 正式版：真实跨版本升级、完整离线壳与发布冻结

完成日期：2026-08-12  
版本：`2.0.0`  
结论：本地正式版门槛通过，保留 v1.2.5 与 2.0-rc1 回滚基线。正式构建未配置假云地址；真实 Supabase、Cloudflare 和 iPhone/iPad 仍须部署者按手册用虚构数据验收。

### 问题与改动

| 发现的问题 | 实施改动 | 可靠性价值 |
| --- | --- | --- |
| 合成 beta2 worker 只能证明 waiting 协议，不能证明冻结 v1.2.5 的真实旧 hash | 从 SHA-256 一致的 `classroom-manager-v1.2.5-static.zip` 启动旧站，再切换为 2.0；把 v1.2.5 实际仍会被旧页延迟请求的 5 个唯一 hash JS/CSS 保留在 2.0 静态产物 | 教师在部署后才第一次打开旧按需页，也不会因旧资源已下线而崩溃 |
| 只预缓存入口不能保证“从未打开过”的必要按需页首次离线可用 | `finalize-pwa.mjs` 枚举当前 `dist/assets` 的全部非 map JS/CSS，写入 Service Worker 预缓存 | 新安装完成后即使没有预访问工作台、数据健康、搜索或首次说明，也能在停服后首次打开 |
| 严格假服务 JSON 只有六个分项 `pass`，机器汇总可能判为未知 | 浏览器脚本增加顶层 `scenarios`、`passed`、`pass`，写文件前再次断言必须为 6/6 | 报告系统可以直接判定证据通过，避免人工推断 |
| 配置假服务的验证构建不能作为发布产物 | 假服务验收结束后关闭服务与预览端口，并重新运行无环境变量的 `test:all` | 最终 `dist` 回到本地模式，不残留假 URL/key |

### 需求→代码→测试→浏览器证据→未验证项

| 需求条目 | 代码/产物 | 自动或静态验证 | 正式构建浏览器证据 | 未验证项 |
| --- | --- | --- | --- | --- |
| 真实 v1.2.5→2.0，旧页未预访问懒块也可在部署后首次加载 | `public/assets/` 保留 5 个冻结旧 hash；waiting worker | 旧 release SHA 校验；5 个文件逐一存在并进入 `dist` | `v20-final-real-v125-upgrade-state.json`：旧懒块切换前未进缓存，切换后状态 200 且实际 import 成功；旧数据字节不变 | Cloudflare 是否额外保留旧静态文件不再是本方案前提；真实生产 CDN 缓存传播仍待部署验收 |
| 旧窗口全部关闭后才激活2.0并清旧缓存 | `public/service-worker.js` 无 `skipWaiting` | waiting/updatefound 与缓存名门禁 | 真实 v1.2.5 旧窗口保持可用；关完后只剩 `workbuddy-classroom-v2.0`，2.0 页面正常 | iOS 多窗口生命周期 |
| 全新安装、不预访问业务页、立即停服仍能打开必要懒块 | `scripts/finalize-pwa.mjs` 全量必要 JS/CSS 清单 | 最终预缓存 16 项、1,790,659 bytes，不含 map | `v20-final-fresh-offline-state.json`：Onboarding/Workspace/DataHealth/StudentSearch 首次离线打开全部通过 | iOS 存储压力回收行为 |
| 运行时首开后离线可靠命中 | SW 的缓存写入完成链 | 静态测试确认缓存失败不阻断网络 | 同一套正式构建重复 20 次在线首开→停服离线冷开搜索/健康，20/20 | 浏览器配额耗尽降级提示需现场验证 |
| 严格假服务实际 React Hook 六场景可机器汇总 | `browser-v20-beta1-sync-evidence.mjs` | 顶层汇总写前断言 | `v20-final-sync-hook-state.json`：`scenarios=6`、`passed=6`、`pass=true` | 只证明客户端协议语义；真实 Auth/RLS/Realtime 未验证 |
| 正式版本、入口、独立页与安全边界 | `package.json`、`main.jsx`、SW、README、正式 `dist` | 83/83、0 skip/TODO；audit 0；入口 298.32/91.55 KB；独立页扫描 | 最终桌面/768/720/375、PWA、`file://` 证据均指向正式构建 | 真实部署地址和真机 |

### 量化与浏览器结果

- `npm.cmd run test:all`：83/83，通过 83、失败 0、跳过 0、TODO 0。
- `npm.cmd audit --json`：已知漏洞 0。
- 正式入口：298.32 kB raw / 91.55 kB gzip；低于 300/95 KB。
- PWA 必要 JS/CSS：16 个、1,790,659 bytes（约 1.71 MiB，不含 source map）。
- 真实 v1.2.5→2.0：旧懒块未预访问、部署后首次请求成功；等待/激活/清缓存/显式迁移均通过；2 学期、6 班、720 名单人次保留。
- 全新安装后不访问业务页即停服：首次离线打开 Onboarding、Workspace、DataHealth、StudentSearch 为 4/4。
- 运行时缓存压力：20/20；Supabase REST 探针缓存 0。
- 严格假服务 Hook：6/6，证据顶层 `pass=true`。

### 失败与修复记录

1. 真实 v1.2.5 首跑并未完全兼容：旧 `browser-*.js` 在缓存里，但它依赖的旧 `module-*.js` 已从新部署移除，部署后首次动态 import 失败。修复为保留冻结 v1.2.5 的全部 5 个唯一旧 hash JS/CSS，再从干净旧站、未预取懒块的状态重跑通过；报告没有把人工预取写成兼容。
2. 严格假服务后台进程首次用 PowerShell `Start-Process` 时，被宿主重复 `Path/PATH` 环境项拒绝。该失败未计作应用失败或通过；改用无窗口子进程启动后完整重跑，随后关闭 4177/54331 端口。
3. 同步证据首次虽有六个分项 `pass=true`，但没有顶层汇总。补充 `scenarios=6/passed=6/pass=true` 与写前断言后，重新执行真实 React Hook 六场景并覆盖正式 JSON。

### 正式回滚与未验证项

- 正式静态包、源码包及 SHA-256 清单保存在 `releases/`；v1.2.5、2.0-rc1 包继续保留，不覆盖旧基线。冻结审计重新逐包计算 SHA-256 并成功列出关键文件；源码包从 7,522,119 bytes 精简为 422,629 bytes，仅含源码、测试、构建脚本和文档，不递归包含 `releases/`、`dist/`、`browser-evidence/` 或 `node_modules/`。
- 正式 `dist/` 扫描未发现严格假服务 URL/key，4173–4178、54321、54331 目标端口均为 0；根 `MEMORY.md` 已记录 2.0 waiting worker、完整必要资源预缓存与真实平台未验证边界。
- 没有真实 Supabase/Cloudflare 凭据，未执行生产发布；真实双设备、跨账号 RLS、Auth 刷新、Realtime 延迟、Free 休眠和生产回滚仍须按手册验收。
- 没有 iPhone/iPad 真机；Safari HTTPS 安装、VoiceOver、多窗口更新和存储压力清理由部署者验收。
