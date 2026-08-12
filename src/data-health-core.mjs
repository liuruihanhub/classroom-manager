import { SYNC_STATUS, summarizeSyncRecord, validateSyncPayload } from "./sync-core.mjs";

function validTime(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export function classifySyncIssue({ status, error = "", online = true } = {}) {
  const message = String(error);
  if (status === SYNC_STATUS.CONFLICT) return { code: "conflict", title: "两台设备的数据发生冲突", action: "先导出两个版本，再选择保留哪一份；系统不会自动覆盖。" };
  if (!online || status === SYNC_STATUS.OFFLINE_PENDING || /network|fetch|offline|网络不可用|网络连接已断开/i.test(message)) {
    return { code: "network", title: "当前网络不可用", action: "本机修改仍然保留；联网后点“重试同步”。" };
  }
  if (/jwt|token|session|auth|登录状态|未登录|401|403/i.test(message)) {
    return { code: "auth", title: "登录状态可能已过期", action: "先导出本机 JSON，再退出账号并重新登录。" };
  }
  if (/sleep|paused|timeout|timed out|project.*unavailable|503|休眠|暂不可用/i.test(message)) {
    return { code: "service", title: "云服务可能正在恢复", action: "免费服务休眠时通常需要等待片刻；不要重复覆盖，稍后点“重试同步”。" };
  }
  if (status === SYNC_STATUS.FAILED) return { code: "failed", title: "同步未完成", action: "本机数据没有被删除；先重试，仍失败时导出 JSON 备份。" };
  if (status === SYNC_STATUS.SYNCING) return { code: "syncing", title: "正在核对云端版本", action: "请等待状态变为“已同步”后再退出账号。" };
  if (status === SYNC_STATUS.SYNCED) return { code: "synced", title: "本机与云端版本一致", action: "最近同步时间和版本号见数据健康页。" };
  return { code: "local", title: "当前为本地模式", action: "数据只在本设备浏览器中；请定期导出完整 JSON。" };
}

export function validateHistoryRecord(candidate, expectedOwnerId) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("云端历史记录格式无效");
  if (typeof candidate.owner_id !== "string" || !candidate.owner_id.trim() || candidate.owner_id.length > 256) throw new Error("云端历史记录账号无效");
  if (candidate.owner_id !== expectedOwnerId) throw new Error("云端历史记录不属于当前账号");
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) throw new Error("云端历史版本号无效");
  if (!validTime(candidate.archived_at)) throw new Error("云端历史时间无效");
  return {
    owner_id: candidate.owner_id,
    revision: candidate.revision,
    archived_at: candidate.archived_at,
    payload: validateSyncPayload(candidate.payload),
  };
}

export function validateHistoryList(candidates, expectedOwnerId) {
  if (!Array.isArray(candidates)) throw new Error("云端历史列表格式无效");
  if (candidates.length > 20) throw new Error("云端历史列表超过 20 个版本");
  const records = candidates.map((item) => validateHistoryRecord(item, expectedOwnerId));
  const revisions = new Set();
  for (const record of records) {
    if (revisions.has(record.revision)) throw new Error("云端历史版本号重复");
    revisions.add(record.revision);
  }
  return records.sort((left, right) => right.revision - left.revision);
}

export function summarizeHistoryRecord(record) {
  const summary = summarizeSyncRecord({ payload: record.payload, revision: record.revision, updated_at: record.archived_at });
  return { ...summary, archivedAt: record.archived_at };
}
