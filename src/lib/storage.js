// 本地存储层（替代后端 data/ 目录的文件系统）。
// native（Capacitor）写入 Capacitor Filesystem（Directory.DATA = 应用私有 filesDir）；
// web 降级用 localStorage + 内存 blob。
//
// 【根因修复】Capacitor 7 Android 的 ION 控制器在 Directory.DATA 下无法为嵌套路径
// 创建父目录（"Missing parent directory – possibly recursive=false was passed or
// parent directory creation failed."）。即便 writeFile 显式 recursive:true，mkdir
// recursive:true，ION 在 DATA 下都建不出第一级以外的子目录。
//
// filesDir 由系统保证存在，所以把所有文件平铺到 DATA 根，从根本上绕开该 bug：
// 不再依赖任何 mkdir / 父目录创建。内部仍用 "/" 表示逻辑层级（如
// "jobs/<id>/job.json"、"<id>/garment.png"），通过 diskName() 把 "/" 编码为 "__"
// 得到安全的平铺文件名（jobId 为 UUID 不含 "_"，文件名不含 "__"，零冲突）。
import { isNative, blobToBase64, base64ToBlob } from "./env.js";
import { Filesystem, Directory } from "@capacitor/filesystem";

const APP_DIR = Directory.DATA;
const SEP_RE = /\//g;
const diskName = (name) => name.replace(SEP_RE, "__");

const memBlobs = new Map(); // name -> Blob (web 降级)
const urlCache = new Map(); // name -> objectURL

async function writeText(path, value) {
  const text = JSON.stringify(value, null, 2);
  if (isNative) {
    await Filesystem.writeFile({
      path: diskName(path),
      data: text,
      directory: APP_DIR,
      encoding: "utf8",
      recursive: true,
    });
  } else {
    try { localStorage.setItem(`wardrobe:${path}`, text); } catch { /* ignore quota */ }
  }
}

async function readText(path) {
  if (isNative) {
    try {
      const r = await Filesystem.readFile({ path: diskName(path), directory: APP_DIR, encoding: "utf8" });
      return JSON.parse(r.data);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/ENOENT|does not exist|not found/i.test(msg)) return null;
      throw e;
    }
  }
  const v = localStorage.getItem(`wardrobe:${path}`);
  return v ? JSON.parse(v) : null;
}

export async function writeImage(name, blob) {
  if (isNative) {
    const b64 = await blobToBase64(blob);
    await Filesystem.writeFile({
      path: diskName(name),
      data: b64,
      directory: APP_DIR,
      encoding: "base64",
      recursive: true,
    });
  } else {
    memBlobs.set(name, blob);
  }
}

export async function readImageBlob(name) {
  if (isNative) {
    const r = await Filesystem.readFile({ path: diskName(name), directory: APP_DIR, encoding: "base64" });
    return base64ToBlob(r.data, "image/png");
  }
  const b = memBlobs.get(name);
  if (!b) throw new Error(`图片不存在: ${name}`);
  return b;
}

export async function deleteImage(name) {
  if (isNative) {
    try { await Filesystem.deleteFile({ path: diskName(name), directory: APP_DIR }); } catch { /* ignore */ }
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
    const entries = await Filesystem.readdir({ path: "", directory: APP_DIR });
    const files = Array.isArray(entries) ? entries : (entries.files || []);
    const jobs = [];
    const jobRe = /^jobs__(.+)__job\.json$/;
    for (const entry of files) {
      const name = entry && (entry.name || entry);
      if (!name) continue;
      const m = name.match(jobRe);
      if (!m) continue;
      const jobId = m[1];
      const job = await readText(`jobs/${jobId}/job.json`);
      if (job) jobs.push(job);
    }
    return jobs;
  } catch {
    return [];
  }
}

export async function deleteJobDir(id) {
  if (!isNative) {
    for (const key of [...memBlobs.keys()]) {
      if (key.startsWith(`${id}/`) || key === id) memBlobs.delete(key);
    }
    return;
  }
  try {
    const entries = await Filesystem.readdir({ path: "", directory: APP_DIR });
    const files = Array.isArray(entries) ? entries : (entries.files || []);
    const targets = [];
    for (const entry of files) {
      const name = entry && (entry.name || entry);
      if (!name) continue;
      if (name === `jobs__${id}__job.json` || name.startsWith(`${id}__`)) {
        targets.push(name);
      }
    }
    for (const f of targets) {
      try { await Filesystem.deleteFile({ path: f, directory: APP_DIR }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
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
