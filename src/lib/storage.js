// 本地存储层（替代后端 data/ 目录的文件系统）。
// native（Capacitor）写入 Capacitor Filesystem（Directory.DATA = 应用私有 filesDir）；
// web 降级用 localStorage + 内存 blob。
//
// 【根因修复 · 第三轮】Capacitor 7 Android 的 ION 控制器在 Directory.DATA 下，
// saveFile 完全不可靠——即便父目录（filesDir）已存在、不传 recursive、写根级
// 裸文件名（如 settings.json），都会触发 "Missing parent directory – parent
// directory creation failed." (OS-PLUG-FILE-0011)。MuMu Android 15 实测三次必现。
//
// 解决：把 mkdir 和 writeFile 拆开。先独立 mkdir 一个子目录 wardrobe/（容错捕获
// "已存在"），再把文件写进 wardrobe/<diskName(path)>，writeFile 不带 recursive。
// 这样 writeFile 触发时父目录已存在，ION 的 parent-creation 路径不再失败。
// 扁平 diskName 编码（/ → __）保留，readdir 改为读 wardrobe/，列表语义不变。
import { isNative, blobToBase64, base64ToBlob } from "./env.js";
import { Filesystem, Directory } from "@capacitor/filesystem";

const APP_DIR = Directory.DATA;
const APP_SUB = "wardrobe"; // 预创建的子目录
const SEP_RE = /\//g;
const diskName = (name) => name.replace(SEP_RE, "__");

const memBlobs = new Map(); // name -> Blob (web 降级)
const urlCache = new Map(); // name -> objectURL

let ensureDirPromise = null;
// 幂等：首次调用 mkdir wardrobe/，后续直接复用已 resolve 的 Promise
async function ensureAppDir() {
  if (!ensureDirPromise) {
    ensureDirPromise = (async () => {
      try {
        await Filesystem.mkdir({ path: APP_SUB, directory: APP_DIR, recursive: true });
      } catch (e) {
        const msg = String(e?.message || e);
        // 已存在/父目录已存在 等幂等错误一律吞咽；其他错误不抛（写时再暴露）
        if (!/exists|already|EEXIST/i.test(msg)) {
          // 记录但不让 mkdir 失败阻断后续写入（write 时会再报错）
          console.warn("[storage] mkdir wardrobe failed:", msg);
        }
      }
    })();
  }
  return ensureDirPromise;
}

async function writeText(path, value) {
  const text = JSON.stringify(value, null, 2);
  if (isNative) {
    await ensureAppDir();
    await Filesystem.writeFile({
      path: `${APP_SUB}/${diskName(path)}`,
      data: text,
      directory: APP_DIR,
      encoding: "utf8",
    });
  } else {
    try { localStorage.setItem(`wardrobe:${path}`, text); } catch { /* ignore quota */ }
  }
}

async function readText(path) {
  if (isNative) {
    try {
      const r = await Filesystem.readFile({
        path: `${APP_SUB}/${diskName(path)}`,
        directory: APP_DIR,
        encoding: "utf8",
      });
      return JSON.parse(r.data);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/ENOENT|does not exist|not found/i.test(msg)) return null;
      throw e;
    }
  }
  const v = localStorage.getItem(`wardrobe:${path}`);
  return v ? JSON.parse(v) : [];
}

export async function writeImage(name, blob) {
  if (isNative) {
    const b64 = await blobToBase64(blob);
    await ensureAppDir();
    await Filesystem.writeFile({
      path: `${APP_SUB}/${diskName(name)}`,
      data: b64,
      directory: APP_DIR,
      encoding: "base64",
    });
  } else {
    memBlobs.set(name, blob);
  }
}

export async function readImageBlob(name) {
  if (isNative) {
    const r = await Filesystem.readFile({
      path: `${APP_SUB}/${diskName(name)}`,
      directory: APP_DIR,
      encoding: "base64",
    });
    return base64ToBlob(r.data, "image/png");
  }
  const b = memBlobs.get(name);
  if (!b) throw new Error(`图片不存在: ${name}`);
  return b;
}

export async function deleteImage(name) {
  if (isNative) {
    try {
      await Filesystem.deleteFile({
        path: `${APP_SUB}/${diskName(name)}`,
        directory: APP_DIR,
      });
    } catch { /* ignore */ }
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
    await ensureAppDir();
    const entries = await Filesystem.readdir({ path: APP_SUB, directory: APP_DIR });
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
    await ensureAppDir();
    const entries = await Filesystem.readdir({ path: APP_SUB, directory: APP_DIR });
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
      try { await Filesystem.deleteFile({ path: `${APP_SUB}/${f}`, directory: APP_DIR }); } catch { /* ignore */ }
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
