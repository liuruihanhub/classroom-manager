import { readFile, readdir, stat, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const assetsDirectory = new URL("assets/", dist);
const assetNames = (await readdir(assetsDirectory)).filter((name) => /\.(?:js|css)$/.test(name) && !name.endsWith(".map")).sort();
const assets = assetNames.map((name) => `,"./assets/${name}"`).join("");
const assetBytes = (await Promise.all(assetNames.map((name) => stat(new URL(name, assetsDirectory))))).reduce((sum, item) => sum + item.size, 0);
const workerUrl = new URL("service-worker.js", dist);
const worker = await readFile(workerUrl, "utf8");
if (!worker.includes("/*__PRECACHE_ASSETS__*/")) throw new Error("service worker 缺少预缓存占位符");
await writeFile(workerUrl, worker.replace("/*__PRECACHE_ASSETS__*/", assets), "utf8");
console.log(`PWA 预缓存已注入 ${assetNames.length} 个 JS/CSS（${assetBytes} bytes，不含 source map）`);
