import { migrateAndValidateDatabase } from "./core.mjs";

export const SYNC_STATUS = Object.freeze({
  UNCONFIGURED: "未配置云同步",
  SIGNED_OUT: "未登录",
  SYNCING: "正在同步",
  SYNCED: "已同步",
  OFFLINE_PENDING: "离线，存在待同步修改",
  CONFLICT: "同步冲突",
  FAILED: "同步失败，可重试",
});

const DEFAULT_PREFIX = "workbuddy.classroom.v1.2.sync";
export const MAX_SYNC_PAYLOAD_BYTES = 4 * 1024 * 1024;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function samePayload(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function validateSyncPayload(candidate, validate = migrateAndValidateDatabase) {
  const payload = validate(candidate);
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_SYNC_PAYLOAD_BYTES) throw new Error("同步数据超过 4 MiB 限制，请先导出 JSON 并精简历史数据");
  return payload;
}

export function canSignOut({ hasPending = false, hasDecision = false, backupReady = false } = {}) {
  return !(hasPending || hasDecision) || backupReady;
}

export function isDecisionFresh(shownRemoteSummary, latestRemoteRecord) {
  return (shownRemoteSummary?.revision ?? 0) === (latestRemoteRecord?.revision ?? 0);
}

export function classifyInitialMigration({ alreadyMigrated = false, hasLegacyData = false, legacyPayload = null, remoteRecord = null } = {}) {
  if (alreadyMigrated || !hasLegacyData) return "normal";
  if (!remoteRecord) return "choose-local-or-empty";
  return samePayload(legacyPayload, remoteRecord.payload) ? "same" : "conflict";
}

export function saveSafetyBackup(storage, userId, payload, reason, now = () => new Date().toISOString()) {
  const validated = validateSyncPayload(payload);
  const createdAt = now();
  const baseKey = `workbuddy.classroom.v1.2.safety.${encodeURIComponent(assertUserId(userId))}.${Date.parse(createdAt) || Date.now()}`;
  let key = baseKey;
  for (let suffix = 1; storage.getItem(key) !== null; suffix += 1) key = `${baseKey}.${suffix}`;
  const temporaryKey = `${key}.writing`;
  const serialized = JSON.stringify({ createdAt, reason: String(reason), payload: validated });
  storage.setItem(temporaryKey, serialized);
  if (storage.getItem(temporaryKey) !== serialized) throw new Error("本机安全副本写入校验失败");
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("本机安全副本正式写入校验失败");
  storage.removeItem(temporaryKey);
  for (const old of listSafetyBackups(storage, userId).slice(3)) storage.removeItem(old.key);
  return key;
}

export function listSafetyBackups(storage, userId) {
  const prefix = `workbuddy.classroom.v1.2.safety.${encodeURIComponent(assertUserId(userId))}.`;
  const backups = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix) || key.endsWith(".writing")) continue;
    try {
      const value = JSON.parse(storage.getItem(key));
      if (!validTimestamp(value?.createdAt) || typeof value?.reason !== "string") continue;
      backups.push({ key, createdAt: value.createdAt, reason: value.reason, payload: validateSyncPayload(value.payload) });
    } catch { /* A damaged safety entry must not block access to other valid copies. */ }
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.key.localeCompare(left.key));
}

function assertUserId(userId) {
  if (typeof userId !== "string" || !userId.trim() || userId.length > 256) throw new Error("无效的同步账号");
  return userId;
}

function assertRevision(revision, label = "revision") {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`${label} 必须是非负安全整数`);
  return revision;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效`);
}

function validTimestamp(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export function isSyncConfigured(environment = {}) {
  const url = String(environment.VITE_SUPABASE_URL ?? "").trim();
  const key = String(environment.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (!url || !key) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname));
  } catch { return false; }
}

export function createSyncState({ configured = false, userId = null } = {}) {
  return {
    status: !configured ? SYNC_STATUS.UNCONFIGURED : userId ? SYNC_STATUS.SYNCING : SYNC_STATUS.SIGNED_OUT,
    lastSyncedAt: null,
    realtimeConnected: false,
    error: null,
    conflict: null,
  };
}

export function transitionSyncState(state, event) {
  const next = { ...state, error: null };
  switch (event.type) {
    case "UNCONFIGURED": return { ...createSyncState(), status: SYNC_STATUS.UNCONFIGURED };
    case "SIGNED_OUT": return { ...createSyncState({ configured: true }), status: SYNC_STATUS.SIGNED_OUT };
    case "SYNC_START": return { ...next, status: SYNC_STATUS.SYNCING, conflict: null };
    case "SYNC_SUCCESS": return { ...next, status: SYNC_STATUS.SYNCED, lastSyncedAt: event.at, conflict: null, realtimeConnected: event.realtimeConnected ?? next.realtimeConnected };
    case "LOCAL_PENDING": return { ...next, status: event.online ? SYNC_STATUS.SYNCING : SYNC_STATUS.OFFLINE_PENDING, conflict: null };
    case "CONNECTION": {
      if (event.connected) return { ...next, realtimeConnected: true };
      return { ...next, realtimeConnected: false, status: event.hasPending ? SYNC_STATUS.OFFLINE_PENDING : SYNC_STATUS.FAILED, error: event.hasPending ? "网络连接已断开；修改已保存在本机，联网后请点“重试”" : "实时连接已断开；本机数据未改变，请检查网络后点“重试”" };
    }
    case "CONFLICT": return { ...next, status: SYNC_STATUS.CONFLICT, conflict: clone(event.conflict), realtimeConnected: event.realtimeConnected ?? next.realtimeConnected };
    case "FAILURE": return { ...next, status: event.offline && event.hasPending ? SYNC_STATUS.OFFLINE_PENDING : SYNC_STATUS.FAILED, error: event.message || "同步失败", realtimeConnected: event.offline ? false : next.realtimeConnected };
    default: throw new Error(`未知同步状态事件：${event.type}`);
  }
}

export function validateRemoteRecord(candidate, expectedOwnerId, validate = migrateAndValidateDatabase) {
  assertPlainObject(candidate, "远端记录");
  const ownerId = assertUserId(candidate.owner_id);
  if (expectedOwnerId !== undefined && ownerId !== assertUserId(expectedOwnerId)) throw new Error("远端记录不属于当前账号");
  const revision = assertRevision(candidate.revision);
  if (!validTimestamp(candidate.updated_at)) throw new Error("远端更新时间无效");
  return { owner_id: ownerId, revision, updated_at: candidate.updated_at, payload: validateSyncPayload(candidate.payload, validate) };
}

export function summarizeSyncRecord(record) {
  if (!record) return null;
  const payload = record.payload;
  return {
    revision: record.revision,
    updatedAt: record.updated_at ?? record.updatedAt ?? null,
    classCount: payload.classes.length,
    studentCount: payload.semesterRosters.reduce((sum, roster) => sum + roster.students.length, 0),
    attendanceCount: payload.attendanceSessions.length,
  };
}

export class UserSyncCache {
  constructor(storage, { prefix = DEFAULT_PREFIX, validate = migrateAndValidateDatabase, now = () => new Date().toISOString() } = {}) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") throw new Error("同步缓存需要 localStorage 兼容接口");
    this.storage = storage;
    this.prefix = prefix;
    this.validate = validate;
    this.now = now;
  }

  key(userId, kind) {
    return `${this.prefix}.${encodeURIComponent(assertUserId(userId))}.${kind}`;
  }

  readJson(key) {
    const raw = this.storage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  }

  writeJsonAtomically(key, value) {
    const temporaryKey = `${key}.writing`;
    const serialized = JSON.stringify(value);
    this.storage.setItem(temporaryKey, serialized);
    const verified = this.storage.getItem(temporaryKey);
    if (verified !== serialized) throw new Error("本地同步缓存写入校验失败");
    this.storage.setItem(key, verified);
    if (this.storage.getItem(key) !== serialized) throw new Error("本地同步缓存正式写入校验失败");
    this.storage.removeItem(temporaryKey);
  }

  loadSnapshot(userId) {
    const value = this.readJson(this.key(userId, "snapshot"));
    if (!value) return null;
    assertPlainObject(value, "本地同步快照");
    assertRevision(value.revision);
    if (!validTimestamp(value.updatedAt)) throw new Error("本地同步快照时间无效");
    return { revision: value.revision, updatedAt: value.updatedAt, payload: this.validate(value.payload) };
  }

  saveSnapshot(userId, payload, revision = 0, updatedAt = this.now()) {
    const record = { revision: assertRevision(revision), updatedAt, payload: validateSyncPayload(payload, this.validate) };
    if (!validTimestamp(record.updatedAt)) throw new Error("本地同步快照时间无效");
    this.writeJsonAtomically(this.key(userId, "snapshot"), record);
    return clone(record);
  }

  loadPending(userId) {
    const value = this.readJson(this.key(userId, "pending"));
    if (!value) return null;
    assertPlainObject(value, "待同步快照");
    assertRevision(value.expectedRevision, "expectedRevision");
    if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error("待同步快照代次无效");
    if (!validTimestamp(value.queuedAt)) throw new Error("待同步快照时间无效");
    return { ...value, payload: validateSyncPayload(value.payload, this.validate) };
  }

  stage(userId, payload, expectedRevision) {
    const current = this.loadPending(userId);
    const pending = {
      expectedRevision: current?.expectedRevision ?? assertRevision(expectedRevision, "expectedRevision"),
      generation: (current?.generation ?? 0) + 1,
      queuedAt: this.now(),
      payload: validateSyncPayload(payload, this.validate),
    };
    this.writeJsonAtomically(this.key(userId, "pending"), pending);
    this.saveSnapshot(userId, pending.payload, current?.expectedRevision ?? expectedRevision, pending.queuedAt);
    return clone(pending);
  }

  finishUpload(userId, sentGeneration, remoteRecord) {
    const remote = validateRemoteRecord(remoteRecord, userId, this.validate);
    const current = this.loadPending(userId);
    if (current && current.generation !== sentGeneration) {
      const rebased = { ...current, expectedRevision: remote.revision };
      this.writeJsonAtomically(this.key(userId, "pending"), rebased);
      this.saveSnapshot(userId, rebased.payload, remote.revision, rebased.queuedAt);
      return { pending: clone(rebased), snapshot: this.loadSnapshot(userId) };
    }
    this.storage.removeItem(this.key(userId, "pending"));
    const snapshot = this.saveSnapshot(userId, remote.payload, remote.revision, remote.updated_at);
    return { pending: null, snapshot };
  }

  replaceFromRemote(userId, remoteRecord) {
    const remote = validateRemoteRecord(remoteRecord, userId, this.validate);
    if (this.loadPending(userId)) throw new Error("存在待同步修改，不能直接应用远端数据");
    return this.saveSnapshot(userId, remote.payload, remote.revision, remote.updated_at);
  }

  current(userId) {
    const pending = this.loadPending(userId);
    return pending ? { payload: clone(pending.payload), revision: pending.expectedRevision, pending: true } : (() => {
      const snapshot = this.loadSnapshot(userId);
      return snapshot ? { payload: clone(snapshot.payload), revision: snapshot.revision, pending: false } : null;
    })();
  }

  clearPending(userId) {
    this.storage.removeItem(this.key(userId, "pending"));
  }
}

export class MemoryCasService {
  constructor({ validate = migrateAndValidateDatabase, now = () => new Date().toISOString() } = {}) {
    this.validate = validate;
    this.now = now;
    this.records = new Map();
    this.histories = new Map();
    this.listeners = new Map();
    this.online = true;
    this.metrics = { attempts: 0, writes: 0, conflicts: 0 };
  }

  requireOnline() {
    if (!this.online) { const error = new Error("网络不可用"); error.code = "OFFLINE"; throw error; }
  }

  async seed(userId, payload, revision = 1) {
    const owner = assertUserId(userId);
    const record = { owner_id: owner, payload: validateSyncPayload(payload, this.validate), revision: assertRevision(revision), updated_at: this.now() };
    this.records.set(owner, record);
    return clone(record);
  }

  createClient(userId) {
    const owner = assertUserId(userId);
    const service = this;
    return Object.freeze({
      ownerId: owner,
      async read() {
        service.requireOnline();
        return clone(service.records.get(owner) ?? null);
      },
      async compareAndSwap({ expectedRevision, payload }) {
        service.requireOnline();
        service.metrics.attempts += 1;
        const expected = assertRevision(expectedRevision, "expectedRevision");
        const current = service.records.get(owner) ?? null;
        const actual = current?.revision ?? 0;
        if (expected !== actual) {
          service.metrics.conflicts += 1;
          return { ok: false, conflict: true, record: clone(current) };
        }
        if (current) {
          const history = service.histories.get(owner) ?? [];
          history.unshift({ owner_id: owner, payload: clone(current.payload), revision: current.revision, archived_at: service.now() });
          service.histories.set(owner, history.slice(0, 20));
        }
        const record = { owner_id: owner, payload: validateSyncPayload(payload, service.validate), revision: actual + 1, updated_at: service.now() };
        service.records.set(owner, record);
        service.metrics.writes += 1;
        queueMicrotask(() => service.emit(owner, record));
        return { ok: true, record: clone(record) };
      },
      async history(limit = 20) {
        service.requireOnline();
        const safeLimit = Number.isSafeInteger(limit) ? Math.min(20, Math.max(1, limit)) : 20;
        return clone((service.histories.get(owner) ?? []).slice(0, safeLimit));
      },
      subscribe(onRecord, onConnection = () => {}) {
        if (typeof onRecord !== "function") throw new Error("订阅回调无效");
        const entry = { onRecord, onConnection };
        const entries = service.listeners.get(owner) ?? new Set();
        entries.add(entry); service.listeners.set(owner, entries);
        queueMicrotask(() => onConnection(service.online));
        return () => { entries.delete(entry); if (!entries.size) service.listeners.delete(owner); };
      },
    });
  }

  emit(userId, record) {
    for (const listener of this.listeners.get(userId) ?? []) listener.onRecord(clone(record));
  }

  emitForTest(userId, record) {
    this.emit(assertUserId(userId), record);
  }

  setOnline(online) {
    this.online = Boolean(online);
    for (const entries of this.listeners.values()) for (const listener of entries) listener.onConnection(this.online);
  }

  inspectForTest(userId) {
    return clone(this.records.get(assertUserId(userId)) ?? null);
  }
}

export class SyncCoordinator {
  constructor({ configured, userId = null, cache, remote = null, onApplyRemote = () => {}, onStateChange = () => {}, now = () => new Date().toISOString(), debounceMs = 0 }) {
    this.configured = Boolean(configured);
    this.userId = userId;
    this.cache = cache;
    this.remote = remote;
    this.onApplyRemote = onApplyRemote;
    this.onStateChange = onStateChange;
    this.now = now;
    if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 10_000) throw new Error("同步防抖时间必须是 0 到 10000 毫秒");
    this.debounceMs = debounceMs;
    this.online = true;
    this.unsubscribe = null;
    this.flushing = null;
    this.flushTimer = null;
    this.state = createSyncState({ configured: this.configured, userId });
  }

  setState(event) {
    this.state = transitionSyncState(this.state, event);
    this.onStateChange(clone(this.state));
    return this.state;
  }

  hasPending() {
    return Boolean(this.configured && this.userId && this.cache?.loadPending(this.userId));
  }

  connectRealtime() {
    if (this.unsubscribe || !this.remote?.subscribe) return;
    this.unsubscribe = this.remote.subscribe(
      (record) => { void this.acceptRemote(record); },
      (connected) => {
        this.online = Boolean(connected);
        this.setState({ type: "CONNECTION", connected: this.online, hasPending: this.hasPending() });
        if (this.online && this.hasPending()) void this.flush();
      },
    );
  }

  async start() {
    if (!this.configured) return this.setState({ type: "UNCONFIGURED" });
    if (!this.userId || !this.remote || !this.cache) return this.setState({ type: "SIGNED_OUT" });
    this.setState({ type: "SYNC_START" });
    this.connectRealtime();
    try {
      const raw = await this.remote.read();
      const remote = raw ? validateRemoteRecord(raw, this.userId) : null;
      const pending = this.cache.loadPending(this.userId);
      if (pending) {
        const remoteRevision = remote?.revision ?? 0;
        if (remoteRevision !== pending.expectedRevision) return this.enterConflict(pending, remote);
        return this.flush();
      }
      const local = this.cache.loadSnapshot(this.userId);
      if (!remote && local) return this.enterConflictRecords(local, null);
      if (remote && (!local || remote.revision > local.revision)) {
        this.cache.replaceFromRemote(this.userId, remote);
        this.onApplyRemote(clone(remote.payload), { source: "remote", revision: remote.revision });
      }
      if (remote && local && remote.revision < local.revision) return this.setState({ type: "FAILURE", message: "云端版本比本机旧；系统未覆盖任何数据，请导出本机版本并联系管理员" });
      if (remote && local && remote.revision === local.revision && !samePayload(remote.payload, local.payload)) return this.enterConflictRecords(local, remote);
      return this.setState({ type: "SYNC_SUCCESS", at: remote?.updated_at ?? local?.updatedAt ?? this.now(), realtimeConnected: this.state.realtimeConnected });
    } catch (error) {
      return this.fail(error);
    }
  }

  saveLocal(payload) {
    const validated = validateSyncPayload(payload);
    if (!this.configured) { this.setState({ type: "UNCONFIGURED" }); return Promise.resolve({ localOnly: true, payload: validated }); }
    if (!this.userId || !this.cache || !this.remote) throw new Error("登录后才能写入云同步数据");
    const baseRevision = this.cache.current(this.userId)?.revision ?? 0;
    this.cache.stage(this.userId, validated, baseRevision);
    this.setState({ type: "LOCAL_PENDING", online: this.online });
    if (!this.online) return Promise.resolve(this.state);
    if (this.debounceMs > 0) {
      this.clearFlushTimer();
      this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, this.debounceMs);
      return Promise.resolve(this.state);
    }
    return this.flush();
  }

  clearFlushTimer() {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  async flush() {
    this.clearFlushTimer();
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async flushLoop() {
    if (!this.userId || !this.remote || !this.cache) return this.state;
    while (this.cache.loadPending(this.userId)) {
      const pending = this.cache.loadPending(this.userId);
      this.setState({ type: "SYNC_START" });
      let result;
      try { result = await this.remote.compareAndSwap({ expectedRevision: pending.expectedRevision, payload: pending.payload }); }
      catch (error) { return this.fail(error); }
      if (!result?.ok) {
        let remote = null;
        try { remote = result?.record ? validateRemoteRecord(result.record, this.userId) : null; }
        catch { return this.setState({ type: "FAILURE", message: "云端数据校验失败；本机数据已保留，请先导出备份并联系管理员" }); }
        return this.enterConflict(pending, remote);
      }
      let remote;
      try { remote = validateRemoteRecord(result.record, this.userId); }
      catch { return this.setState({ type: "FAILURE", message: "云端数据校验失败；本机数据已保留，请先导出备份并联系管理员" }); }
      const finished = this.cache.finishUpload(this.userId, pending.generation, remote);
      if (!finished.pending) return this.setState({ type: "SYNC_SUCCESS", at: remote.updated_at, realtimeConnected: this.state.realtimeConnected });
    }
    return this.state;
  }

  enterConflict(pending, remote) {
    const localRecord = { payload: pending.payload, revision: pending.expectedRevision, updatedAt: pending.queuedAt };
    return this.enterConflictRecords(localRecord, remote);
  }

  enterConflictRecords(localRecord, remote) {
    return this.setState({
      type: "CONFLICT",
      conflict: { local: summarizeSyncRecord(localRecord), remote: summarizeSyncRecord(remote), localPayload: clone(localRecord.payload), remotePayload: clone(remote?.payload ?? null) },
    });
  }

  async acceptRemote(raw) {
    if (!this.configured || !this.userId || !this.cache) return false;
    let remote;
    try { remote = validateRemoteRecord(raw, this.userId); }
    catch {
      this.setState({ type: "FAILURE", message: "收到的云端数据未通过校验；本机数据已保留，请先导出备份并联系管理员" });
      return false;
    }
    const pending = this.cache.loadPending(this.userId);
    const snapshot = this.cache.loadSnapshot(this.userId);
    const localRevision = snapshot?.revision ?? 0;
    if (pending) {
      // A Realtime echo can arrive before the in-flight CAS promise settles.
      // The CAS response is authoritative for that write; deferring the echo
      // prevents a transient false conflict and never causes another upload.
      if (this.flushing) return false;
      if (remote.revision > pending.expectedRevision) this.enterConflict(pending, remote);
      return false;
    }
    if (remote.revision < localRevision) return false;
    if (remote.revision === localRevision) {
      if (snapshot && !samePayload(remote.payload, snapshot.payload)) this.enterConflictRecords(snapshot, remote);
      return false;
    }
    this.cache.replaceFromRemote(this.userId, remote);
    this.onApplyRemote(clone(remote.payload), { source: "remote", revision: remote.revision });
    this.setState({ type: "SYNC_SUCCESS", at: remote.updated_at, realtimeConnected: this.state.realtimeConnected });
    return true;
  }

  setOnline(online) {
    this.online = Boolean(online);
    if (!this.online) this.clearFlushTimer();
    this.setState({ type: "CONNECTION", connected: this.online, hasPending: this.hasPending() });
    if (this.online) return this.hasPending() ? this.flush() : this.start();
    return Promise.resolve(this.state);
  }

  retry() {
    this.clearFlushTimer();
    return this.hasPending() ? this.flush() : this.start();
  }

  fail(error) {
    const raw = String(error?.message ?? "");
    const offline = !this.online || error?.code === "OFFLINE" || /network|fetch|offline|网络不可用/i.test(raw);
    let message = "同步未完成；本机数据已保留，请点“重试”，仍失败时先导出备份";
    if (offline) message = "网络不可用；本机数据和待同步修改均已保留，联网后请点“重试”";
    else if (/jwt|token|session|auth|登录状态.*过期/i.test(raw)) message = "登录状态已过期；本机数据和待同步修改均已保留，请先导出 JSON，再退出并重新登录";
    else if (/project.*paused|service.*unavailable|gateway timeout|timed out|云服务暂不可用|休眠/i.test(raw)) message = "云服务暂不可用或正在恢复；本机数据和待同步修改均已保留，请稍后点“重试”";
    return this.setState({ type: "FAILURE", offline, hasPending: this.hasPending(), message });
  }

  stop() {
    this.clearFlushTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.userId = null;
    return this.setState({ type: "SIGNED_OUT" });
  }
}
