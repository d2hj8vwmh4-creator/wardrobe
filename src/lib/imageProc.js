// Canvas 版图像处理，替代后端的 sharp 调用（仅前端/Capacitor 原生模式使用）。
// 复刻 import-job-api.mjs 中 normalizeImage / cropDetectedItem / removeChromaBackground /
// frameTransparentGarment / verifyNoChromaSpill 的语义。

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("读取失败"));
    reader.readAsDataURL(blob);
  });
}

export function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片编码失败"))), type);
  });
}

export function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => (Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback);
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

// 去透明通道并压白底，得到标准 PNG（DashScope 图片接口拒绝 PNG alpha）
export async function normalizeImage(src) {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return canvasToBlob(canvas, "image/png");
}

export const flattenForQwen = normalizeImage;

export async function cropDetectedItem(src, boundingBox) {
  const img = await loadImage(src);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, right - left);
  canvas.height = Math.max(1, bottom - top);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, "image/png");
}

export function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const distance = (color) => color.reduce((total, channel, index) => total + (channel - source[index]) ** 2, 0);
  const selected = candidates.slice().sort((a, b) => distance(b) - distance(a))[0];
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - neutralLevel * keyedChannels.length);
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

export async function frameTransparentGarment(blob, canvasSize = 1024, occupancy = 0.88) {
  const img = await loadImage(await blobToDataUrl(blob));
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("去背后未留下可见单品");
  const trimmed = document.createElement("canvas");
  trimmed.width = maxX - minX + 1;
  trimmed.height = maxY - minY + 1;
  const tctx = trimmed.getContext("2d");
  tctx.drawImage(canvas, minX, minY, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = document.createElement("canvas");
  resized.width = targetSize;
  resized.height = targetSize;
  const rctx = resized.getContext("2d");
  rctx.drawImage(trimmed, 0, 0, trimmed.width, trimmed.height, 0, 0, targetSize, targetSize);
  const out = document.createElement("canvas");
  out.width = canvasSize;
  out.height = canvasSize;
  const octx = out.getContext("2d");
  octx.drawImage(resized, 0, 0, targetSize, targetSize, Math.floor((canvasSize - targetSize) / 2), Math.floor((canvasSize - targetSize) / 2), targetSize, targetSize);
  return canvasToBlob(out, "image/png");
}

export async function verifyNoChromaSpill(blob, key) {
  const target = [1, 3, 5].map((offset) => parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => (channel > 200 ? index : null)).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => (channel < 55 ? index : null)).filter((index) => index !== null);
  const img = await loadImage(await blobToDataUrl(blob));
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

export async function removeChromaBackground(blob, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const target = [1, 3, 5].map((offset) => parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => (channel > 200 ? index : null)).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => (channel < 55 ? index : null)).filter((index) => index !== null);
  const img = await loadImage(await blobToDataUrl(blob));
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const feather = 80;
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      (data[index] - target[0]) ** 2 + (data[index + 1] - target[1]) ** 2 + (data[index + 2] - target[2]) ** 2,
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - Math.max(0, spill - 4) / 150);
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) removeKeyedSpill(data, index, keyedChannels, neutralLevel);
  }
  ctx.putImageData(imageData, 0, 0);
  const keyedOutput = await canvasToBlob(canvas, "image/png");
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const framedImg = await loadImage(await blobToDataUrl(framedOutput));
  const fcanvas = document.createElement("canvas");
  fcanvas.width = framedImg.naturalWidth;
  fcanvas.height = framedImg.naturalHeight;
  const fctx = fcanvas.getContext("2d");
  fctx.drawImage(framedImg, 0, 0);
  const fdata = fctx.getImageData(0, 0, fcanvas.width, fcanvas.height).data;
  for (let index = 0; index < fdata.length; index += 4) {
    if (fdata[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + fdata[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + fdata[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(fdata, index, keyedChannels, neutralLevel);
  }
  fctx.putImageData(new ImageData(fdata, fcanvas.width, fcanvas.height), 0, 0);
  const output = await canvasToBlob(fcanvas, "image/png");
  const verification = await verifyNoChromaSpill(output, key);
  return { blob: output, verification, tolerance };
}
