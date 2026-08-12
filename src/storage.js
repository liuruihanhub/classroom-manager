import { DATA_VERSION, LEGACY_DATA_VERSIONS, createEmptyData, migrateAndValidateDatabase, validateDatabase } from "./core.mjs";

export const DATA_KEY = "workbuddy.classroom.v1.1.data";

function summary(data) {
  return {
    classCount: data.classes.length,
    studentCount: data.semesterRosters.reduce((sum, roster) => sum + roster.students.length, 0),
    attendanceCount: data.attendanceSessions.length,
    semesterCount: data.semesters.length,
  };
}

export function inspectStoredData(storage = localStorage) {
  const raw = storage.getItem(DATA_KEY);
  if (!raw) return { kind: "empty", data: createEmptyData(), sourceVersion: null, raw: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === DATA_VERSION) return { kind: "current", data: validateDatabase(parsed), sourceVersion: DATA_VERSION, raw };
    if (!LEGACY_DATA_VERSIONS.includes(parsed?.version)) throw new Error(`数据版本不兼容：${parsed?.version ?? "未知"}`);
    const data = migrateAndValidateDatabase(parsed);
    return { kind: "legacy", data, sourceVersion: parsed.version, raw, summary: summary(data) };
  } catch (error) {
    return { kind: "invalid", data: createEmptyData(), sourceVersion: null, raw, error: error.message };
  }
}

export function loadData(storage = localStorage) {
  storage.removeItem("workbuddy.classroom.v1.1.lock");
  storage.removeItem("workbuddy.classroom.v1.1.session");
  return inspectStoredData(storage).data;
}

export function saveData(data, storage = localStorage) {
  validateDatabase(data);
  storage.setItem(DATA_KEY, JSON.stringify(data));
}

export function replaceDataAtomically(data, storage = localStorage) {
  const validated = validateDatabase(data);
  const temporaryKey = `${DATA_KEY}.pending`;
  storage.setItem(temporaryKey, JSON.stringify(validated));
  const reread = validateDatabase(JSON.parse(storage.getItem(temporaryKey)));
  storage.setItem(DATA_KEY, JSON.stringify(reread));
  storage.removeItem(temporaryKey);
  return reread;
}
