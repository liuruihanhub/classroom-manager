# TEST_REPORT（v2.0 正式冻结）

测试日期：2026-08-12  
环境：Windows，Node.js v26.4.0，Chrome 151.0.7922.109，Vite 8.2.1  
测试数据：只使用项目生成的虚构学生数据；没有真实账号、学生信息、URL、key 或 token。

## 1. 最终命令与真实结果

```powershell
npm.cmd run test:all
npm.cmd audit --json
node scripts\browser-v20-rc1-evidence.mjs
node scripts\browser-v20-rc1-pwa-evidence.mjs
node scripts\browser-v125-to-v20-upgrade-evidence.mjs
node scripts\browser-v20-fresh-offline-evidence.mjs
```

- `npm.cmd run test:all`：83/83 通过，0 失败，0 跳过，0 TODO。
- `npm.cmd audit --json`：0 个已知漏洞；info/low/moderate/high/critical 均为 0。
- 正式未配置入口：298.32 kB raw / 91.55 kB gzip；CSS 25.33/5.55 kB，均低于 300/95 KB 门槛。
- 独立抽名页：389,649 bytes；单一 HTML，无外链脚本/样式、无账号或同步配置。
- PWA：180/192/512 PNG 图标、manifest、Service Worker 与 16 个非 map JS/CSS 均进入预缓存；JS/CSS 总量 1,790,659 bytes（约 1.71 MiB）。
- 最终 `dist/` 已恢复未配置本地模式，不含严格假服务 URL/key。

## 2. 固定虚构数据与业务量化

- 2 个学期，其中 1 个归档；每学期 6 班×60 人；当前学期 360 名单人次，整库 720 名单人次；2 门课程，13 张固定考勤表。
- 目标学生：缺勤 3 节、迟到 3 次、早退 3 次、病假 1 节、事假 1 节、其他 1 节；三类预警均触发，病假/事假不计缺勤。
- 平时分：默认初始分 70；固定异常学生考勤分 43、加权总分 64.6；0、满分、负数、超上限、NaN/Infinity、事件修改/撤销均有边界测试。
- 归档：考勤、成绩、事件、抽名历史、满分/配置和名单修改均由业务层拒绝；新学期名单使用独立快照。
- 工作台：总览到可编辑考勤为 2 次主要点击；抽中后 1 次点击记录课堂表现，且只新增 1 条。

## 3. JSON、迁移、同步与历史安全

- JSON 完整往返成功；错误版本、畸形 JSON、缺 settings、非法阈值/节数/分值/权重、重复 ID/非空学号、所有悬空引用、考勤名单缺失或多余均拒绝；失败返回原对象且 localStorage 0 写入。
- 1.1/1.2→2.0 各连续 100 次迁移结果一致；100 次迁移失败不改原对象、不写 localStorage；未知旧字段、ID、名单快照和业务记录保留。
- 100 次离线修改只上传 1 份最终有效快照；100 次旧 revision CAS 全拒绝；100 份畸形远端 payload 全拒绝。
- 100 次云历史恢复均先保存唯一、可重新导入的本机副本，再以 CAS 生成新 revision，历史目标行不变。
- 恢复期 100 次陈旧 revision 全拒绝并进入冲突；100 个畸形/超限历史快照全拒绝。
- SQL 静态门禁：两表强制 RLS；RPC 使用 `auth.uid()` 且不接收 `owner_id`；浏览器角色不能直接 update/delete 历史；payload 上限 4 MiB；主写入同事务留历史且保留最近至少 20 版。
- 严格假 Supabase 的正式 2.0 React Hook 浏览器验证 6/6：首次说明一次性、成功恢复、业务修改使恢复资格失效、另一设备抢先写冲突、过期会话、断网待同步均通过。证据 `v20-final-sync-hook-state.json` 顶层为 `scenarios: 6`、`passed: 6`、`pass: true`；脚本在写文件前再次断言该汇总。

上述云端结果只证明客户端语义和 SQL 静态边界，不代表真实 Supabase/Cloudflare 已上线。

## 4. 搜索与随机量化

### 当前学期学生查找

- 360 人索引、1,000 次真实搜索函数：p50 0.010 ms、p95 0.018 ms、max 0.586 ms，低于 100 ms。
- 同名学生按 `studentId` 区分；空学号不会命中全部；多课程要求教师明确选择；归档学期排除；零课程有可恢复提示。
- 100 个脚本式/XSS 姓名只以 React 文本显示；无正则拼接、`innerHTML` 或执行结果。
- 浏览器精确定位固定学生/课程的 12 条考勤和 3 项成绩；返回搜索保留查询和焦点。

### 随机抽名 10,000 次

固定种子 `mulberry32`；60 人中排除 1 人，对其余 59 人分别抽样 10,000 次。

| 模式 | 覆盖率 | 最少 | 最多 | 均值 | 变异系数 | 排除者 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 纯随机 | 100% | 141 | 207 | 169.49 | 0.0733 | 0 |
| 加权随机 | 100% | 153 | 187 | 169.49 | 0.0412 | 0 |

主系统与独立页默认纯随机；统计断言使用宽松离散上限，避免概率性偶发失败。

## 5. 正式浏览器验收

| 场景 | 真实结果 | 证据 |
| --- | --- | --- |
| 2.0 本地模式/首次说明 | 未配置时无登录门；首次说明出现一次，确认后不重复，可从数据健康重开 | `v20-final-browser-state.json`、`v20-beta1-browser-state.json` |
| 课堂工作台 | 最近课堂≤2点击进考勤；抽名后≤2点击且只增1事件；投屏区无成绩/敏感备注 | `v20-alpha-two-click-proof.json/png`、`v20-final-workspace-1440.png` |
| 全站语义与隐私 | 10 页面/状态、626 个可见控件：无未命名按钮、未标注输入、重复 ID 或标题跳级；打印只保留报表 | `v20-final-browser-state.json` |
| 响应式 | 1440/768/720（200%等效）/375 均无页面级横向溢出；720/375 可见按钮最小 48px | `v20-final-*.png` |
| 学生查找 | 同名/多课程/空学号/归档/XSS/键盘/焦点锁定及精确明细均通过 | `v20-beta2-browser-state.json`、`v20-final-student-detail-1440.png` |
| 云历史与冲突 | 严格假服务 6 组实际 React Hook 操作全部通过；375px 断网恢复无溢出 | `v20-final-sync-hook-state.json`、`v20-final-sync-conflict.png` |
| PWA waiting 协议 | 旧页不被强制接管；等待时旧/新缓存并存；关完旧窗后只剩2.0；业务 JSON 三阶段逐字节一致 | `v20-final-pwa-state.json` |
| 运行时懒块压力 | 删除懒块后在线首开→断开传输→离线冷开数据健康/搜索，20/20；REST 探针缓存为0 | `v20-final-pwa-state.json` |
| 真实 v1.2.5→2.0 | 从哈希一致的冻结 zip 启动；旧懒块从未预访问，部署切换后由2.0保留旧hash首次加载；明确迁移后720名单人次完整 | `v20-final-real-v125-upgrade-state.json`、对应两张截图 |
| 全新安装立即断服 | 只打开安装探针，不访问业务页；停服后首次打开 Onboarding/Workspace/DataHealth/StudentSearch 全成功 | `v20-final-fresh-offline-state.json`、`v20-final-fresh-install-offline-first-use.png` |
| 独立抽名 `file://` | 粘贴/Excel/排除/抽名/清空历史已实走；最终产物仍单文件、默认纯随机 | `standalone-file-draw.png`、`v125-final-standalone.png` |

## 6. PWA 更新根因与兼容结论

1. 2.0 worker 不调用 `skipWaiting`。新版本安装完成后保持 waiting，界面持续提示先确认数据已保存，再关闭所有本系统窗口。
2. 最后一个旧窗口关闭后，2.0 激活、清理旧缓存并 `clients.claim()`；不会在旧页面运行中强制混用新旧模块。
3. `cache.put` 位于 `respondWith` 返回 Promise 中，worker 等写入完成；配额/存储失败被捕获，不阻断有效网络响应。
4. 2.0 预缓存全部 16 个非 map JS/CSS，保证必要按需页未访问也可离线首次打开。
5. 2.0 静态产物保留冻结 v1.2.5 的 5 个唯一旧 hash JS/CSS；真实升级证明旧页不预取旧懒块也能在部署后首次加载。

## 7. 必须保留的失败记录

1. v1.2.4 文案审校后首次全量为 55/57；两项旧文案断言更新后 57/57，未删除历史失败。
2. `agent-browser` 曾因 npm 缓存 `EPERM`、CDP channel closed/挂起失败；会话和端口已清理，最终使用本机 Chrome + Playwright，工具失败未计作应用通过。
3. RC PWA 首跑漏接两次确认，后续又暴露 `cache.put` 未绑定生命周期；修脚本确认后继续攻击，最终修生产缓存 Promise。
4. 仅等待 active 的方案仍存在 mixed-version 风险；改为 waiting worker 后才通过旧页/关窗/清缓存门禁。
5. RC 严格假服务首次复验 5/6，原因是脚本未等待懒加载说明页；改为等待标题并重置服务后 6/6。
6. 真实 v1.2.5→2.0 首跑失败：旧 `browser-*.js` 虽已缓存，但依赖的旧 `module-*.js` 未保留，动态 import 失败。2.0 随后保留全部实际旧 hash JS/CSS，再以“旧懒块从未预访问”重跑通过。

## 8. 静态边界与尚未验证项

- 独立单页不含 Supabase、账号、学生画像、教学备注、网络请求或外链，只通过教师主动选择 JSON 读取名单。
- 项目没有 Worker/D1/Drizzle/ChatGPT Auth/服务端业务 API 运行或构建依赖；源码不使用 `eval()`。
- 前端只接受 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_PUBLISHABLE_KEY`；正式 dist 不含假服务 URL/key，仓库没有真实 secret/token/service_role 值。
- 临时预览、假服务和浏览器调试端口均在最终构建后关闭。
- 未验证：真实 Supabase 双设备、跨账号 RLS、Auth token 轮换、Realtime 延迟、Free 休眠/恢复、Cloudflare 生产发布/回滚。
- 未验证：iPhone/iPad Safari HTTPS 主屏安装、后台恢复、VoiceOver 与存储压力清理。
- PDF 是图像型，中文外观稳定但不可检索；真实打印机页边距仍取决于驱动。

完整需求映射见 `REQUIREMENTS_MAPPING.md`，逐轮证据见 `V2_ITERATION_REPORT.md`。
