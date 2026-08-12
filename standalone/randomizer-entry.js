import * as XLSX from "xlsx";
import { parseStandaloneJson, parseStandaloneText, validateImportedStudents } from "./import-core.mjs";

const KEY = "workbuddy.standalone-randomizer.v1";
const state = load();
let rolling = false;

function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e7).toString(36)}`; }
function emptyState() { return { classes: [{ id: id("class"), name: "示例班级", students: [] }], activeClassId: null, mode: "pure", sound: true, history: [] }; }
function load() { try { const parsed = JSON.parse(localStorage.getItem(KEY)); if (parsed?.classes && Array.isArray(parsed.history)) return parsed; } catch {} const fresh = emptyState(); fresh.activeClassId = fresh.classes[0].id; return fresh; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 某些 file:// 沙箱禁用持久化时仍允许当前会话使用。 */ } }
function currentClass() { return state.classes.find((item) => item.id === state.activeClassId) ?? state.classes[0]; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function validateStudents(students) { validateImportedStudents(students); }
function parseText(text) { return parseStandaloneText(text, id); }
function tone(frequency, duration = .04) { if (!state.sound) return; try { const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = frequency; gain.gain.value = .04; oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + duration); oscillator.stop(context.currentTime + duration); } catch {} }
function eligible() { return currentClass().students.filter((student) => !student.excluded); }
function pick() { const pool = eligible(); if (!pool.length) throw new Error("没有可参与抽名的学生"); if (state.mode === "pure") return pool[Math.floor(Math.random() * pool.length)]; const weights = pool.map((item) => 1 / (item.count + 1)); const total = weights.reduce((sum, item) => sum + item, 0); let cursor = Math.random() * total; for (let index = 0; index < pool.length; index += 1) { cursor -= weights[index]; if (cursor <= 0) return pool[index]; } return pool.at(-1); }
function notify(message) { const toast = document.querySelector("#toast"); toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2400); }

function render() {
  const classItem = currentClass();
  document.querySelector("#class-select").innerHTML = state.classes.map((item) => `<option value="${item.id}" ${item.id === state.activeClassId ? "selected" : ""}>${escapeHtml(item.name)}（${item.students.length}人）</option>`).join("");
  document.querySelector("#mode").value = state.mode;
  document.querySelector("#sound").checked = state.sound;
  document.querySelector("#student-list").innerHTML = classItem.students.length ? classItem.students.map((student) => `<label class="student-row"><input type="checkbox" data-exclude="${student.id}" ${student.excluded ? "checked" : ""}><span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.studentNo)}</small></span><b>${student.count}次</b><button data-delete="${student.id}" aria-label="删除 ${escapeHtml(student.name)}">×</button></label>`).join("") : `<div class="empty">请导入或手动添加学生</div>`;
  const history = state.history.filter((item) => item.classId === classItem.id).slice().reverse();
  document.querySelector("#history").innerHTML = history.length ? history.map((item) => `<li><span>${escapeHtml(item.name)}<small>${escapeHtml(item.studentNo)}</small></span><time>${new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}</time></li>`).join("") : `<li class="empty">尚无抽名记录</li>`;
  document.querySelector("#eligible-count").textContent = eligible().length;
  save();
}

async function importFile(file) {
  if (!file) return;
  try {
    let students;
    if (/\.json$/i.test(file.name)) {
      const imported = parseStandaloneJson(JSON.parse(await file.text()), id);
      if (imported.kind === "classes") {
        if (!confirm(`识别到主系统完整备份，共 ${imported.classes.length} 个“学期｜班级”名单。替换独立页现有全部班级？抽取次数将重置为0。`)) return;
        state.classes = imported.classes; state.activeClassId = imported.classes[0].id; state.history = []; render(); notify("主系统名单已导入，两个系统仍保持独立"); return;
      }
      students = imported.students;
    } else if (/\.csv$/i.test(file.name)) students = parseText(await file.text());
    else {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: true }); const sheet = workbook.Sheets[workbook.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
      const header = rows[0].map(String); const noIndex = header.findIndex((value) => /学号|student\s*no/i.test(value)); const nameIndex = header.findIndex((value) => /姓名|name/i.test(value)); if (nameIndex < 0) throw new Error("无法识别“姓名”列；学号列可以省略");
      students = rows.slice(1).filter((row) => (noIndex >= 0 && row[noIndex]) || row[nameIndex]).map((row) => ({ id: id("stu"), studentNo: noIndex >= 0 ? String(row[noIndex] ?? "").trim() : "", name: String(row[nameIndex] ?? "").trim(), excluded: false, count: 0 })); validateStudents(students);
    }
    if (!confirm(`预览校验通过，共 ${students.length} 人。替换当前班级名单并将抽取次数重置为0？`)) return;
    currentClass().students = students; state.history = state.history.filter((item) => item.classId !== currentClass().id); render(); notify("名单已导入，抽取次数已重置为 0");
  } catch (error) { notify(`导入失败：${error.message}；当前名单未改变`); }
}

async function roll() {
  if (rolling) return;
  let winner; try { winner = pick(); } catch (error) { return notify(error.message); }
  rolling = true; const pool = eligible(); const name = document.querySelector("#winner-name"); const no = document.querySelector("#winner-no"); const button = document.querySelector("#draw"); button.disabled = true;
  const frames = 24; for (let frame = 0; frame < frames; frame += 1) { const shown = frame === frames - 1 ? winner : pool[Math.floor(Math.random() * pool.length)]; name.textContent = shown.name; no.textContent = shown.studentNo; tone(frame === frames - 1 ? 720 : 280 + frame * 9, frame === frames - 1 ? .18 : .025); await new Promise((resolve) => setTimeout(resolve, 28 + frame * frame * .34)); }
  winner.count += 1; state.history.push({ id: id("draw"), classId: currentClass().id, studentId: winner.id, studentNo: winner.studentNo, name: winner.name, time: new Date().toISOString(), mode: state.mode }); rolling = false; button.disabled = false; render();
}

document.querySelector("#class-select").addEventListener("change", (event) => { state.activeClassId = event.target.value; document.querySelector("#winner-name").textContent = "准备抽名"; document.querySelector("#winner-no").textContent = "—"; render(); });
document.querySelector("#add-class").addEventListener("click", () => { const name = prompt("新班级名称"); if (!name?.trim()) return; const item = { id: id("class"), name: name.trim(), students: [] }; state.classes.push(item); state.activeClassId = item.id; render(); });
document.querySelector("#delete-class").addEventListener("click", () => { if (state.classes.length === 1) return notify("至少保留一个班级"); if (!confirm(`删除“${currentClass().name}”及其本地抽名记录？`) || !confirm("再次确认删除？")) return; const removed = currentClass().id; state.classes = state.classes.filter((item) => item.id !== removed); state.history = state.history.filter((item) => item.classId !== removed); state.activeClassId = state.classes[0].id; render(); });
document.querySelector("#mode").addEventListener("change", (event) => { state.mode = event.target.value; render(); });
document.querySelector("#sound").addEventListener("change", (event) => { state.sound = event.target.checked; render(); });
document.querySelector("#draw").addEventListener("click", roll);
document.querySelector("#clear-history").addEventListener("click", () => { if (!confirm("清空当前班级抽名记录和次数？") || !confirm("再次确认清空？")) return; currentClass().students.forEach((item) => { item.count = 0; }); state.history = state.history.filter((item) => item.classId !== currentClass().id); render(); });
document.querySelector("#project").addEventListener("click", () => { document.body.classList.toggle("projecting"); document.querySelector("#project").textContent = document.body.classList.contains("projecting") ? "退出大字投屏" : "进入大字投屏"; });
document.querySelector("#import-file").addEventListener("change", (event) => importFile(event.target.files[0]));
document.querySelector("#paste-add").addEventListener("click", () => { try { const students = parseText(document.querySelector("#paste").value); const errors = validateStudents([...currentClass().students, ...students]); if (errors) return; currentClass().students.push(...students); document.querySelector("#paste").value = ""; render(); notify(`已添加 ${students.length} 人`); } catch (error) { notify(error.message); } });
document.querySelector("#manual-add").addEventListener("click", () => { const studentNo = prompt("学号（可留空；填写时按文本保存）"); if (studentNo === null) return; const name = prompt("姓名"); if (!name?.trim()) return; try { const student = { id: id("stu"), studentNo: String(studentNo).trim(), name: name.trim(), excluded: false, count: 0 }; validateStudents([...currentClass().students, student]); currentClass().students.push(student); render(); } catch (error) { notify(error.message); } });
document.querySelector("#student-list").addEventListener("change", (event) => { const student = currentClass().students.find((item) => item.id === event.target.dataset.exclude); if (student) { student.excluded = event.target.checked; render(); } });
document.querySelector("#student-list").addEventListener("click", (event) => { const studentId = event.target.dataset.delete; if (!studentId) return; const student = currentClass().students.find((item) => item.id === studentId); if (confirm(`删除 ${student.name}？`)) { currentClass().students = currentClass().students.filter((item) => item.id !== studentId); state.history = state.history.filter((item) => item.studentId !== studentId); render(); } });
render();
