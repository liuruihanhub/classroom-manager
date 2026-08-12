import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const result = await build({ entryPoints: [fileURLToPath(new URL("standalone/randomizer-entry.js", root))], bundle: true, format: "iife", platform: "browser", target: ["es2020"], write: false, minify: true });
const [template, css] = await Promise.all([readFile(new URL("standalone/randomizer-template.html", root), "utf8"), readFile(new URL("standalone/randomizer.css", root), "utf8")]);
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = template.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => script);
await mkdir(new URL("deliverables/", root), { recursive: true });
await writeFile(new URL("deliverables/独立随机抽名.html", root), html, "utf8");
console.log(`独立抽名页已生成：${Buffer.byteLength(html)} bytes`);
