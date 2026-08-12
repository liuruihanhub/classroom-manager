export function validateImportedStudents(students) {
  if (!Array.isArray(students)) throw new Error("学生名单必须是数组");
  const seen = new Set();
  students.forEach((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 行不是有效学生记录`);
    const studentNo = String(item.studentNo ?? item.学号 ?? "").trim();
    const name = String(item.name ?? item.姓名 ?? "").trim();
    if (!name) throw new Error(`第 ${index + 1} 行缺少姓名`);
    if (studentNo && seen.has(studentNo)) throw new Error(`重复学号：${studentNo}`);
    if (studentNo) seen.add(studentNo);
  });
}

function parseDelimitedLine(line) {
  const delimiter = line.includes("\t") ? "\t" : ",";
  const result = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { result.push(cell); cell = ""; }
    else cell += char;
  }
  result.push(cell);
  return result.map((item) => item.trim());
}

export function parseStandaloneText(text, idFactory) {
  const rows = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).map(parseDelimitedLine);
  let columns = null;
  if (rows.length) {
    const studentNoIndex = rows[0].findIndex((cell) => /学号|student\s*no/i.test(cell));
    const nameIndex = rows[0].findIndex((cell) => /姓名|name/i.test(cell));
    if (nameIndex >= 0) { columns = { studentNoIndex, nameIndex }; rows.shift(); }
  }
  const students = rows.map((cells) => ({
    id: idFactory("stu"),
    studentNo: String(columns ? (columns.studentNoIndex >= 0 ? cells[columns.studentNoIndex] : "") : (cells.length > 1 ? cells[0] : "") ?? "").trim(),
    name: String(columns ? cells[columns.nameIndex] : (cells.length > 1 ? cells[1] : cells[0]) ?? "").trim(),
    excluded: false,
    count: 0,
  }));
  validateImportedStudents(students);
  return students;
}

function convertStudents(rows, idFactory) {
  validateImportedStudents(rows);
  return rows.map((item) => ({
    id: idFactory("stu"),
    studentNo: String(item.studentNo ?? item.学号 ?? "").trim(),
    name: String(item.name ?? item.姓名).trim(),
    excluded: false,
    count: 0,
  }));
}

export function parseStandaloneJson(parsed, idFactory) {
  if (Array.isArray(parsed) || Array.isArray(parsed?.students)) {
    return { kind: "students", students: convertStudents(Array.isArray(parsed) ? parsed : parsed.students, idFactory) };
  }
  if (["1.1", "1.2", "2.0", "3.0"].includes(parsed?.version) && Array.isArray(parsed.semesters) && Array.isArray(parsed.classes) && Array.isArray(parsed.semesterRosters)) {
    const usedNames = new Map();
    const classes = parsed.semesterRosters.map((roster) => {
      const semester = parsed.semesters.find((item) => item.id === roster.semesterId);
      const classItem = parsed.classes.find((item) => item.id === roster.classId);
      if (!semester || !classItem) throw new Error("主系统备份含悬空的学期或班级引用");
      const baseName = `${String(semester.name).trim()}｜${String(classItem.name).trim()}`;
      const occurrence = (usedNames.get(baseName) ?? 0) + 1; usedNames.set(baseName, occurrence);
      return { id: idFactory("class"), name: occurrence === 1 ? baseName : `${baseName}（${occurrence}）`, students: convertStudents(roster.students, idFactory) };
    });
    if (!classes.length) throw new Error("主系统备份中没有可导入的学期班级名单");
    return { kind: "classes", classes };
  }
  throw new Error("JSON 需为学生数组、含 students 数组，或主系统完整备份");
}
