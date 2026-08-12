const encoder = new TextEncoder();

function ascii(value) { return encoder.encode(value); }

function joinBytes(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

async function canvasJpeg(canvas) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF 图像生成失败")), "image/jpeg", 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function exportCanvasAsPdf(sourceCanvas, filename) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 28.35;
  const drawWidth = pageWidth - margin * 2;
  const maxDrawHeight = pageHeight - margin * 2;
  const sliceHeight = Math.max(1, Math.floor(sourceCanvas.width * maxDrawHeight / drawWidth));
  const pages = [];

  for (let top = 0; top < sourceCanvas.height; top += sliceHeight) {
    const height = Math.min(sliceHeight, sourceCanvas.height - top);
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = sourceCanvas.width;
    pageCanvas.height = height;
    const context = pageCanvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    context.drawImage(sourceCanvas, 0, top, sourceCanvas.width, height, 0, 0, sourceCanvas.width, height);
    pages.push({ width: pageCanvas.width, height, jpeg: await canvasJpeg(pageCanvas) });
  }

  const objects = new Map();
  objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  const pageIds = pages.map((_, index) => 3 + index * 3);
  objects.set(2, ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`));
  pages.forEach((page, index) => {
    const pageId = pageIds[index];
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const drawHeight = Math.min(maxDrawHeight, drawWidth * page.height / page.width);
    const y = pageHeight - margin - drawHeight;
    const command = ascii(`q ${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${margin.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`);
    objects.set(pageId, ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    objects.set(imageId, joinBytes([ascii(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, ascii("\nendstream")]));
    objects.set(contentId, joinBytes([ascii(`<< /Length ${command.length} >>\nstream\n`), command, ascii("\nendstream")]));
  });

  const parts = [new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 255, 255, 255, 255, 10])];
  const offsets = [0];
  let cursor = parts[0].length;
  for (let id = 1; id <= objects.size; id += 1) {
    const objectBytes = joinBytes([ascii(`${id} 0 obj\n`), objects.get(id), ascii("\nendobj\n")]);
    offsets[id] = cursor;
    parts.push(objectBytes);
    cursor += objectBytes.length;
  }
  const xrefOffset = cursor;
  const xref = [`xref\n0 ${objects.size + 1}\n`, "0000000000 65535 f \n", ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(ascii(`${xref}trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
  download(joinBytes(parts), filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}
