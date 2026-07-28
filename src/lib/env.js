import { Capacitor } from "@capacitor/core";

// 是否在 Capacitor 原生外壳（Android/iOS）内运行。
// native = true 时，前端直接走原生桥（CapacitorHttp 绕过 CORS + Filesystem 本地存储）；
// native = false 时，保持原有 /api/* 后端调用，Web 功能零改动。
export const isNative = Capacitor.isNativePlatform();

// 与后端 import-job-api.mjs 默认值对齐，保证首次进入 App 即可用（默认服务商 qwen / 通义千问）。
export const DEFAULT_SETTINGS = {
  provider: "qwen",
  visionModel: "qwen3-vl-plus",
  imageModel: "wan2.7-image",
  garmentModel: "",
  imageQuality: "high",
  visionBaseUrl: "https://dashscope.aliyun.com/compatible-mode/v1",
  imageBaseUrl: "https://dashscope.aliyuncs.com",
  apiKey: "",
  modelReference: "model-reference.png",
};

export function resolveSettings(runtime = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(runtime || {}) };
  if (!merged.visionModel) merged.visionModel = DEFAULT_SETTINGS.visionModel;
  if (!merged.imageModel) merged.imageModel = DEFAULT_SETTINGS.imageModel;
  if (!merged.imageBaseUrl) merged.imageBaseUrl = DEFAULT_SETTINGS.imageBaseUrl;
  if (!merged.visionBaseUrl) merged.visionBaseUrl = DEFAULT_SETTINGS.visionBaseUrl;
  return merged;
}

export function base64ToBlob(base64, mime = "application/octet-stream") {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}
