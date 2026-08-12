import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeIcon(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4); row[0] = 0;
    for (let x = 0; x < size; x += 1) {
      let color = [30, 138, 112, 255];
      const margin = size * .2; const inPaper = x > margin && x < size - margin && y > margin * .8 && y < size - margin * .8;
      if (inPaper) color = [255, 255, 255, 255];
      const line = inPaper && x > size * .32 && x < size * .68 && ((y > size * .36 && y < size * .405) || (y > size * .51 && y < size * .555));
      if (line) color = [47, 169, 140, 255];
      const tickA = x > size * .53 && x < size * .61 && y > size * .68 && y - size * .68 > (x - size * .53) * .8;
      const tickB = x >= size * .6 && x < size * .76 && y > size * .61 && y < size * .78 && y < size * .79 - (x - size * .6) * .75;
      if (tickA || tickB) color = [30, 138, 112, 255];
      const offset = 1 + x * 4; row[offset] = color[0]; row[offset + 1] = color[1]; row[offset + 2] = color[2]; row[offset + 3] = color[3];
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const publicDir = new URL("../public/", import.meta.url); await mkdir(publicDir, { recursive: true });
for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) await writeFile(new URL(name, publicDir), makeIcon(size));
console.log("PWA PNG 图标已生成：180 / 192 / 512");
