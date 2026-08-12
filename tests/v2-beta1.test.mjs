import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFictionalDataset, exportDatabase, importDatabaseSafely } from "../src/core.mjs";
import { classifySyncIssue, validateHistoryList, validateHistoryRecord } from "../src/data-health-core.mjs";
import { listSafetyBackups, MemoryCasService, saveSafetyBackup, SYNC_STATUS, SyncCoordinator, UserSyncCache } from "../src/sync-core.mjs";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

function changedData(index) {
  const data = createFictionalDataset();
  data.settings.lastBackupAt = new Date(Date.UTC(2026, 7, 12, 1, 0, index)).toISOString();
  return data;
}

test("100 次云历史恢复均先保存唯一可导入本机副本，再以 CAS 新版本提交且旧历史不变", async () => {
  for (let index = 0; index < 100; index += 1) {
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 7, 12, 0, 0, tick++)).toISOString();
    const service = new MemoryCasService({ now });
    const userId = `teacher-history-${index}`;
    const original = createFictionalDataset();
    await service.seed(userId, original, 1);
    const client = service.createClient(userId);
    const currentWrite = await client.compareAndSwap({ expectedRevision: 1, payload: changedData(index) });
    assert.equal(currentWrite.ok, true);
    const beforeHistory = validateHistoryList(await client.history(), userId);
    const target = beforeHistory[0];
    const storage = new MemoryStorage();
    saveSafetyBackup(storage, userId, currentWrite.record.payload, `history-restore-before-${target.revision}`, now);
    const backups = listSafetyBackups(storage, userId);
    assert.equal(backups.length, 1, "每次恢复前只生成一份安全副本");
    const roundTrip = importDatabaseSafely(exportDatabase(backups[0].payload), original);
    assert.equal(roundTrip.ok, true, "安全副本必须可再次导入");
    assert.deepEqual(roundTrip.data.settings, currentWrite.record.payload.settings);
    assert.deepEqual(roundTrip.data.attendanceSessions, currentWrite.record.payload.attendanceSessions);
    const restored = await client.compareAndSwap({ expectedRevision: currentWrite.record.revision, payload: target.payload });
    assert.equal(restored.ok, true);
    assert.equal(restored.record.revision, 3);
    assert.deepEqual(restored.record.payload, original);
    const afterHistory = await client.history();
    const unchangedTarget = afterHistory.find((item) => item.revision === target.revision);
    assert.ok(unchangedTarget, "目标历史行不得被删除");
    assert.equal(unchangedTarget.owner_id, target.owner_id);
    assert.equal(unchangedTarget.archived_at, target.archived_at);
    assert.deepEqual(unchangedTarget.payload, target.payload, "目标历史行不得被更新");
  }
});

test("恢复期间云端版本变化时，100 次陈旧 revision 全部进入冲突且不覆盖", async () => {
  for (let index = 0; index < 100; index += 1) {
    const service = new MemoryCasService();
    const userId = `teacher-stale-${index}`;
    const original = createFictionalDataset();
    await service.seed(userId, original, 1);
    const client = service.createClient(userId);
    const selectedRevision = (await client.read()).revision;
    const competing = await client.compareAndSwap({ expectedRevision: selectedRevision, payload: changedData(index) });
    assert.equal(competing.ok, true);
    const restore = await client.compareAndSwap({ expectedRevision: selectedRevision, payload: original });
    assert.equal(restore.ok, false);
    assert.equal(restore.conflict, true);
    assert.deepEqual((await client.read()).payload, competing.record.payload);
  }
});

test("100 个畸形或超限云历史快照全部拒绝", () => {
  const userId = "teacher-malformed";
  const large = createFictionalDataset();
  large.untrustedPadding = "x".repeat(4 * 1024 * 1024);
  for (let index = 0; index < 100; index += 1) {
    const candidate = { owner_id: userId, revision: index + 1, archived_at: "2026-08-12T00:00:00.000Z", payload: createFictionalDataset() };
    if (index % 10 === 0) candidate.payload = large;
    else if (index % 3 === 0) candidate.owner_id = "another-teacher";
    else if (index % 3 === 1) candidate.revision = -1;
    else candidate.payload.offerings[0].classId = "missing-class";
    assert.throws(() => validateHistoryRecord(candidate, userId));
  }
});

test("历史列表拒绝跨账号、重复版本及超过 20 条", () => {
  const row = { owner_id: "teacher-a", revision: 1, archived_at: "2026-08-12T00:00:00.000Z", payload: createFictionalDataset() };
  assert.throws(() => validateHistoryList([{ ...row, owner_id: "teacher-b" }], "teacher-a"), /不属于当前账号/);
  assert.throws(() => validateHistoryList([row, structuredClone(row)], "teacher-a"), /版本号重复/);
  assert.throws(() => validateHistoryList(Array.from({ length: 21 }, (_, index) => ({ ...row, revision: index + 1 })), "teacher-a"), /超过 20/);
});

test("网络断开、账号过期、免费服务恢复与冲突给出不同结论和下一步", () => {
  assert.equal(classifySyncIssue({ status: SYNC_STATUS.OFFLINE_PENDING, online: false }).code, "network");
  assert.equal(classifySyncIssue({ status: SYNC_STATUS.FAILED, error: "JWT expired" }).code, "auth");
  assert.equal(classifySyncIssue({ status: SYNC_STATUS.FAILED, error: "project paused" }).code, "service");
  assert.equal(classifySyncIssue({ status: SYNC_STATUS.CONFLICT }).code, "conflict");
  for (const issue of [
    classifySyncIssue({ status: SYNC_STATUS.OFFLINE_PENDING, online: false }),
    classifySyncIssue({ status: SYNC_STATUS.FAILED, error: "JWT expired" }),
    classifySyncIssue({ status: SYNC_STATUS.FAILED, error: "project paused" }),
    classifySyncIssue({ status: SYNC_STATUS.CONFLICT }),
  ]) assert.ok(issue.title && issue.action);
});

test("账号过期与断网均保留本机快照和待同步队列", async () => {
  for (const failure of [Object.assign(new Error("JWT expired"), { code: "AUTH" }), Object.assign(new Error("network offline"), { code: "OFFLINE" })]) {
    const storage = new MemoryStorage();
    const cache = new UserSyncCache(storage);
    const states = [];
    const coordinator = new SyncCoordinator({
      configured: true,
      userId: "teacher-preserved",
      cache,
      remote: {
        async read() { return null; },
        async compareAndSwap() { throw failure; },
        subscribe() { return () => {}; },
      },
      onStateChange(state) { states.push(state); },
    });
    const payload = changedData(failure.code === "AUTH" ? 1 : 2);
    await coordinator.saveLocal(payload);
    assert.deepEqual(cache.current("teacher-preserved").payload, payload);
    assert.ok(cache.loadPending("teacher-preserved"));
    assert.match(states.at(-1).error, /本机数据和待同步修改均已保留/);
    assert.equal(states.at(-1).status, failure.code === "OFFLINE" ? SYNC_STATUS.OFFLINE_PENDING : SYNC_STATUS.FAILED);
  }
});

test("SQL 与适配层把云历史限定为当前账号只读查询，恢复仅写主记录 RPC", async () => {
  const [sql, adapter, hook, main, dataHealth] = await Promise.all([
    readFile(new URL("../supabase/migrations/20260811_teacher_database_sync.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/supabase-adapter.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/use-realtime-sync.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/DataHealth.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(sql, /alter table public\.teacher_database_history enable row level security/i);
  assert.match(sql, /alter table public\.teacher_database_history force row level security/i);
  assert.match(sql, /create policy teacher_database_history_select_own[\s\S]*owner_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /revoke all on table public\.teacher_database_history[\s\S]*grant select on table public\.teacher_database_history to authenticated/i);
  assert.doesNotMatch(sql, /grant (?:update|delete|insert)[^;]*teacher_database_history/i);
  const historyMethod = adapter.slice(adapter.indexOf("async history"), adapter.indexOf("subscribe(onRecord"));
  assert.match(historyMethod, /\.eq\("owner_id", userId\)/);
  assert.doesNotMatch(historyMethod, /update\(|delete\(|insert\(/);
  assert.match(hook, /saveSafetyBackup[\s\S]*saveLocal\(selected\.payload\)/);
  const signInBlock = hook.slice(hook.indexOf("const signIn"), hook.indexOf("const save =", hook.indexOf("const signIn")));
  assert.doesNotMatch(signInBlock, /finally\s*\{\s*setAuthLoading\(false\)/, "登录成功后必须等完整远端初始化结束，不能提前显示空白引导");
  assert.match(main, /DataHealth/);
  assert.match(dataHealth, /恢复会新建版本，不会修改历史行/);
  assert.match(dataHealth, /假服务测试不等于真实云端上线/);
});
