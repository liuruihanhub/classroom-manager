import * as XLSX from "xlsx";
import { fileURLToPath } from "node:url";

const sheet = XLSX.utils.aoa_to_sheet([["学号", "姓名"], ["0007", "虚构Excel甲"], ["0008", "虚构Excel乙"]]);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet, "名单");
XLSX.writeFile(workbook, fileURLToPath(new URL("../browser-evidence/fictional-roster.xlsx", import.meta.url)));
console.log("浏览器验收 Excel 名单已生成");
