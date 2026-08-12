import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEmptyData, validateDatabase } from "./core.mjs";
import { loadData } from "./storage.js";
import { loadSupabaseAdapter, readSupabaseConfig } from "./supabase-adapter.mjs";
import { validateHistoryList, validateHistoryRecord } from "./data-health-core.mjs";
import {
  canSignOut, classifyInitialMigration, createSyncState, isDecisionFresh, listSafetyBackups, samePayload, saveSafetyBackup, summarizeSyncRecord,
  SYNC_STATUS, SyncCoordinator, UserSyncCache, validateRemoteRecord,
} from "./sync-core.mjs";

const MIGRATION_PREFIX = "workbuddy.classroom.v2.migrated";

export function hasBusinessData(data) {
  try { return !samePayload(validateDatabase(data), createEmptyData()); }
  catch { return false; }
}

function recordForSummary(payload, revision = 0, updatedAt = new Date().toISOString()) {
  return { payload, revision, updated_at: updatedAt };
}

export function conflictView(localPayload, localRevision, remoteRecord) {
  return {
    local: summarizeSyncRecord(recordForSummary(localPayload, localRevision)),
    remote: summarizeSyncRecord(remoteRecord),
    localPayload: structuredClone(localPayload),
    remotePayload: structuredClone(remoteRecord?.payload ?? createEmptyData()),
  };
}

export function useRealtimeSync({ setData, notify }) {
  const config = useMemo(() => readSupabaseConfig(), []);
  const cache = useMemo(() => new UserSyncCache(localStorage), []);
  const coordinatorRef = useRef(null);
  const activeUserRef = useRef(null);
  const sessionTokenRef = useRef(0);
  const [session, setSession] = useState(null);
  const [adapter, setAdapter] = useState(null);
  const [adapterAttempt, setAdapterAttempt] = useState(0);
  const [authLoading, setAuthLoading] = useState(config.configured);
  const [startupBlocked, setStartupBlocked] = useState(false);
  const [state, setState] = useState(() => createSyncState({ configured: config.configured }));
  const [migration, setMigration] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [backupReady, setBackupReady] = useState(false);
  const [accountInfo, setAccountInfo] = useState({ revision: 0, pending: false, queuedAt: null });
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [sourceVersion, setSourceVersion] = useState(null);

  const refreshAccountInfo = useCallback((userId) => {
    if (!userId) { setAccountInfo({ revision: 0, pending: false, queuedAt: null }); return; }
    try {
      const current = cache.current(userId);
      const pending = cache.loadPending(userId);
      setAccountInfo({ revision: current?.revision ?? 0, pending: Boolean(pending), queuedAt: pending?.queuedAt ?? null });
    } catch { setAccountInfo({ revision: 0, pending: false, queuedAt: null }); }
  }, [cache]);

  const stopCoordinator = useCallback(() => {
    coordinatorRef.current?.stop();
    coordinatorRef.current = null;
  }, []);

  const makeCoordinator = useCallback((userId, remote) => {
    stopCoordinator();
    const coordinator = new SyncCoordinator({
      configured: true,
      userId,
      cache,
      remote,
      debounceMs: 250,
      onApplyRemote(payload) {
        try { setData(validateDatabase(payload)); refreshAccountInfo(userId); }
        catch { setState((current) => ({ ...current, status: SYNC_STATUS.FAILED, error: "云端数据未通过校验；本机数据已保留，请先导出备份并联系管理员" })); }
      },
      onStateChange(next) {
        setState(next);
        refreshAccountInfo(userId);
        if (next.conflict) setConflict(next.conflict);
      },
    });
    coordinatorRef.current = coordinator;
    return coordinator;
  }, [cache, refreshAccountInfo, setData, stopCoordinator]);

  const beginSession = useCallback(async (nextSession, { force = false } = {}) => {
    const nextUserId = nextSession?.user?.id ?? null;
    if (!force && nextUserId && activeUserRef.current === nextUserId && coordinatorRef.current) {
      setSession(nextSession);
      setAuthLoading(false);
      return;
    }
    const token = ++sessionTokenRef.current;
    activeUserRef.current = nextUserId;
    stopCoordinator();
    setMigration(null); setConflict(null); setBackupReady(false); setStartupBlocked(false);
    setHistory([]); setHistoryError(null); setSourceVersion(null); refreshAccountInfo(nextUserId);
    if (!nextUserId) {
      setSession(null); setData(createEmptyData()); setState(createSyncState({ configured: true })); setAuthLoading(false); return;
    }

    setSession(nextSession); setAuthLoading(true); setData(createEmptyData());
    const userId = nextUserId;
    const remote = adapter.forUser(userId);
    let current = null;
    try { current = cache.current(userId); }
    catch (error) {
      setState((value) => ({ ...value, status: SYNC_STATUS.FAILED, error: "本机账号缓存损坏；系统未读取或覆盖数据，请从 JSON 备份恢复" }));
      setStartupBlocked(true); setAuthLoading(false); notify?.(error.message); return;
    }
    if (current) setData(current.payload);
    const coordinator = makeCoordinator(userId, remote);
    if (!navigator.onLine) await coordinator.setOnline(false);

    try {
      const rawRemote = await remote.read();
      setSourceVersion(rawRemote?.payload?.version ?? null);
      const remoteRecord = rawRemote ? validateRemoteRecord(rawRemote, userId) : null;
      if (token !== sessionTokenRef.current) return;
      const legacy = loadData();
      const migrated = localStorage.getItem(`${MIGRATION_PREFIX}.${encodeURIComponent(userId)}`) === "yes";

      const migrationAction = classifyInitialMigration({ alreadyMigrated: migrated, hasLegacyData: hasBusinessData(legacy), legacyPayload: legacy, remoteRecord });
      if (migrationAction !== "normal") {
        setData(legacy);
        if (migrationAction === "conflict") {
          const nextConflict = conflictView(legacy, 0, remoteRecord);
          setConflict(nextConflict);
          setState({ ...createSyncState({ configured: true, userId }), status: SYNC_STATUS.CONFLICT, conflict: nextConflict });
        } else if (migrationAction === "choose-local-or-empty") {
          setMigration({ summary: summarizeSyncRecord(recordForSummary(legacy)), payload: legacy });
          setState({ ...createSyncState({ configured: true, userId }), status: SYNC_STATUS.SYNCING });
        } else {
          cache.saveSnapshot(userId, remoteRecord.payload, remoteRecord.revision, remoteRecord.updated_at);
          setData(remoteRecord.payload);
          localStorage.setItem(`${MIGRATION_PREFIX}.${encodeURIComponent(userId)}`, "yes");
          await coordinator.start();
        }
        return;
      }

      if (current) {
        setData(current.payload);
        await coordinator.start();
      } else if (remoteRecord) {
        setData(remoteRecord.payload);
        await coordinator.start();
      } else {
        const empty = createEmptyData();
        setData(empty);
        await coordinator.saveLocal(empty);
      }
      localStorage.setItem(`${MIGRATION_PREFIX}.${encodeURIComponent(userId)}`, "yes");
    } catch (error) {
      if (token !== sessionTokenRef.current) return;
      if (current) {
        setData(current.payload);
        coordinator.fail(error);
      } else {
        setData(createEmptyData());
        setStartupBlocked(true);
          setState((value) => ({ ...value, status: SYNC_STATUS.FAILED, error: "首次云端连接失败；系统未显示或修改业务数据，请检查网络后重试" }));
      }
      notify?.(error.message || "云同步初始化失败");
    } finally {
      if (token === sessionTokenRef.current) setAuthLoading(false);
    }
  }, [adapter, cache, makeCoordinator, notify, refreshAccountInfo, setData, stopCoordinator]);

  useEffect(() => {
    if (!config.configured) return undefined;
    let active = true;
    loadSupabaseAdapter(config).then((loaded) => { if (active) { setAdapter(loaded); setStartupBlocked(false); } }).catch((error) => {
      if (active) { setAdapter(null); setAuthLoading(false); setStartupBlocked(true); setState((value) => ({ ...value, status: SYNC_STATUS.FAILED, error: "云同步组件未能加载；本机数据未改变，请检查网络后重试" })); notify?.(error.message); }
    });
    return () => { active = false; };
  }, [adapterAttempt, config, notify]);

  useEffect(() => {
    if (!config.configured || !adapter) return undefined;
    let active = true;
    const unsubscribeAuth = adapter.onAuthStateChange((nextSession) => { if (active) void beginSession(nextSession); });
    adapter.getSession().then((currentSession) => { if (active) return beginSession(currentSession); }).catch((error) => {
      if (active) { setAuthLoading(false); setStartupBlocked(true); setState((value) => ({ ...value, status: SYNC_STATUS.FAILED, error: "登录状态读取失败；本机数据未改变，请重新连接或退出后再登录" })); notify?.(error.message); }
    });
    return () => { active = false; unsubscribeAuth(); stopCoordinator(); };
  }, [adapter, beginSession, config.configured, notify, stopCoordinator]);

  useEffect(() => {
    if (!config.configured) return undefined;
    const online = () => { void coordinatorRef.current?.setOnline(true); };
    const offline = () => { void coordinatorRef.current?.setOnline(false); };
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    if (!navigator.onLine) void coordinatorRef.current?.setOnline(false);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, [config.configured]);

  const signIn = useCallback(async (email, password) => {
    if (!adapter) throw new Error("云同步组件尚未加载");
    setAuthLoading(true);
    try { return await adapter.signIn(String(email).trim(), password); }
    catch (error) { setAuthLoading(false); throw error; }
  }, [adapter]);

  const save = useCallback((payload) => {
    if (!config.configured) return Promise.resolve();
    if (startupBlocked) return Promise.reject(new Error("尚未取得可验证的本机或云端副本，不能修改数据"));
    setBackupReady(false);
    return coordinatorRef.current?.saveLocal(validateDatabase(payload)) ?? Promise.reject(new Error("云同步尚未准备完成"));
  }, [config.configured, startupBlocked]);

  const markBackup = useCallback(() => setBackupReady(true), []);
  const latestSafetyBackup = useCallback(() => {
    const userId = session?.user?.id;
    return userId ? listSafetyBackups(localStorage, userId)[0] ?? null : null;
  }, [session]);
  const safetyBackups = useCallback(() => {
    const userId = session?.user?.id;
    return userId ? listSafetyBackups(localStorage, userId) : [];
  }, [session]);

  const loadHistory = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId || !adapter) throw new Error("登录后才能读取云端历史");
    setHistoryLoading(true); setHistoryError(null);
    try {
      const rows = await adapter.forUser(userId).history(20);
      const validated = validateHistoryList(rows, userId);
      setHistory(validated);
      return validated;
    } catch (error) {
      setHistoryError(error.message || "读取云端历史失败");
      throw error;
    } finally { setHistoryLoading(false); }
  }, [adapter, session]);

  const restoreHistory = useCallback(async (record) => {
    const userId = session?.user?.id;
    if (!userId || !adapter || !coordinatorRef.current) throw new Error("登录后才能恢复云端历史");
    if (!backupReady) throw new Error("恢复尚未开始：请先导出当前本机 JSON，数据未改动");
    const selected = validateHistoryRecord(record, userId);
    const current = cache.current(userId);
    if (!current) throw new Error("没有可验证的本机当前版本，数据未改动");
    saveSafetyBackup(localStorage, userId, current.payload, `history-restore-before-${selected.revision}`);
    setBackupReady(false);
    await coordinatorRef.current.saveLocal(selected.payload);
    setData(selected.payload);
    const result = await coordinatorRef.current.flush();
    refreshAccountInfo(userId);
    if (result?.status !== SYNC_STATUS.SYNCED) {
      throw new Error(result?.status === SYNC_STATUS.CONFLICT
        ? "恢复时云端版本已变化；历史版本已保存在本机待处理，系统未覆盖云端，请先处理冲突"
        : "历史版本已保存在本机，但尚未写入云端；请保持页面打开并重试同步");
    }
    await loadHistory();
    return result;
  }, [adapter, backupReady, cache, loadHistory, refreshAccountInfo, session, setData]);

  const signOut = useCallback(async () => {
    if (!canSignOut({ hasPending: Boolean(coordinatorRef.current?.hasPending()), hasDecision: Boolean(migration || conflict), backupReady })) throw new Error("暂时不能退出：存在待同步或未处理的数据；本机数据已保留，请先重试同步，或导出本机 JSON 后再退出");
    await adapter.signOut();
    ++sessionTokenRef.current;
    activeUserRef.current = null;
    stopCoordinator();
    setData(createEmptyData()); setSession(null); setMigration(null); setConflict(null); setStartupBlocked(false);
    setHistory([]); setHistoryError(null); setSourceVersion(null); refreshAccountInfo(null);
    setState(createSyncState({ configured: true }));
  }, [adapter, backupReady, conflict, migration, refreshAccountInfo, setData, stopCoordinator]);

  const finishChoice = useCallback(async (choice) => {
    if (!session?.user?.id) throw new Error("登录状态已失效");
    if (!["local", "remote"].includes(choice)) throw new Error("未知的冲突处理方式");
    const userId = session.user.id;
    const remote = adapter.forUser(userId);
    const localPayload = validateDatabase(migration?.payload ?? conflict?.localPayload ?? createEmptyData());
    const rawLatest = await remote.read();
    const latest = rawLatest ? validateRemoteRecord(rawLatest, userId) : null;
    const shownRemote = conflict?.remote ?? null;
    if (!isDecisionFresh(shownRemote, latest)) {
      const nextConflict = conflictView(localPayload, conflict?.local?.revision ?? 0, latest);
      setMigration(null); setConflict(nextConflict);
      setState({ ...createSyncState({ configured: true, userId }), status: SYNC_STATUS.CONFLICT, conflict: nextConflict });
      throw new Error("云端版本在确认期间发生变化；系统未执行覆盖，请重新核对并导出最新版本");
    }
    const chosen = choice === "remote" ? validateDatabase(latest?.payload ?? createEmptyData()) : localPayload;
    saveSafetyBackup(localStorage, userId, localPayload, `resolve-${choice}`);
    cache.clearPending(userId);
    const baseRevision = latest?.revision ?? 0;
    cache.saveSnapshot(userId, chosen, baseRevision, latest?.updated_at ?? new Date().toISOString());
    setData(chosen); setMigration(null); setConflict(null); setStartupBlocked(false); setBackupReady(false);
    const coordinator = makeCoordinator(userId, remote);
    if (choice === "local" || !latest) await coordinator.saveLocal(chosen);
    else await coordinator.start();
    localStorage.setItem(`${MIGRATION_PREFIX}.${encodeURIComponent(userId)}`, "yes");
  }, [adapter, cache, conflict, makeCoordinator, migration, session, setData]);

  const retry = useCallback(() => {
    if (!adapter) { setAuthLoading(true); setStartupBlocked(false); setAdapterAttempt((value) => value + 1); return Promise.resolve(); }
    if (startupBlocked && session) return beginSession(session, { force: true });
    return coordinatorRef.current?.retry();
  }, [adapter, beginSession, session, startupBlocked]);

  return {
    configured: config.configured,
    invalidConfig: config.invalid,
    session,
    authLoading,
    ready: !config.configured || Boolean(session && !authLoading && !migration && !conflict && !startupBlocked),
    startupBlocked,
    state,
    migration,
    conflict,
    signIn,
    signOut,
    save,
    retry,
    markBackup,
    backupReady,
    latestSafetyBackup,
    safetyBackups,
    accountInfo,
    sourceVersion,
    history,
    historyLoading,
    historyError,
    loadHistory,
    restoreHistory,
    chooseLocal: () => finishChoice("local"),
    chooseRemote: () => finishChoice("remote"),
  };
}
