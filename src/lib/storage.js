// 本地存储层（替代后端 data/ 目录的文件系统）。
// native（Capacitor）写入 Capacitor Filesystem（Application 目录）；web 降级用 localStorage + 内存 blob。
import { isNative, blobToBase64, base64ToBlob } from "./env.js";
import { Filesystem } from "@capacitor/filesystem";

const ROOT = "wardrobe";
const APP_DIR = "APPLICATION";

const memBlobs = new Map(); // name -> Blob (web 降级)
const urlCache = new Map(); // name -> objectURL

async function fsMkdir(path) {
  if (!path) return;
  try {
    await Filesystem.mkdir({ path: `${ROOT}/${path}`, directory: APP_DIR, recursive: true });
  } catch (e) {
    if (e && !/exists|EEXIST|already/i.test(String(e.message || e))) throw e;
  }
}

async function writeText(path, value) {
  const text = JSON.stringify(value, null, 2);
  if (isNative) {
    await fsMkdir(path.split("/").slice(0, -1).join("/"));
    await Filesystem.writeFile({ path: `${ROOT}/${path}`, data: text, directory: APP_DIR, encoding: "utf8" });
  } else {
    try { localStorage.setItem(`wardrobe:${path}`, text); } catch { /* ignore quota */ }
  }
}

async function readText(path) {
  if (isNative) {
    try {
      const r = await Filesystem.readFile({ path: `${ROOT}/${path}`, directory: APP_DIR, encoding: "utf8" });
      return JSON.parse(r.data);
    } catch (e) {
      if (/ENOENT|does not exist|not found/i.test(String(e.message || e))) return null;
      throw e;
    }
  }
  const v = localStorage.getItem(`wardrobe:${path}`);
  return v ? JSON.parse(v) : null;
}

export async function writeImage(name, blob) {
  if (isNative) {
    const dir = name.split("/").slice(0, -1).join("/");
    await fsMkdir(dir ? `images/${dir}` : "images");
    const b64 = await blobToBase64(blob);
    await Filesystem.writeFile({ path: `${ROOT}/images/${name}`, data: b64, directory: APP_DIR, encoding: "base64" });
  } else {
    memBlobs.set(name, blob);
  }
}

export async function readImageBlob(name) {
  if (isNative) {
    const r = await Filesystem.readFile({ path: `${ROOT}/images/${name}`, directory: APP_DIR, encoding: "base64" });
    return base64ToBlob(r.data, "image/png");
  }
  const b = memBlobs.get(name);
  if (!b) throw new Error(`图片不存在: ${name}`);
  return b;
}

export async function deleteImage(name) {
  if (isNative) {
    try { await Filesystem.deleteFile({ path: `${ROOT}/images/${name}`, directory: APP_DIR }); } catch (e) { /* ignore */ }
  } else {
    memBlobs.delete(name);
  }
}

// 预生成并缓存 objectURL，供 <img> 直接渲染
export async function getImageUrl(name) {
  if (urlCache.has(name)) return urlCache.get(name);
  const blob = await readImageBlob(name);
  const url = URL.createObjectURL(blob);
  urlCache.set(name, url);
  return url;
}

export async function saveJob(job) {
  await writeText(`jobs/${job.id}/job.json`, job);
}

export async function getJob(id) {
  return readText(`jobs/${id}/job.json`);
}

export async function loadAllJobs() {
  if (!isNative) return [];
  try {
    const entries = await Filesystem.readdir({ path: `${ROOT}/jobs`, directory: APP_DIR });
    const files = Array.isArray(entries) ? entries : (entries.files || []);
    const jobs = [];
    for (const entry of files) {
      const name = entry && (entry.name || entry);
      if (!name) continue;
      const job = await readText(`jobs/${name}/job.json`);
      if (job) jobs.push(job);
    }
    return jobs;
  } catch (e) {
    return [];
  }
}

export async function deleteJobDir(id) {
  if (isNative) {
    try { await Filesystem.rmdir({ path: `${ROOT}/images/${id}`, directory: APP_DIR, recursive: true }); } catch (e) { /* ignore */ }
    try { await Filesystem.rmdir({ path: `${ROOT}/jobs/${id}`, directory: APP_DIR, recursive: true }); } catch (e) { /* ignore */ }
  } else {
    for (const key of [...memBlobs.keys()]) {
      if (key.startsWith(`${id}/`) || key === id) memBlobs.delete(key);
    }
  }
}

export async function getReferenceBlob() {
  return readImageBlob("reference.png");
}
export async function saveReference(blob) {
  await writeImage("reference.png", blob);
}
export const getReferenceUrl = () => getImageUrl("reference.png");

export const getSettings = () => readText("settings.json");
export const saveSettings = (obj) => writeText("settings.json", obj);

export const getLibrary = async () => (await readText("library.json")) || [];
export const saveLibrary = (arr) => writeText("library.json", arr);
