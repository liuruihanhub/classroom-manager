import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFictionalDataset } from "../src/core.mjs";
import { createSupabaseAdapter, readSupabaseConfig, safeMessage } from "../src/supabase-adapter.mjs";

test("浏览器配置只接受完整安全 URL 与 publishable key，不兼容旧 anon 变量", () => {
  assert.equal(readSupabaseConfig({}).configured, false);
  assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_ANON_KEY: "legacy" }).configured, false);
  assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: "http://project.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "public" }).configured, false);
  assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "public" }).configured, true);
  assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "" }).invalid, true);
});

test("Supabase 适配层的 CAS 不发送 owner_id，读与 Realtime 都限定当前用户", async () => {
  const calls = { rpc: null, filters: [], channel: null };
  const payload = createFictionalDataset();
  const record = { owner_id: "teacher-a", payload, revision: 4, created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z" };
  const client = {
    auth: {
      async getSession() { return { data: { session: null }, error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword() { return { data: { session: { user: { id: "teacher-a" } } }, error: null }; },
      async signOut() { return { error: null }; },
    },
    from(table) {
      const builder = {
        select() { return builder; },
        eq(column, value) { calls.filters.push([table, column, value]); return builder; },
        order() { return builder; },
        limit: async () => ({ data: [{ owner_id: "teacher-a", payload, revision: 3, archived_at: "2026-08-10T00:00:00.000Z" }], error: null }),
        maybeSingle: async () => ({ data: record, error: null }),
      };
      return builder;
    },
    async rpc(name, args) { calls.rpc = { name, args }; return { data: [{ ...record, revision: 5 }], error: null }; },
    channel(name) {
      calls.channel = { name };
      return {
        on(_kind, filter) { calls.channel.filter = filter; return this; },
        subscribe(callback) { callback("SUBSCRIBED"); return this; },
      };
    },
    removeChannel() {},
  };
  const adapter = createSupabaseAdapter({ url: "https://project.supabase.co", publishableKey: "public-test" }, { clientFactory: () => client });
  const remote = adapter.forUser("teacher-a");
  assert.equal((await remote.read()).revision, 4);
  const saved = await remote.compareAndSwap({ expectedRevision: 4, payload });
  assert.equal(saved.record.revision, 5);
  assert.deepEqual(Object.keys(calls.rpc.args).sort(), ["p_expected_revision", "p_payload"]);
  assert.equal(calls.rpc.name, "save_teacher_database");
  await remote.history();
  const unsubscribe = remote.subscribe(() => {}, () => {});
  unsubscribe();
  assert.deepEqual(calls.filters, [
    ["teacher_databases", "owner_id", "teacher-a"],
    ["teacher_database_history", "owner_id", "teacher-a"],
  ]);
  assert.equal(calls.channel.filter.filter, "owner_id=eq.teacher-a");
  assert.doesNotMatch(JSON.stringify(calls.rpc.args), /owner_id/);
});

test("适配层错误只返回受控信息，不回显远端 payload 或 SQL", () => {
  assert.equal(safeMessage({ code: "40001", message: "revision_conflict details" }), "revision_conflict");
  assert.equal(safeMessage({ message: "invalid login credentials: private detail" }), "邮箱或密码错误");
  assert.equal(safeMessage({ message: "select payload from private table" }), "云同步请求失败");
});

test("SQL 同时具备 RLS、最小权限、auth.uid CAS、4MiB/版本结构门禁与20版历史", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260811_teacher_database_sync.sql", import.meta.url), "utf8");
  assert.match(sql, /force row level security/gi);
  assert.match(sql, /create or replace function public\.save_teacher_database\(\s*p_expected_revision bigint,\s*p_payload jsonb\s*\)/i);
  const rpcArguments = sql.match(/create or replace function public\.save_teacher_database\(([\s\S]*?)\)\s*returns/i)?.[1] ?? "";
  assert.doesNotMatch(rpcArguments, /owner_id/i);
  assert.match(sql, /v_owner_id uuid := auth\.uid\(\)/i);
  assert.match(sql, /revoke all on table public\.teacher_databases from public, anon, authenticated/i);
  assert.match(sql, /grant select on table public\.teacher_databases to authenticated/i);
  assert.match(sql, /octet_length\(p_payload::text\) > 4194304/i);
  assert.match(sql, /p_payload->>'version' is distinct from '1\.1'/i);
  assert.match(sql, /jsonb_typeof\(p_payload->'attendanceSessions'\) is distinct from 'array'/i);
  assert.match(sql, /offset 20/i);
  assert.match(sql, /replica identity full/i);
  assert.doesNotMatch(sql, /create policy[\s\S]{0,180}for (?:insert|update|delete)/i);
});

test("Service Worker 明确绕过 Supabase；独立单页不含同步 SDK、配置或网络调用", async () => {
  const [worker, standalone] = await Promise.all([
    readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../deliverables/独立随机抽名.html", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /isSupabaseTraffic/);
  assert.match(worker, /if \(isSupabaseTraffic\) return/);
  assert.match(worker, /event\.request\.mode === "navigate"[\s\S]*fetch\(event\.request\)[\s\S]*caches\.match\("\.\/index\.html"\)/);
  assert.doesNotMatch(standalone, /supabase|VITE_SUPABASE|publishableKey|service_role|fetch\s*\(|XMLHttpRequest|WebSocket/i);
  assert.doesNotMatch(standalone, /<(?:script|link)\b[^>]+(?:src|href)=/i);
});
