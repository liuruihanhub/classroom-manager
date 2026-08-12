import assert from "node:assert/strict";
import test from "node:test";
import { createFictionalDataset } from "../src/core.mjs";
import {
  MemoryCasService, SYNC_STATUS, SyncCoordinator, UserSyncCache, canSignOut, classifyInitialMigration, createSyncState,
  isDecisionFresh, isSyncConfigured, listSafetyBackups, saveSafetyBackup, transitionSyncState, validateRemoteRecord,
} from "../src/sync-core.mjs";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function fixture(teacherName = "虚构测试教师") {
  const data = createFictionalDataset();
  data.settings.teacherName = teacherName;
  return data;
}

function monotonicClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 11, 0, 0, tick++)).toISOString();
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("配置判断与七种同步状态均有确定状态机出口", () => {
  assert.equal(isSyncConfigured({}), false);
  assert.equal(isSyncConfigured({ VITE_SUPABASE_URL: "https://example.supabase.co" }), false);
  assert.equal(isSyncConfigured({ VITE_SUPABASE_URL: "javascript:alert(1)", VITE_SUPABASE_PUBLISHABLE_KEY: "x" }), false);
  assert.equal(isSyncConfigured({ VITE_SUPABASE_URL: "http://example.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "x" }), false);
  assert.equal(isSyncConfigured({ VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_PUBLISHABLE_KEY: "public-test-value" }), true);
  assert.equal(isSyncConfigured({ VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "public-test-value" }), true);
  assert.equal(createSyncState().status, SYNC_STATUS.UNCONFIGURED);
  let state = createSyncState({ configured: true });
  assert.equal(state.status, SYNC_STATUS.SIGNED_OUT);
  state = transitionSyncState(state, { type: "SYNC_START" });
  assert.equal(state.status, SYNC_STATUS.SYNCING);
  state = transitionSyncState(state, { type: "SYNC_SUCCESS", at: "2026-08-11T00:00:00.000Z", realtimeConnected: true });
  assert.equal(state.status, SYNC_STATUS.SYNCED);
  state = transitionSyncState(state, { type: "LOCAL_PENDING", online: false });
  assert.equal(state.status, SYNC_STATUS.OFFLINE_PENDING);
  state = transitionSyncState(state, { type: "CONFLICT", conflict: { local: {}, remote: {} } });
  assert.equal(state.status, SYNC_STATUS.CONFLICT);
  state = transitionSyncState(state, { type: "FAILURE", message: "x" });
  assert.equal(state.status, SYNC_STATUS.FAILED);
  state = transitionSyncState(state, { type: "UNCONFIGURED" });
  assert.equal(state.status, SYNC_STATUS.UNCONFIGURED);
});

test("退出保护必须先消除待同步/决策，或明确导出本机备份", () => {
  assert.equal(canSignOut(), true);
  assert.equal(canSignOut({ hasPending: true }), false);
  assert.equal(canSignOut({ hasDecision: true }), false);
  assert.equal(canSignOut({ hasPending: true, backupReady: true }), true);
  assert.equal(canSignOut({ hasDecision: true, backupReady: true }), true);
});

test("冲突覆盖前的本机安全副本采用暂存校验并保存完整有效数据", () => {
  const storage = new MemoryStorage();
  const key = saveSafetyBackup(storage, "safety-teacher", fixture("待保护本机版"), "resolve-remote", () => "2026-08-11T08:00:00.000Z");
  assert.match(key, /workbuddy\.classroom\.v1\.2\.safety/);
  assert.equal(storage.getItem(`${key}.writing`), null);
  const saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.reason, "resolve-remote");
  assert.equal(saved.payload.settings.teacherName, "待保护本机版");
  const secondKey = saveSafetyBackup(storage, "safety-teacher", fixture("第二份"), "resolve-local", () => "2026-08-11T08:00:00.000Z");
  assert.notEqual(secondKey, key, "同一毫秒的安全副本也不得互相覆盖");
  saveSafetyBackup(storage, "safety-teacher", fixture("第三份"), "resolve-local", () => "2026-08-11T08:00:01.000Z");
  saveSafetyBackup(storage, "safety-teacher", fixture("第四份"), "resolve-local", () => "2026-08-11T08:00:02.000Z");
  saveSafetyBackup(storage, "other-teacher", fixture("其他账号"), "resolve-local", () => "2026-08-11T08:00:03.000Z");
  const retained = listSafetyBackups(storage, "safety-teacher");
  assert.equal(retained.length, 3, "每个账号只保留最近三份，避免本机空间无界增长");
  assert.equal(retained[0].payload.settings.teacherName, "第四份");
  assert.equal(listSafetyBackups(storage, "other-teacher").length, 1, "安全副本必须按账号隔离");
});

test("本机正式键写入失败时保留暂存副本并拒绝报告成功", () => {
  class RejectFinalStorage extends MemoryStorage {
    setItem(key, value) { if (String(key).endsWith(".writing")) super.setItem(key, value); }
  }
  const storage = new RejectFinalStorage();
  const cache = new UserSyncCache(storage, { now: monotonicClock() });
  assert.throws(() => cache.saveSnapshot("write-failure", fixture(), 0), /正式写入校验失败/);
  assert.equal([...storage.values.keys()].some((key) => key.endsWith(".writing")), true, "恢复所需暂存副本必须保留");
});

test("冲突确认期间云端 revision 变化必须使原决策失效", () => {
  assert.equal(isDecisionFresh(null, null), true);
  assert.equal(isDecisionFresh({ revision: 4 }, { revision: 4 }), true);
  assert.equal(isDecisionFresh({ revision: 4 }, { revision: 5 }), false);
  assert.equal(isDecisionFresh(null, { revision: 1 }), false);
});

test("首次迁移只在人工选择、相同数据复用或冲突三条安全路径中前进", () => {
  const local = fixture("本机旧数据");
  const same = { payload: structuredClone(local), revision: 1 };
  const different = { payload: fixture("云端不同数据"), revision: 1 };
  assert.equal(classifyInitialMigration({ alreadyMigrated: true, hasLegacyData: true, legacyPayload: local, remoteRecord: different }), "normal");
  assert.equal(classifyInitialMigration({ hasLegacyData: false }), "normal");
  assert.equal(classifyInitialMigration({ hasLegacyData: true, legacyPayload: local, remoteRecord: null }), "choose-local-or-empty");
  assert.equal(classifyInitialMigration({ hasLegacyData: true, legacyPayload: local, remoteRecord: same }), "same");
  assert.equal(classifyInitialMigration({ hasLegacyData: true, legacyPayload: local, remoteRecord: different }), "conflict");
});

test("未配置云端时保持本地回退，不要求账号或远端适配器", async () => {
  const coordinator = new SyncCoordinator({ configured: false });
  assert.equal((await coordinator.start()).status, SYNC_STATUS.UNCONFIGURED);
  const data = fixture();
  const result = await coordinator.saveLocal(data);
  assert.equal(result.localOnly, true);
  assert.equal(result.payload.settings.teacherName, "虚构测试教师");
});

test("云端记录意外缺失时本机快照进入冲突，不得误报已同步", async () => {
  const userId = "missing-cloud-teacher";
  const cache = new UserSyncCache(new MemoryStorage(), { now: monotonicClock() });
  cache.saveSnapshot(userId, fixture("必须保留的本机快照"), 4);
  const remote = { async read() { return null; }, subscribe(_record, onStatus) { onStatus(true); return () => {}; } };
  const coordinator = new SyncCoordinator({ configured: true, userId, cache, remote });
  await coordinator.start();
  assert.equal(coordinator.state.status, SYNC_STATUS.CONFLICT);
  assert.equal(coordinator.state.conflict.local.revision, 4);
  assert.equal(coordinator.state.conflict.remote, null);
  assert.equal(cache.loadSnapshot(userId).payload.settings.teacherName, "必须保留的本机快照");
  coordinator.stop();
});

test("本地缓存按账号隔离，待同步队列只保留最终快照", () => {
  const storage = new MemoryStorage();
  const cache = new UserSyncCache(storage, { now: monotonicClock() });
  cache.saveSnapshot("teacher-a", fixture("教师甲"), 3);
  cache.saveSnapshot("teacher-b", fixture("教师乙"), 8);
  assert.equal(cache.loadSnapshot("teacher-a").payload.settings.teacherName, "教师甲");
  assert.equal(cache.loadSnapshot("teacher-b").payload.settings.teacherName, "教师乙");
  for (let index = 1; index <= 100; index += 1) {
    const data = fixture(`离线修改${index}`);
    cache.stage("teacher-a", data, 3);
  }
  const pending = cache.loadPending("teacher-a");
  assert.equal(pending.generation, 100);
  assert.equal(pending.expectedRevision, 3);
  assert.equal(pending.payload.settings.teacherName, "离线修改100");
  assert.equal([...storage.values.keys()].filter((key) => key.endsWith(".pending")).length, 1);
  assert.equal(cache.loadPending("teacher-b"), null);
});

test("正常同步与 Realtime 事件只应用更高 revision", async () => {
  const service = new MemoryCasService({ now: monotonicClock() });
  const cacheA = new UserSyncCache(new MemoryStorage(), { now: monotonicClock() });
  const cacheB = new UserSyncCache(new MemoryStorage(), { now: monotonicClock() });
  const appliedB = [];
  const a = new SyncCoordinator({ configured: true, userId: "same-teacher", cache: cacheA, remote: service.createClient("same-teacher"), now: monotonicClock() });
  const b = new SyncCoordinator({ configured: true, userId: "same-teacher", cache: cacheB, remote: service.createClient("same-teacher"), onApplyRemote: (payload) => appliedB.push(payload), now: monotonicClock() });
  await Promise.all([a.start(), b.start()]);
  await a.saveLocal(fixture("设备甲保存"));
  await settle();
  assert.equal(service.inspectForTest("same-teacher").revision, 1);
  assert.equal(service.metrics.writes, 1);
  assert.equal(appliedB.at(-1).settings.teacherName, "设备甲保存");
  assert.equal(cacheB.loadSnapshot("same-teacher").revision, 1);
  assert.equal(b.state.status, SYNC_STATUS.SYNCED);
  assert.equal(await b.acceptRemote(service.inspectForTest("same-teacher")), false, "相同 revision 不应重复应用");
  assert.equal(appliedB.length, 1);
  a.stop(); b.stop();
});

test("重复、乱序与上传中的自回声均不会重复应用或制造上传回环", async () => {
  const userId = "realtime-order-teacher";
  const storage = new MemoryStorage();
  const cache = new UserSyncCache(storage, { now: monotonicClock() });
  cache.saveSnapshot(userId, fixture("revision-1"), 1, "2026-08-11T00:00:00.000Z");
  const applied = [];
  let finishCas;
  const remote = {
    async read() { return { owner_id: userId, revision: 1, updated_at: "2026-08-11T00:00:00.000Z", payload: fixture("revision-1") }; },
    compareAndSwap() { return new Promise((resolve) => { finishCas = resolve; }); },
    subscribe(_record, onStatus) { onStatus(true); return () => {}; },
  };
  const coordinator = new SyncCoordinator({ configured: true, userId, cache, remote, onApplyRemote: (payload) => applied.push(payload.settings.teacherName) });
  await coordinator.start();
  const revision2 = { owner_id: userId, revision: 2, updated_at: "2026-08-11T00:00:01.000Z", payload: fixture("revision-2") };
  assert.equal(await coordinator.acceptRemote(revision2), true);
  assert.equal(await coordinator.acceptRemote(revision2), false);
  assert.equal(await coordinator.acceptRemote({ ...revision2, revision: 1 }), false);
  assert.deepEqual(applied, ["revision-2"]);

  const upload = coordinator.saveLocal(fixture("本机 revision-3"));
  const selfEcho = { owner_id: userId, revision: 3, updated_at: "2026-08-11T00:00:02.000Z", payload: fixture("本机 revision-3") };
  assert.equal(await coordinator.acceptRemote(selfEcho), false, "CAS 未完成时的 Realtime 回声应交给 CAS 响应处理");
  assert.notEqual(coordinator.state.status, SYNC_STATUS.CONFLICT);
  finishCas({ ok: true, record: selfEcho });
  await upload;
  assert.equal(coordinator.state.status, SYNC_STATUS.SYNCED);
  assert.deepEqual(applied, ["revision-2"]);
  coordinator.stop();
});

test("连续100次离线修改重连后只写入一个最终云端快照", async () => {
  const service = new MemoryCasService({ now: monotonicClock() });
  const cache = new UserSyncCache(new MemoryStorage(), { now: monotonicClock() });
  const coordinator = new SyncCoordinator({ configured: true, userId: "offline-teacher", cache, remote: service.createClient("offline-teacher"), now: monotonicClock() });
  await coordinator.start();
  service.setOnline(false);
  for (let index = 1; index <= 100; index += 1) await coordinator.saveLocal(fixture(`离线最终值-${index}`));
  assert.equal(coordinator.state.status, SYNC_STATUS.OFFLINE_PENDING);
  assert.equal(cache.loadPending("offline-teacher").generation, 100);
  assert.equal(service.metrics.writes, 0);
  service.setOnline(true);
  await settle();
  await coordinator.flush();
  assert.equal(service.metrics.writes, 1);
  assert.equal(service.inspectForTest("offline-teacher").payload.settings.teacherName, "离线最终值-100");
  assert.equal(cache.loadPending("offline-teacher"), null);
  assert.equal(coordinator.state.status, SYNC_STATUS.SYNCED);
  coordinator.stop();
});

test("在线短防抖仍立即保存本地，但只上传最终快照", async () => {
  const service = new MemoryCasService({ now: monotonicClock() });
  const cache = new UserSyncCache(new MemoryStorage(), { now: monotonicClock() });
  const coordinator = new SyncCoordinator({ configured: true, userId: "debounce-teacher", cache, remote: service.createClient("debounce-teacher"), debounceMs: 20 });
  await coordinator.start();
  for (let index = 1; index <= 20; index += 1) await coordinator.saveLocal(fixture(`防抖值-${index}`));
  assert.equal(cache.loadPending("debounce-teacher").payload.settings.teacherName, "防抖值-20", "定时上传前本地最终值必须已经落盘");
  assert.equal(service.metrics.writes, 0);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(service.metrics.writes, 1);
  assert.equal(service.inspectForTest("debounce-teacher").payload.settings.teacherName, "防抖值-20");
  coordinator.stop();
});

test("100次过期 revision 写入全部拒绝且静默覆盖为0", async () => {
  const service = new MemoryCasService({ now: monotonicClock() });
  await service.seed("cas-teacher", fixture("云端原值"), 7);
  const client = service.createClient("cas-teacher");
  for (let index = 0; index < 100; index += 1) {
    const result = await client.compareAndSwap({ expectedRevision: 6, payload: fixture(`攻击写入${index}`) });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(result.record.revision, 7);
  }
  assert.equal(service.metrics.conflicts, 100);
  assert.equal(service.metrics.writes, 0);
  assert.equal(service.inspectForTest("cas-teacher").payload.settings.teacherName, "云端原值");
});

test("revision 冲突进入冲突态并保留本地待同步快照", async () => {
  const service = new MemoryCasService({ now: monotonicClock() });
  await service.seed("conflict-teacher", fixture("云端v1"), 1);
  const cache = new UserSyncCache(new MemoryStorage(), { now: monotonicClock() });
  cache.saveSnapshot("conflict-teacher", fixture("本地基线"), 0);
  cache.stage("conflict-teacher", fixture("本地未同步"), 0);
  const coordinator = new SyncCoordinator({ configured: true, userId: "conflict-teacher", cache, remote: service.createClient("conflict-teacher") });
  await coordinator.start();
  assert.equal(coordinator.state.status, SYNC_STATUS.CONFLICT);
  assert.equal(coordinator.state.conflict.local.revision, 0);
  assert.equal(coordinator.state.conflict.remote.revision, 1);
  assert.equal(cache.loadPending("conflict-teacher").payload.settings.teacherName, "本地未同步");
  assert.equal(cache.loadSnapshot("conflict-teacher").payload.settings.teacherName, "本地未同步");
  coordinator.stop();
});

test("相同 revision 但本地与云端内容不同也必须进入冲突态", async () => {
  const service = new MemoryCasService({ now: monotonicClock() });
  await service.seed("equal-revision", fixture("云端内容"), 5);
  const cache = new UserSyncCache(new MemoryStorage(), { now: monotonicClock() });
  cache.saveSnapshot("equal-revision", fixture("本地内容"), 5);
  const coordinator = new SyncCoordinator({ configured: true, userId: "equal-revision", cache, remote: service.createClient("equal-revision") });
  await coordinator.start();
  assert.equal(coordinator.state.status, SYNC_STATUS.CONFLICT);
  assert.equal(coordinator.state.conflict.local.revision, 5);
  assert.equal(coordinator.state.conflict.remote.revision, 5);
  assert.equal(cache.loadSnapshot("equal-revision").payload.settings.teacherName, "本地内容");
  assert.equal(service.inspectForTest("equal-revision").payload.settings.teacherName, "云端内容");
  coordinator.stop();
});

test("100份畸形远端 payload 全部拒绝且本地最后有效副本不变", async () => {
  const userId = "payload-teacher";
  const service = new MemoryCasService({ now: monotonicClock() });
  const storage = new MemoryStorage();
  const cache = new UserSyncCache(storage, { now: monotonicClock() });
  cache.saveSnapshot(userId, fixture("本地安全副本"), 3);
  const coordinator = new SyncCoordinator({ configured: true, userId, cache, remote: service.createClient(userId) });
  const before = JSON.stringify(cache.loadSnapshot(userId));
  for (let index = 0; index < 100; index += 1) {
    const malformed = index % 4 === 0 ? null : index % 4 === 1 ? {} : index % 4 === 2 ? { ...fixture(), version: "99" } : (() => { const data = fixture(); delete data.settings; return data; })();
    const accepted = await coordinator.acceptRemote({ owner_id: userId, revision: 4 + index, updated_at: "2026-08-11T00:00:00.000Z", payload: malformed });
    assert.equal(accepted, false);
  }
  assert.equal(JSON.stringify(cache.loadSnapshot(userId)), before);
  assert.equal(coordinator.state.status, SYNC_STATUS.FAILED);
  assert.match(coordinator.state.error, /云端数据未通过校验|收到的云端数据未通过校验/);
});

test("远端记录账号不匹配被拒绝，内存客户端无法指定或伪造 owner_id", async () => {
  const service = new MemoryCasService({ now: monotonicClock() });
  await service.seed("teacher-a", fixture("账号甲"), 1);
  await service.seed("teacher-b", fixture("账号乙"), 9);
  const clientA = service.createClient("teacher-a");
  assert.equal((await clientA.read()).payload.settings.teacherName, "账号甲");
  const written = await clientA.compareAndSwap({ expectedRevision: 1, owner_id: "teacher-b", payload: fixture("甲的新值") });
  assert.equal(written.record.owner_id, "teacher-a");
  assert.equal(service.inspectForTest("teacher-b").payload.settings.teacherName, "账号乙");
  assert.throws(() => validateRemoteRecord(service.inspectForTest("teacher-b"), "teacher-a"), /不属于当前账号/);
});
