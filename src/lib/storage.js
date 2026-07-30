// 本地存储层（替代后端 data/ 目录的文件系统）。
// native（Capacitor）写入 Capacitor Filesystem（Directory.External = 应用专属外部存储，
// Android 映射 getExternalFilesDir(null)；web 降级用 localStorage + 内存 blob）。
//
// 【根因修复 · 第四轮】MuMu Android 15 上 Capacitor 7 ION 控制器的 saveFile 在
// Directory.DATA (filesDir) 下完全失效：writeFile 即便不带 recursive、即便父目录已存在，
// ION 内部仍强制走 parent-creation 路径并报
// "Missing parent directory – parent directory creation failed." (OS-PLUG-FILE-0011)。
// 独立 mkdir 也被同一坏路径影响。四次实测（b2a2600 / d7723ac / 515ae78 / 8fac6fe）
// 全部失败，logcat 均抓到 OS-PLUG-FILE-0011，files/settings.json 从未落盘。
//
// Directory.Documents 也不行（映射到公共 Documents，Android 11+ scoped storage 阻断）。
//
// 解决：放弃 Directory.DATA，改用 Directory.External（应用专属外部存储，
// /storage/emulated/0/Android/data/com.wardrobe.app/files/）。ION 对该路径走不同
// code path，parent-creation 可正常工作；无需运行时权限；卸载 App 时系统自动清理。
// 仍保留 mkdir wardrobe/ + 嵌套写入作为兜底。
import { isNative, blobToBase64, base64ToBlob } from "./env.js";
import { Filesystem, Directory } from "@capacitor/filesystem";

const APP_DIR = Directory.External;
const APP_SUB = "wardrobe"; // External 根下的子目录
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
        if (!/exists|already|EEXIST/i.test(msg)) {
          console.warn("[storage] mkdir wardrobe failed:", msg);
        }
      }
    })();
  }
  return ensureDirPromise;
}

async function writeText(path, value) {
  const text = JSON.stringify(value, null, 2);
  if (isNative()) {
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
  if (isNative()) {
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

// 【根因修复 · 第五轮】Capacitor Filesystem 的 Encoding 枚举只有 utf8/ascii/utf16，
// "base64" 是非法值！读写二进制的正确用法是【省略 encoding】——省略时 data 才按 base64 处理。
// 传 encoding:"base64" 时 Android 端把它当文本字符集：
//   - readFile 返回的是原始二进制字符（"�PNG..."）而非 base64，JS 侧 atob() 抛
//     InvalidCharacterError → getReferenceBlob() 失败 → hasModelReference=false → 永远「需要设置」；
//   - writeFile 会把 base64 字符串按文本原样写盘 → 保存的 PNG 全部损坏。
// 已在 MuMu 上通过 CDP 实测确认：带 encoding:"base64" 读出 2126 个乱码字符，
// 省略 encoding 读出 2840 字符的合法 base64（iVBORw0KGgo...）。
export async function writeImage(name, blob) {
  if (isNative()) {
    const b64 = await blobToBase64(blob);
    await ensureAppDir();
    await Filesystem.writeFile({
      path: `${APP_SUB}/${diskName(name)}`,
      data: b64,
      directory: APP_DIR,
      // 不传 encoding：data 按 base64 解码成二进制写入
    });
  } else {
    memBlobs.set(name, blob);
  }
}

export async function readImageBlob(name) {
  if (isNative()) {
    const r = await Filesystem.readFile({
      path: `${APP_SUB}/${diskName(name)}`,
      directory: APP_DIR,
      // 不传 encoding：返回 base64 字符串
    });
    return base64ToBlob(r.data, "image/png");
  }
  const b = memBlobs.get(name);
  if (!b) throw new Error(`图片不存在: ${name}`);
  return b;
}

export async function deleteImage(name) {
  if (isNative()) {
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
  if (!isNative()) return [];
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
  if (!isNative()) {
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
