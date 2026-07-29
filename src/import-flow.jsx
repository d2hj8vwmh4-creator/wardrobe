import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import "./import-flow.css";
import { appApi, isNative } from "./lib/api.js";

const PARTS = [
  ["upperbody", "上衣"],
  ["wholebody_up", "外套"],
  ["lowerbody", "下装"],
  ["accessories_up", "配饰"],
  ["necklace", "项链"],
  ["bag", "包包"],
  ["shoes", "鞋履"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("无法读取该图片。"));
  reader.readAsDataURL(file);
});

// Android WebView 选图常见 file.type===""，FileReader 会产出
// "data:application/octet-stream;base64,..."——部分视觉 API（如 DashScope）会拒收
// 非 image/* 的 data URL。按文件魔数嗅探真实图片类型并纠正 data URL 前缀。
function sniffImageMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";        // ‰P
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";       // ÿØ
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";        // GI
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";        // BM
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) return "image/webp"; // RIFF....WEBP
  return null;
}

async function fileToImageDataUrl(file) {
  const dataUrl = await fileToDataUrl(file);
  if (dataUrl.startsWith("data:image/")) return dataUrl;
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const mime = sniffImageMime(head) || "image/png";
    return dataUrl.replace(/^data:[^;]*;/, `data:${mime};`);
  } catch {
    return dataUrl.replace(/^data:[^;]*;/, "data:image/png;");
  }
}

// Android WebView 的 <input type="file"> 返回的 File 经常是空 MIME（file.type === ""），
// 若直接用 file.type.startsWith("image/") 判断，合法图片会被误判为「非图片」并被静默丢弃，
// 表现为「导入照片失败」却没有任何报错、也不发任何网络请求。这里按扩展名兜底，并信任
// accept="image/*" 选择器返回的文件默认就是图片。
function isImageFile(file) {
  if (!file) return false;
  const type = file.type || "";
  if (type.startsWith("image/")) return true;
  if (!type) {
    const name = file.name || "";
    if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(name)) return true;
    return true; // 来自 image/* 选择器，无扩展名也当作图片处理
  }
  return false;
}

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "导入需要关注", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (modeled?.status === "review") return { tone: "ready", text: "上身效果图待审核" };
  if (modeled?.status === "processing") return { tone: "processing", text: "正在生成上身效果图" };
  if (garment?.status === "review") return { tone: "ready", text: "待审核" };
  if (garment?.status === "approved") return { tone: "processing", text: "正在生成上身效果图" };
  if (crop?.status === "review") return { tone: "ready", text: "裁剪图待审核" };
  if (crop?.status === "approved") return { tone: "processing", text: "正在生成单品图" };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "已放弃导入" };
  return { tone: "processing", text: "正在从图片中识别衣物" };
}

function reviewStageFor(job) {
  if (job.stages?.modeled?.status === "review") return "modeled";
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function hasCleanupFailure(job) {
  return job.stages?.garment?.status === "failed" && Boolean(job.stages?.garment?.failedAssetUrl);
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "新单品",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction }) {
  const asset = job.stages[stage]?.assetUrl;
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <img className="import-editor__preview" src={asset} alt={isCrop ? "检测到的单品裁剪" : isGarment ? "提取的单品图" : "生成的上身效果"} />
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "检测到的单品" : isGarment ? "单品图" : "上身效果图"}</p>
        {isCrop ? <p className="import-card__detail">请确认此裁剪包含完整的目标单品。确认后将开始生成干净的去背单品图。</p> : isGarment ? (
          <>
            <div className="import-field"><label htmlFor={`name-${job.id}`}>名称</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>类别</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>主色</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="主色十六进制色值" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">请输入六位十六进制色值，例如 #d8d0c2。</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>次要颜色 <span>可选</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#十六进制色值或留空" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">请输入六位十六进制色值或留空。</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>细节</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="休闲, 棉质, 条纹" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">确认此编辑图以附加到新衣橱单品，或给出更具体的方向重新生成。</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>重生成方向 <span>可选</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "示例：保留原始拉链并去除吊牌" : "示例：使用安静的夜晚街道，展示完整单品"} />
        </div>}
        <div className="import-actions">
          <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> 放弃</button>
          {!isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> 重新生成</button>}
          {isGarment && job.stages?.modeled?.status === "pending" && (
            <button className="import-button" disabled={busy} onClick={() => onAction("generate-modeled", regenPrompt)} aria-label="生成上身效果图">
              <Plus size={14} /> 生成上身效果图
            </button>
          )}
          <button className="import-button import-button--primary" disabled={busy || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "使用裁剪" : "确认"}</button>
        </div>
      </div>
    </div>
  );
}

function CleanupEditor({ job, tolerance, setTolerance, busy, onPreview, onAccept }) {
  const stage = job.stages.garment;
  const contaminated = stage.cleanupDiagnostics?.contaminatedPixels;
  const previewTimer = useRef(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => onPreview(next), 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">背景清理</p>
      <p className="import-card__detail">下面保留生成的单品图。在本地调整清理参数——不会再次调用图像模型。</p>
      <div className="import-cleanup-comparison">
        <figure><img src={stage.failedAssetUrl} alt="生成单品图的色度背景" /><figcaption>生成原图</figcaption></figure>
        <figure><img src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="透明单品图清理预览" /><figcaption>{stage.cleanupPreviewUrl ? "清理预览" : "预览将在此显示"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>清理强度 <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
        <div className="import-cleanup-scale"><span>保留更多边缘细节</span><span>去除更多背景</span></div>
      </div>
      {Number.isFinite(contaminated) && <p className="import-card__detail">自动检测发现 {contaminated.toLocaleString()} 个被染色的边缘像素。若预览看起来干净，仍可继续使用。</p>}
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> 预览清理</button>
        <button className="import-button import-button--primary" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> 使用此清理</button>
      </div>
    </div>
  );
}

export function WardrobeImportFlow({ onGarmentApproved, onModeledApproved, triggerRef }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (triggerRef) triggerRef.current = inputRef.current;
  });
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [cleanupTolerances, setCleanupTolerances] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);

  useEffect(() => {
    appApi.config().then(setSetup).catch((requestError) => setSetup({ ready: false, error: requestError.message }));
    appApi.listJobs()
      .then((storedJobs) => {
        const visibleJobs = storedJobs.filter((job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected" && job.stages?.modeled?.status !== "rejected");
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async (id) => {
    try {
      const next = await appApi.getJob(id);
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) { setError(requestError.message); }
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => (job.stages?.crop?.status === "approved" && ["processing", "pending", "queued"].includes(job.stages?.garment?.status)) || ["processing", "queued"].includes(job.stages?.modeled?.status) || (job.stages?.garment?.status === "approved" && job.stages?.modeled?.status === "pending"))) return undefined;
    const timer = setInterval(() => jobs.forEach((job) => refresh(job.id)), 900);
    return () => clearInterval(timer);
  }, [jobs, refresh]);

  // 始终实时校验设置就绪状态，避免「保存设置后未重启 App」导致 setup 仍为旧的 ready:false，
  // 从而把导入错误地拦截在 setup 守卫处（并弹出误导性的「请在 .env 中添加密钥」提示）。
  const ensureSetup = useCallback(async () => {
    try {
      const live = await appApi.config();
      setSetup(live);
      return live;
    } catch (requestError) {
      const fallback = { ready: false, error: requestError?.message };
      setSetup(fallback);
      return fallback;
    }
  }, []);

  const submitFiles = useCallback(async (files) => {
    const live = await ensureSetup();
    if (!live?.ready) { setOpen(true); return; }
    const images = [...files].filter(isImageFile);
    if (!images.length) {
      setError("未能从所选文件中读取到图片，请重新选择一张图片再试。");
      setOpen(true);
      return;
    }
    setDragging(false); setError(""); setNotice(null);
    for (const file of images) {
      try {
        const imageDataUrl = await fileToImageDataUrl(file);
        const result = await appApi.createJobs(imageDataUrl, { name: file.name.replace(/\.[^.]+$/, "") });
        const createdJobs = result.jobs || [result];
        if (!createdJobs.length && result.noClothingDetected) {
          setNotice({ tone: "complete", text: "未检测到衣物", detail: `我们在 ${file.name} 中未能找到明确的穿戴单品。请尝试更清晰或取景更紧凑的图片。` });
          setOpen(true);
          continue;
        }
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
      } catch (requestError) { setError(requestError.message); }
    }
  }, [ensureSetup]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some(isImageFile)) { event.preventDefault(); submitFiles(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles]);

  const perform = async (job, stage, action, prompt = "") => {
    setBusyId(job.id); setError("");
    try {
      if (stage === "garment" && action === "approve") {
        const draft = drafts[job.id];
        const metadata = { ...draft, secondaryColor: draft.secondaryColor || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
        await appApi.patchMetadata(job.id, metadata);
        const updated = await appApi.stageAction(job.id, "garment", "approve");
        const garmentAssetUrl = isNative
          ? await appApi.resolveAsset(updated.stages.garment.assetUrl)
          : `/api/import/library/import-${job.id}-garment.png`;
        onGarmentApproved?.({ id: `import-${job.id}`, ...metadata, image: garmentAssetUrl, thumbnail: garmentAssetUrl, modeledImage: null, palette: [metadata.color, metadata.secondaryColor].filter(Boolean), importJobId: job.id });
        setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      } else if (stage === "garment" && action === "generate-modeled") {
        // 手动触发「生成上身效果图」（可选），调 modeled regenerate → modeled 进入 processing → review
        const updated = await appApi.stageAction(job.id, "modeled", "regenerate", prompt);
        setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      } else {
        const updated = await appApi.stageAction(job.id, stage, action, prompt);
        const removeFromQueue = action === "reject" || (stage === "modeled" && action === "approve");
        const remainingJobs = removeFromQueue ? jobs.filter((item) => item.id !== job.id) : null;
        setJobs((current) => removeFromQueue ? current.filter((item) => item.id !== job.id) : current.map((item) => item.id === job.id ? updated : item));
        if (removeFromQueue) {
          setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
          setSelectedReviewId(null);
          if (!remainingJobs.length) setOpen(false);
        }
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
        if (stage === "modeled" && action === "approve") onModeledApproved?.(job.id, isNative ? await appApi.resolveAsset(updated.stages.modeled.assetUrl) : `/api/import/library/import-${job.id}-modeled.png`);
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    setBusyId(job.id); setError("");
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await appApi.cleanup(job.id, action, tolerance);
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const deleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await appApi.deleteJob(job.id);
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      if (!remaining.length) setOpen(false);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const active = jobs[jobs.length - 1];
  const setupRequired = setup?.ready === false;
  const activeStatus = setupRequired ? { tone: "error", text: "需要设置" } : active ? deriveStatus(active) : notice;
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const selectedReviewJob = jobs.find((job) => job.id === selectedReviewId && (reviewStageFor(job) || hasCleanupFailure(job)));
  const reviewJob = selectedReviewJob || jobs.find((job) => reviewStageFor(job)) || jobs.find((job) => hasCleanupFailure(job)) || active;
  const reviewStage = reviewJob ? reviewStageFor(reviewJob) : null;
  const progress = 0;
  const hasImportActivity = Boolean(jobs.length || notice || setupRequired);

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>拖入衣物图片</h2><p>单件单品或整套穿搭照片均可。你的衣橱将保持在原处不被改动。</p></div></div>
      <aside className={`import-tray${hasImportActivity ? " is-expanded" : ""}`} aria-label="衣橱导入">
        <button className="import-tray__button" type="button" onClick={async () => { const live = await ensureSetup(); if (!live?.ready || hasImportActivity) setOpen(true); else inputRef.current?.click(); }} aria-label={setupRequired ? "打开设置说明" : hasImportActivity ? "打开导入进度" : "添加衣物"}>{activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : readyCount ? <span>{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}</button>
        <div className="import-tray__actions">{active && <img className="import-tray__preview" src={active.stages?.garment?.assetUrl || active.stages?.garment?.failedAssetUrl || active.stages?.crop?.assetUrl || active.originalAssetUrl} alt="" />}<span className="import-tray__label">{activeStatus?.text || "添加衣物"}</span>{!setupRequired && <button className="import-icon-button" type="button" onClick={() => inputRef.current?.click()} aria-label="选择图片"><UploadSimple size={17} /></button>}</div>
      </aside>
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header"><div><p className="import-popover__eyebrow">衣橱导入</p><h2 className="import-popover__title" id="import-title">{readyCount ? `${readyCount} 个待审核` : activeStatus?.tone === "error" ? "导入需要关注" : jobs.length ? "正在准备新单品" : notice?.text || "添加到你的衣橱"}</h2></div><button className="import-icon-button" type="button" onClick={() => setOpen(false)} aria-label="关闭导入进度"><X size={20} /></button></header>
          {!jobs.length ? setupRequired ? <div className="import-drop-target import-setup-warning"><WarningCircle size={30} /><h2>需要设置</h2>{setup.hasApiKey ? <p>请在 <code>{setup.modelReference || "data/model-reference.png"}</code> 放置一张你本人的 PNG 参考照片，刷新页面后即可开始导入。</p> : <p>请在 <code>.env</code> 中添加你的 API 密钥{!setup.hasModelReference && <>，并在 <code>{setup.modelReference || "data/model-reference.png"}</code> 放置一张你本人的 PNG 参考照片</>}，然后重启应用。</p>}</div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>{notice ? "换一张图片试试" : "选择或粘贴图片"}</h2><p>{notice?.detail || "我们会提取每件衣物，建议其细节，并等待你确认后再保存。"}</p><button className="import-button import-button--primary" disabled={!setup?.ready} onClick={() => { setNotice(null); inputRef.current?.click(); }}>选择图片</button></div> : (
            <>
              <div className={`import-progress${activeStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}><div className="import-progress__meta"><span>{activeStatus?.text}</span><span>{jobs.length} 件</span></div>{activeStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}</div>
              {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={busyId === reviewJob.id} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} /> : reviewJob && hasCleanupFailure(reviewJob) ? <CleanupEditor job={reviewJob} tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46} setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))} busy={busyId === reviewJob.id} onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)} onAccept={() => performCleanup(reviewJob, "accept")} /> : null}
              <div className="import-card-list">{jobs.map((job) => { const status = deriveStatus(job); const itemName = drafts[job.id]?.name || job.metadata?.name || "新单品"; const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null; return <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}><img className="import-card__image" src={job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" /><div className="import-card__body"><h3 className="import-card__title">{itemName}</h3><p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p></div><div className="import-card__actions">{status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`审核 ${itemName}`}><Check size={17} /></button>}{failedStage && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> 重试</button>}<button className="import-icon-button import-card__delete" disabled={busyId === job.id} onClick={() => deleteJob(job)} aria-label={`从导入队列删除 ${itemName}`}><Trash size={16} /></button></div></article>; })}</div>
              <div className="import-actions"><button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> 再添加一件</button></div>
            </>
          )}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}
