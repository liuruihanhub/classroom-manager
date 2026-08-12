# Supabase 实时同步配置、历史恢复与回滚（v2.0）

本文对应 v2.0“同一教师多设备同步”。上线前只使用虚构学生数据完成验证；真实学生数据必须先取得学校授权。

## 1. 安全边界

- 浏览器只能使用 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`。
- publishable key 本来就是浏览器公开标识，真正的数据隔离由登录会话、RLS 和 RPC 共同保证。
- 严禁把 `service_role`、数据库密码、访问令牌或私钥放入 `.env`、Cloudflare 前端变量、源码、截图或日志。
- 主系统不开放自助注册；首版仅支持同一教师自己的多设备同步，不支持教师之间共享班级。
- 独立随机抽名页保持离线，不配置 Supabase，也不得添加网络请求。

## 2. 建立 Supabase 项目

1. 新建 Supabase Free 项目，妥善保管项目数据库密码，不写入仓库。
2. 在 Authentication 的 Email 登录配置中关闭公开注册。之后从 Authentication 的 Users 管理页创建教师测试账号。不要把教师密码写入文档。
3. 打开 SQL Editor，完整执行：
   `supabase/migrations/20260811_teacher_database_sync.sql`。
4. 再执行 `supabase/migrations/20260812_v2_payload.sql`，把服务端版本与结构门禁升级到 2.0。
5. 按相同顺序再次执行两份迁移，确认无报错，以验证可重复部署。
6. 在 Table Editor 中确认两张表均显示 RLS 已启用：
   `teacher_databases`、`teacher_database_history`。
7. 从项目 API 设置中复制 Project URL 和 publishable key。不要复制 `service_role` key。

迁移建立以下约束：

- 每个 `auth.users.id` 只能拥有一行当前 JSON 文档。
- 浏览器对当前表和历史表只有“读取本人记录”的权限。
- 浏览器不能直接新增、修改或删除表记录，只能调用
  `save_teacher_database(p_expected_revision, p_payload)`。
- RPC 从 `auth.uid()` 获取 owner，不接受 `owner_id` 参数；过期 revision 以
  `revision_conflict` 拒绝。
- 每次成功覆盖前在同一事务保存旧版本，每名教师只保留最近 20 个历史版本。
- Realtime 只发布当前表，不发布历史表。

## 3. 本地配置与验证

复制 `.env.example` 为 `.env.local`，只填写：

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

然后运行：

```powershell
npm ci
npm run test:all
npm run dev
```

不要提交 `.env.local`。未配置这两个变量时，系统应继续以 v1.1 本地模式运行。

## 4. Cloudflare Pages 部署

将代码仓库连接到 Cloudflare Pages，并配置：

| 项目 | 值 |
| --- | --- |
| 根目录 | `classroom-manager` |
| 构建命令 | `npm ci && npm run build` |
| 输出目录 | `dist` |
| Node.js | `22.13.0` 或更高兼容版本 |

在 Pages 的构建变量中添加 `VITE_SUPABASE_URL` 和
`VITE_SUPABASE_PUBLISHABLE_KEY`。它们会进入浏览器构建产物，因此只能使用
publishable key。不得添加 `service_role`。

保存变量后触发一次新部署。旧构建不会因变量变化自动更新。

## 5. 上线验收

使用一个只含虚构数据的受控教师账号，在两个不同浏览器或两个设备中验证：

1. 两端登录同一账号，A 端修改后，B 端在收到 Realtime 事件后的 3 秒内更新。
2. A 端断网并连续修改，再联网；最终只产生一个有效云端快照，不重复业务记录。
3. 两端同时修改同一 revision；后提交的一端必须进入冲突状态，不能静默覆盖。
4. 退出后页面不能继续显示上一账号数据；未同步时必须先同步或导出备份。
5. 用另一个测试账号登录，确认看不到第一个账号的当前数据和历史数据。
6. 检查浏览器缓存：Service Worker 只能缓存同源静态文件，不能缓存 Supabase REST、Auth、RPC 或 Realtime 响应。
7. 完成一次 JSON 导出与恢复演练，并记录恢复结果。

仅有内存假服务测试通过，不等于真实云端已经上线；必须完成上述双浏览器实测。

## 6. 日常恢复

- 同步失败不等于本机保存失败。先保持页面开启，使用“重试同步”；仍失败时导出本机 JSON。
- 发生冲突时，先分别导出本机版和云端版，再选择保留方向。不要在未备份时覆盖。
- 需要恢复旧版本时，进入“数据健康与恢复”，先点“导出当前本机版本”，再在“云端最近 20 个历史版本”选择“导出此版本”或“恢复为新版本”。系统会先生成本机安全副本，再以 CAS 提交新的主版本；不要直接改历史表。
- Supabase Free 不应被当作自动备份。定期 JSON 导出是独立恢复手段。

## 7. 回滚

### 只回滚前端（首选）

在 Cloudflare Pages 回滚到上一个部署，或移除两个 `VITE_SUPABASE_*` 构建变量后重新构建。应用会回到本地模式；云端表不会被删除，便于修复后恢复同步。

回滚前，先让各设备完成同步或导出本机 JSON。否则不同设备可能各自留下未合并的本地版本。

### 删除云端结构（破坏性，仅在明确弃用时）

先导出 `teacher_databases` 和 `teacher_database_history`，确认可恢复后，再由项目管理员在 SQL Editor 执行：

```sql
begin;

do $block$
begin
  if exists (
    select 1
      from pg_catalog.pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'teacher_databases'
  ) then
    alter publication supabase_realtime drop table public.teacher_databases;
  end if;
end;
$block$;

drop function if exists public.save_teacher_database(bigint, jsonb);
drop table if exists public.teacher_database_history;
drop table if exists public.teacher_databases;

commit;
```

该操作会删除全部云端课堂数据且无法从 Supabase Free 自动恢复；它不是普通故障处理步骤。

## 8. 免费试运行的剩余风险

- 免费服务可能休眠、限额或调整政策，不提供正式生产 SLA。
- 海外服务在校园网络中的延迟和稳定性必须在实际教室网络中验证。
- 浏览器离线缓存可能被系统清理；重要课堂数据仍需定期导出。
- 首版是“整份 JSON 文档”同步，数据量增长后每次同步的传输量会增加。应监控单份 payload 大小和实际同步耗时，再决定是否拆表。
