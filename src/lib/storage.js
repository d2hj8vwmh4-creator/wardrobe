// 本地存储层（替代后端 data/ 目录的文件系统）。
// native（Capacitor）写入 Capacitor Filesystem（DATA 目录 = 应用私有 filesDir）；web 降级用 localStorage + 内存 blob。
//
// 关键设计：所有写入走 writeFile 并显式传 recursive:true，
// 让插件自身创建父目录。Capacitor 7 Android 的 ION 控制器下，单独 mkdir 偶发报
// "Missing parent directory – possibly recursive=false was passed or parent directory creation failed."，
// 但 writeFile 在 createFileRecursive=true 时能可靠地建出整条路径。
// 因此我们不再依赖独立的 mkdir 兜底，而是把"建目录"完全交给 writeFile 完成。
import { isNative, blobToBase64, base64ToBlob } from "./env.js";
import { Filesystem, Directory } from "@capacitor/filesystem";

const ROOT = "wardrobe";
// 注意：必须使用 Capacitor Filesystem 的合法 Directory 枚举值。
// "APPLICATION" 不是合法值，在 Android 上 getDirectory() 会返回 null，导致所有写入/读取静默失败。
// Directory.DATA 映射到应用私有 filesDir（c.filesDir），卸载前持久化，符合原本意图。
const APP_DIR = Directory.DATA;

const memBlobs = new Map(); // name -> Blob (web 降级)
const urlCache = new Map(); // name -> objectURL

// 把 mkdir 当作"幂等兜底"：成功/已存在都视为 OK；不可恢复错误才抛出。
// 由于上面的设计，写入实际不依赖此函数，但保留它对将来引入 listDirectory 等只读枚举有用。
async function fsMkdir(path) {
  if (!path) return;
  try {
    await Filesystem.mkdir({ path: `${ROOT}/${path}`, directory: APP_DIR, recursive: true });
  } catch (e) {
    const msg = String(e?.message || e);
    // 已存在或父目录已就绪 → 当作成功
    if (/exists|EEXIST|already|Missing parent/i.test(msg)) return;
    throw e;
  }
}

async function writeText(path, value) {
  const text = JSON.stringify(value, null, 2);
  if (isNative) {
    // recursive:true → 插件自动建 wardrobe/ 及中间层；省掉独立 mkdir
    await Filesystem.writeFile({
      path: `${ROOT}/${path}`,
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
      const r = await Filesystem.readFile({ path: `${ROOT}/${path}`, directory: APP_DIR, encoding: "utf8" });
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
      path: `${ROOT}/images/${name}`,
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
    // 先确保 jobs 目录存在，避免首次启动时 readdir 报错
    await fsMkdir("jobs");
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
