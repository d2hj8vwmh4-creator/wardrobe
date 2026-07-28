// 原生后端（Capacitor 模式）：复刻 import-job-api.mjs 的全部端点逻辑。
// 图片走 imageProc（Canvas），AI 走 aiClient（CapacitorHttp），持久化走 storage（Filesystem）。
import { resolveSettings, blobToBase64 } from "./env.js";
import { analyzeImage, editImage } from "./aiClient.js";
import * as imgProc from "./imageProc.js";
import * as store from "./storage.js";

const ASSET_PREFIX = "/api/import/assets/";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "necklace", "bag", "shoes"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const DETECTION_PROMPT = "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, necklace, bag, shoes (其中 accessories_up 指帽子/围巾等头颈配饰，necklace 指项链，bag 指包包). Suggest a concise specific name written in Simplified Chinese (简体中文), primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags (also in Simplified Chinese, e.g. 镂空、宽松、长袖).";

const MODELED_PROMPT = "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";

function iso() { return new Date().toISOString(); }
function cryptoId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}${Date.now()}`;
}
function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(",");
  const mime = (head.match(/:(.*?);/) || [])[1] || "image/png";
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}
function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => (Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback);
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00") {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";
  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
}

function buildOutfitPrompt(count, custom) {
  const last = count + 1;
  const base = `Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing ALL the garments shown in the following images (Image 2 through Image ${last}). Combine them into one coherent, natural outfit: place each garment on its correct body region — tops and outerwear on the torso, bottoms on the legs, footwear on the feet, accessories in their usual position. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment's color, material, fit, construction, graphic, logo and distinctive detail. Keep each featured item clearly visible and unobstructed. Use realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.`;
  return custom ? `${base}\nAdditional styling direction: ${custom}` : base;
}

// ---- 设置 ----
let runtimeSettings = {};
function currentSettings() { return resolveSettings(runtimeSettings); }
async function loadRuntime() { runtimeSettings = (await store.getSettings()) || {}; }
const setting = (name, fallback = "") => (name in runtimeSettings ? runtimeSettings[name] : fallback);
const provider = () => (setting("provider", "qwen") || "qwen").toLowerCase();

function maskKey(value) {
  if (!value) return null;
  const t = String(value);
  return t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "••••";
}
function publicSettings() {
  const s = currentSettings();
  return {
    provider: s.provider,
    visionModel: s.visionModel,
    imageModel: s.imageModel,
    garmentModel: s.garmentModel,
    imageQuality: s.imageQuality,
    visionBaseUrl: s.visionBaseUrl,
    imageBaseUrl: s.imageBaseUrl,
    apiKey: maskKey(s.apiKey),
    hasApiKey: Boolean(s.apiKey && String(s.apiKey).trim()),
    modelReference: s.modelReference,
  };
}

const allowedProviders = new Set(["openai", "qwen"]);
const allowedQualities = new Set(["low", "medium", "high", "auto", "standard"]);

export async function config() {
  await loadRuntime();
  const hasApiKey = Boolean(setting("apiKey", "").trim());
  let hasModelReference = false;
  try { await store.getReferenceBlob(); hasModelReference = true; } catch { hasModelReference = false; }
  return { ready: hasApiKey && hasModelReference, hasApiKey, hasModelReference, modelReference: setting("modelReference", "model-reference.png") };
}

export async function getSettings() { await loadRuntime(); return publicSettings(); }

export async function saveSettings(input) {
  await loadRuntime();
  if (input && input.reset === true) { runtimeSettings = {}; await store.saveSettings({}); return publicSettings(); }
  const next = { ...runtimeSettings };
  if (input.provider !== undefined) {
    if (typeof input.provider !== "string" || !allowedProviders.has(input.provider)) throw new Error("provider 必须是 openai / qwen 之一");
    next.provider = input.provider;
  }
  for (const [field, envName] of [["visionModel", "visionModel"], ["imageModel", "imageModel"], ["garmentModel", "garmentModel"], ["visionBaseUrl", "visionBaseUrl"], ["imageBaseUrl", "imageBaseUrl"]]) {
    if (input[field] !== undefined) {
      const value = typeof input[field] === "string" ? input[field].trim() : "";
      if (value && envName.endsWith("BaseUrl")) {
        try { const u = new URL(value); if (!/^https?:$/.test(u.protocol)) throw new Error("protocol"); }
        catch { throw new Error(`${field} 必须是合法的 http(s) URL`); }
      }
      next[envName] = value;
    }
  }
  if (input.imageQuality !== undefined) {
    const value = typeof input.imageQuality === "string" ? input.imageQuality.trim().toLowerCase() : "";
    if (!allowedQualities.has(value)) throw new Error("imageQuality 必须是 low / medium / high / auto / standard 之一");
    next.imageQuality = value;
  }
  if (input.apiKey !== undefined) {
    const value = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!value) throw new Error("apiKey 不能为空");
    next.apiKey = value;
  }
  runtimeSettings = next;
  await store.saveSettings(next);
  return publicSettings();
}

export async function getReference() {
  await loadRuntime();
  let hasReference = false;
  let url = null;
  try { url = await store.getReferenceUrl(); hasReference = true; } catch { /* no reference */ }
  return { modelReference: setting("modelReference", "model-reference.png"), hasReference, url };
}

export async function saveReference(dataUrl) {
  await store.saveReference(dataUrlToBlob(dataUrl));
  return publicSettings();
}

// ---- 图片 URL 解析 ----
const assetToName = (assetUrl) => (!assetUrl || !assetUrl.startsWith(ASSET_PREFIX) ? assetUrl : assetUrl.slice(ASSET_PREFIX.length));
async function resolveAssetUrl(assetUrl) {
  if (!assetUrl) return null;
  return store.getImageUrl(assetToName(assetUrl));
}
async function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  if (copy.originalAssetUrl) copy.originalAssetUrl = await resolveAssetUrl(copy.originalAssetUrl);
  for (const stage of ["crop", "garment", "modeled"]) {
    const s = copy.stages?.[stage];
    if (!s) continue;
    for (const field of ["assetUrl", "failedAssetUrl", "cleanupPreviewUrl"]) {
      if (s[field]) s[field] = await resolveAssetUrl(s[field]);
    }
  }
  return copy;
}

function garmentNameOf(job) {
  const url = job.stages.garment.assetUrl;
  return url ? String(url).split("/").pop() : `garment-${job.stages.garment.attempts}.png`;
}

async function resizeToWidth(blob, maxWidth) {
  const im = await imgProc.loadImage(await imgProc.blobToDataUrl(blob));
  if (im.naturalWidth <= maxWidth) return blob;
  const scale = maxWidth / im.naturalWidth;
  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = Math.round(im.naturalHeight * scale);
  canvas.getContext("2d").drawImage(im, 0, 0, canvas.width, canvas.height);
  return imgProc.canvasToBlob(canvas, "image/png");
}

// ---- Jobs ----
export async function createJobs(imageDataUrl) {
  await loadRuntime();
  const setup = await config();
  if (!setup.ready) throw new Error("请先完成设置（API Key 与人体参考图）");
  const [head] = imageDataUrl.split(",");
  const mime = (head.match(/:(.*?);/) || [])[1] || "image/png";
  const normalizedBlob = await imgProc.normalizeImage(imageDataUrl);
  const normalizedDataUrl = await imgProc.blobToDataUrl(normalizedBlob);
  const normB64 = normalizedDataUrl.split(",")[1];
  const settings = currentSettings();
  const items = await analyzeImage({ key: settings.apiKey, provider: settings.provider, visionBaseUrl: settings.visionBaseUrl, visionModel: settings.visionModel, imageBase64: normB64, mime });
  const jobs = [];
  for (const metadata of items.map(normalizeMetadata)) {
    const id = cryptoId();
    const originalName = "original.png";
    const cropName = "crop.png";
    await store.writeImage(`${id}/${originalName}`, normalizedBlob);
    const croppedBlob = await imgProc.cropDetectedItem(await imgProc.blobToDataUrl(normalizedBlob), metadata.boundingBox);
    await store.writeImage(`${id}/${cropName}`, croppedBlob);
    const now = iso();
    const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_PREFIX}${id}/${cropName}`, updatedAt: now };
    const job = {
      id,
      status: "active",
      metadata,
      stages: { crop: cropStage, garment: stageState(), modeled: stageState() },
      createdAt: now,
      updatedAt: now,
      internal: { originalFile: originalName, cropFile: cropName, originalMime: "image/png" },
    };
    await store.saveJob(job);
    jobs.push(await publicJob(job));
  }
  return { jobs, noClothingDetected: jobs.length === 0 };
}

export async function listJobs() {
  await loadRuntime();
  const jobs = await store.loadAllJobs();
  const visible = jobs.filter((j) => j.status !== "complete" && j.stages?.crop?.status !== "rejected" && j.stages?.garment?.status !== "rejected" && j.stages?.modeled?.status !== "rejected");
  return Promise.all(visible.map(publicJob));
}

export async function getJob(id) {
  await loadRuntime();
  const job = await store.getJob(id);
  if (!job) throw new Error("Job 不存在");
  return publicJob(job);
}

export async function patchMetadata(id, metadata) {
  await loadRuntime();
  const job = await store.getJob(id);
  if (!job) throw new Error("Job 不存在");
  job.metadata = normalizeMetadata({ ...job.metadata, ...metadata });
  await store.saveJob(job);
  return publicJob(job);
}

export async function deleteJob(id) {
  await store.deleteJobDir(id);
  return { deleted: true, id };
}

// ---- 生成 ----
async function generate(job, stageName) {
  const current = await store.getJob(job.id);
  if (!current) return;
  const stage = current.stages[stageName];
  stage.status = "processing";
  stage.decision = null;
  stage.error = null;
  stage.attempts += 1;
  stage.updatedAt = iso();
  await store.saveJob(current);
  let chromaKeyUsed = null;
  try {
    const settings = currentSettings();
    const key = settings.apiKey;
    if (!key) throw new Error("未配置 API Key");
    let bytes;
    if (stageName === "garment") {
      chromaKeyUsed = imgProc.chooseChromaKey(current.metadata.color);
      const basePrompt = current.stages.garment.prompt
        ? `${buildGarmentPrompt(current.metadata, chromaKeyUsed)}\nUser regeneration direction: ${current.stages.garment.prompt}`
        : buildGarmentPrompt(current.metadata, chromaKeyUsed);
      const srcBlob = await store.readImageBlob(`${current.id}/${current.internal.cropFile}`);
      const srcBase64 = await blobToBase64(srcBlob);
      bytes = await editImage({ ...settings, key, prompt: basePrompt, images: [{ base64: srcBase64, mime: "image/png", name: "crop.png" }], size: "1024x1024" });
      const rawName = `${stageName}-${stage.attempts}-source.png`;
      await store.writeImage(`${current.id}/${rawName}`, bytes);
      const failedAssetUrl = `${ASSET_PREFIX}${current.id}/${rawName}`;
      bytes = (await imgProc.removeChromaBackground(bytes, chromaKeyUsed, {})).blob;
      current.stages.garment.failedAssetUrl = failedAssetUrl;
    } else {
      const garmentBlob = await store.readImageBlob(`${current.id}/${garmentNameOf(current)}`);
      const modelBlob = await store.getReferenceBlob();
      const modelResized = await resizeToWidth(modelBlob, 1280);
      const basePrompt = current.stages.modeled.prompt
        ? `${MODELED_PROMPT}\nUser regeneration direction: ${current.stages.modeled.prompt}`
        : MODELED_PROMPT;
      const garmentBase64 = await blobToBase64(garmentBlob);
      const modelBase64 = await blobToBase64(modelResized);
      bytes = await editImage({
        ...settings,
        key,
        prompt: basePrompt,
        images: [{ base64: modelBase64, mime: "image/png", name: "model.png" }, { base64: garmentBase64, mime: "image/png", name: "garment.png" }],
        size: "1536x1024",
      });
    }
    const outputName = `${stageName}-${stage.attempts}.png`;
    await store.writeImage(`${current.id}/${outputName}`, bytes);
    const fresh = await store.getJob(current.id);
    fresh.stages[stageName].status = "review";
    fresh.stages[stageName].assetUrl = `${ASSET_PREFIX}${fresh.id}/${outputName}`;
    fresh.stages[stageName].failedAssetUrl = null;
    fresh.stages[stageName].cleanupPreviewUrl = null;
    fresh.stages[stageName].cleanupDiagnostics = null;
    if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
    fresh.stages[stageName].updatedAt = iso();
    await store.saveJob(fresh);
  } catch (error) {
    const fresh = await store.getJob(current.id);
    if (!fresh) return;
    fresh.stages[stageName].status = "failed";
    fresh.stages[stageName].error = error.message;
    fresh.stages[stageName].updatedAt = iso();
    if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
    await store.saveJob(fresh);
  }
}

async function persistImported(job, includeModeled = false) {
  const id = `import-${job.id}`;
  const garmentName = `${id}-garment.png`;
  const garmentSource = job.stages.garment.assetUrl ? String(job.stages.garment.assetUrl).split("/").pop() : `garment-${job.stages.garment.attempts}.png`;
  const srcBlob = await store.readImageBlob(`${job.id}/${garmentSource}`);
  await store.writeImage(garmentName, srcBlob);
  let modeledImage = null;
  if (includeModeled) {
    const modeledName = `${id}-modeled.png`;
    const modeledSource = job.stages.modeled.assetUrl ? String(job.stages.modeled.assetUrl).split("/").pop() : `modeled-${job.stages.modeled.attempts}.png`;
    const mBlob = await store.readImageBlob(`${job.id}/${modeledSource}`);
    await store.writeImage(modeledName, mBlob);
    modeledImage = `${ASSET_PREFIX}${modeledName}`;
  }
  const metadata = job.metadata || {};
  const record = {
    id,
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || null,
    palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    image: `${ASSET_PREFIX}${garmentName}`,
    thumbnail: `${ASSET_PREFIX}${garmentName}`,
    modeledImage: modeledImage || null,
    importJobId: job.id,
  };
  const records = await store.getLibrary();
  const next = [...records.filter((r) => r.id !== id), record];
  await store.saveLibrary(next);
  return record;
}

export async function stageAction(id, stageName, action, prompt = "") {
  await loadRuntime();
  const job = await store.getJob(id);
  if (!job) throw new Error("Job 不存在");
  if (!STAGES.has(stageName)) throw new Error("无效的阶段");
  if (action === "regenerate") {
    if (stageName === "crop") throw new Error("请重新上传图片以重新裁剪");
    job.stages[stageName].prompt = prompt && prompt.trim() ? prompt.trim().slice(0, 1200) : null;
    job.stages[stageName].status = "queued";
    job.stages[stageName].decision = null;
    await store.saveJob(job);
    void generate(job, stageName);
    return publicJob(job);
  }
  if (!DECISIONS.has(action) || job.stages[stageName].status !== "review") throw new Error("该阶段尚未就绪");
  const previousStatus = job.stages[stageName].status;
  const previousDecision = job.stages[stageName].decision;
  const previousJobStatus = job.status;
  job.stages[stageName].decision = action === "approve" ? "approved" : "rejected";
  job.stages[stageName].status = job.stages[stageName].decision;
  job.stages[stageName].error = null;
  job.stages[stageName].updatedAt = iso();
  const startGarment = stageName === "crop" && action === "approve" && job.stages.garment.status === "pending";
  if (stageName === "modeled" && action === "approve") job.status = "complete";
  await store.saveJob(job);
  if (action === "approve" && stageName !== "crop") {
    try { await persistImported(job, stageName === "modeled"); }
    catch (error) {
      job.stages[stageName].status = previousStatus;
      job.stages[stageName].decision = previousDecision;
      job.status = previousJobStatus;
      await store.saveJob(job);
      throw error;
    }
  }
  if (action === "reject") { await store.deleteJobDir(id); return null; }
  if (startGarment) void generate(job, "garment");
  const response = await publicJob(job);
  if (job.status === "complete") await store.deleteJobDir(id);
  return response;
}

export async function cleanup(id, action, requestedTolerance) {
  await loadRuntime();
  const job = await store.getJob(id);
  if (!job) throw new Error("Job 不存在");
  const stage = job.stages.garment;
  if (stage.status !== "failed" || !stage.failedAssetUrl) throw new Error("没有可清理的失败单品图");
  const tolerance = requestedTolerance ?? stage.cleanupTolerance ?? 46;
  const sourceName = String(stage.failedAssetUrl).split("/").pop();
  const sourceBlob = await store.readImageBlob(`${id}/${sourceName}`);
  const key = stage.chromaKey || imgProc.chooseChromaKey(job.metadata?.color);
  const cleaned = await imgProc.removeChromaBackground(sourceBlob, key, { tolerance });
  const previewName = `garment-${stage.attempts}-cleanup-${cleaned.tolerance}.png`;
  const previewUrl = `${ASSET_PREFIX}${id}/${previewName}`;
  await store.writeImage(`${id}/${previewName}`, cleaned.blob);
  stage.chromaKey = key;
  stage.cleanupTolerance = cleaned.tolerance;
  stage.cleanupDiagnostics = cleaned.verification;
  stage.cleanupPreviewUrl = previewUrl;
  stage.updatedAt = iso();
  if (action === "accept") {
    stage.status = "review";
    stage.decision = null;
    stage.error = null;
    stage.assetUrl = previewUrl;
  }
  await store.saveJob(job);
  return publicJob(job);
}

// ---- 衣橱 ----
export async function listWardrobe() {
  await loadRuntime();
  const records = await store.getLibrary();
  return Promise.all(records.map(async (r) => ({
    ...r,
    image: await store.getImageUrl(String(r.image).replace(ASSET_PREFIX, "")),
    thumbnail: await store.getImageUrl(String(r.thumbnail).replace(ASSET_PREFIX, "")),
    modeledImage: r.modeledImage ? await store.getImageUrl(String(r.modeledImage).replace(ASSET_PREFIX, "")) : null,
  })));
}

export async function deleteWardrobeItem(id) {
  const records = await store.getLibrary();
  const next = records.filter((r) => r.id !== id);
  if (next.length === records.length) return { deleted: false, id };
  await store.saveLibrary(next);
  await store.deleteImage(`${id}-garment.png`);
  await store.deleteImage(`${id}-modeled.png`);
  return { deleted: true, id };
}

// ---- 搭配上身图 ----
export async function createOutfit(ids, prompt) {
  await loadRuntime();
  const setup = await config();
  if (!setup.ready) throw new Error("请先完成设置（API Key 与人体参考图）");
  const settings = currentSettings();
  if (!settings.apiKey) throw new Error("未配置 API Key");
  const modelBlob = await store.getReferenceBlob();
  const modelResized = await resizeToWidth(modelBlob, 1280);
  const modelBase64 = await blobToBase64(modelResized);
  const garments = [];
  for (const id of ids.slice(0, 9)) {
    const name = `${id}-garment.png`;
    const blob = await store.readImageBlob(name);
    garments.push({ base64: await blobToBase64(blob), mime: "image/png", name: "garment.png" });
  }
  const base = buildOutfitPrompt(garments.length, prompt || null);
  const bytes = await editImage({
    ...settings,
    key: settings.apiKey,
    prompt: base,
    images: [{ base64: modelBase64, mime: "image/png", name: "model.png" }, ...garments],
    size: "1536x1024",
  });
  const outfitId = cryptoId();
  const outName = `outfit-${outfitId}.png`;
  await store.writeImage(outName, bytes);
  return { imageUrl: await store.getImageUrl(outName), id: outfitId };
}
