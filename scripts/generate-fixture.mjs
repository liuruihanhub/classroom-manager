import { mkdir, writeFile } from "node:fs/promises";
import { createFictionalDataset, exportDatabase, validateDatabase } from "../src/core.mjs";

const dataset = validateDatabase(createFictionalDataset());
const legacy20 = structuredClone(dataset);
legacy20.version = "2.0";
delete legacy20.people;
delete legacy20.teachingNotes;
delete legacy20.learningGoals;
delete legacy20.followUps;
delete legacy20.profileEvents;
legacy20.semesterRosters.forEach((roster) => roster.students.forEach((student) => { delete student.personId; }));
legacy20.settings.onboarding.completedVersion = "2.0";
const legacy11 = structuredClone(legacy20);
legacy11.version = "1.1";
delete legacy11.settings.workspaceContext;
delete legacy11.settings.onboarding;
const legacy12 = structuredClone(legacy11);
legacy12.version = "1.2";

await mkdir(new URL("../tests/fixtures/", import.meta.url), { recursive: true });
await Promise.all([
  writeFile(new URL("../tests/fixtures/v3-fictional-dataset.json", import.meta.url), exportDatabase(dataset), "utf8"),
  writeFile(new URL("../tests/fixtures/v2-fictional-dataset.json", import.meta.url), JSON.stringify(legacy20, null, 2), "utf8"),
  writeFile(new URL("../tests/fixtures/v11-fictional-dataset.json", import.meta.url), exportDatabase(legacy11), "utf8"),
  writeFile(new URL("../tests/fixtures/v12-fictional-dataset.json", import.meta.url), exportDatabase(legacy12), "utf8"),
]);
console.log("虚构数据集：2学期、6班、每学期每班60人、2门课程；已生成 1.1 / 1.2 / 2.0 / 3.0 迁移样例并校验 3.0");
