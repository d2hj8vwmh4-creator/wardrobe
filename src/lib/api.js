// 统一 API 桥：native（Capacitor）走 nativeBackend（本地实现），web 走原 /api/* 后端（零改动）。
import { isNative } from "./env.js";
import * as nb from "./nativeBackend.js";

export { isNative };

async function wGet(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || d.detail || "请求失败");
  }
  return r.json();
}

async function wSend(path, method, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || d.detail || "请求失败");
  return d;
}

export const appApi = {
  config: () => (isNative ? nb.config() : wGet("/api/import/config")),
  getSettings: () => (isNative ? nb.getSettings() : wGet("/api/import/settings")),
  saveSettings: (input) => (isNative ? nb.saveSettings(input) : wSend("/api/import/settings", "POST", input)),
  resetSettings: () => (isNative ? nb.saveSettings({ reset: true }) : wSend("/api/import/settings", "POST", { reset: true })),
  getReference: () => (isNative ? nb.getReference() : wGet("/api/import/settings/reference")),
  saveReference: (dataUrl) => (isNative ? nb.saveReference(dataUrl) : wSend("/api/import/settings/reference", "POST", { imageDataUrl: dataUrl })),
  listJobs: () => (isNative ? nb.listJobs() : wGet("/api/import/jobs")),
  createJobs: (imageDataUrl, metadata) =>
    (isNative ? nb.createJobs(imageDataUrl) : wSend("/api/import/jobs", "POST", { imageDataUrl, metadata: metadata || {} })),
  getJob: (id) => (isNative ? nb.getJob(id) : wGet(`/api/import/jobs/${id}`)),
  patchMetadata: (id, metadata) => (isNative ? nb.patchMetadata(id, metadata) : wSend(`/api/import/jobs/${id}/metadata`, "PATCH", { metadata })),
  stageAction: (id, stage, action, prompt) =>
    (isNative
      ? nb.stageAction(id, stage, action, prompt)
      : wSend(`/api/import/jobs/${id}/stages/${stage}/${action}`, "POST", action === "regenerate" ? { prompt } : undefined)),
  cleanup: (id, action, tolerance) =>
    (isNative ? nb.cleanup(id, action, tolerance) : wSend(`/api/import/jobs/${id}/stages/garment/cleanup-${action}`, "POST", { tolerance })),
  deleteJob: (id) => (isNative ? nb.deleteJob(id) : wSend(`/api/import/jobs/${id}`, "DELETE")),
  listWardrobe: () => (isNative ? nb.listWardrobe() : wGet("/api/import/wardrobe")),
  deleteWardrobeItem: (id) => (isNative ? nb.deleteWardrobeItem(id) : wSend(`/api/import/wardrobe/${id}`, "DELETE")),
  createOutfit: (params, prompt) =>
    (isNative ? nb.createOutfit(params, prompt) : wSend("/api/import/outfit", "POST", { garmentAssetUrls: params, prompt: prompt || undefined })),
};
