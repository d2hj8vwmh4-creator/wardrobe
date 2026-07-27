import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Gear, Key, Link, Monitor, SpinnerGap, Upload, User, Warning, X } from "@phosphor-icons/react";

const PROVIDERS = [
  { id: "qwen", label: "通义千问（Qwen）" },
  { id: "openai", label: "OpenAI 兼容" },
];
const QUALITIES = [
  { id: "high", label: "高（high）" },
  { id: "medium", label: "中（medium）" },
  { id: "low", label: "低（low）" },
  { id: "auto", label: "自动（auto）" },
  { id: "standard", label: "标准（standard）" },
];

// 官方模型目录（2026-07 通义千问/百炼）。来源：
// 视觉理解 https://help.aliyun.com/en/model-studio/vision-model/
// 图像生成 https://help.aliyun.com/en/model-studio/image-model 与 qwen-image-api
// 也可在输入框直接填写官方快照名（如 qwen3.7-plus-2026-05-26）。
const MODEL_CATALOG = {
  qwen: {
    vision: [
      "qwen3.7-plus",
      "qwen3.7-plus-2026-05-26",
      "qwen3.7-flash",
      "qwen3.7-max",
      "qwen3.6-plus",
      "qwen3.6-flash",
      "qwen3.5-plus",
      "qwen3.5-flash",
      "qwen3-vl-plus",
      "qwen3-vl-flash",
      "qwen-vl-max",
      "qwen-vl-plus",
    ],
    image: [
      "qwen-image-3.0-pro",
      "qwen-image-2.0-pro",
      "qwen-image-2.0-pro-2026-06-22",
      "qwen-image-2.0-pro-2026-04-22",
      "qwen-image-2.0",
      "qwen-image-2.0-2026-03-03",
      "qwen-image-max",
      "qwen-image-max-2025-12-30",
      "qwen-image-plus",
      "qwen-image-plus-2026-01-09",
    ],
  },
  openai: {
    vision: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.5-preview"],
    image: ["gpt-image-1", "dall-e-3", "dall-e-2"],
  },
};

function Field({ label, hint, children }) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
      {hint ? <span className="settings-field__hint">{hint}</span> : null}
      {children}
    </label>
  );
}

// 真下拉框：官方目录可选；当前值若为列表外（如快照名）自动切到手填；可选"自定义"手填官方快照。
function ModelSelect({ label, hint, value, options, placeholder, emptyLabel, onChange }) {
  const [customMode, setCustomMode] = useState(Boolean(value && !options.includes(value)));

  useEffect(() => {
    setCustomMode(Boolean(value && !options.includes(value)));
  }, [value, options]);

  if (customMode) {
    return (
      <Field label={label} hint={hint}>
        <div className="settings-model-custom">
          <input
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="secondary-button" onClick={() => setCustomMode(false)}>
            选官方
          </button>
        </div>
      </Field>
    );
  }

  const inList = options.includes(value);
  return (
    <Field label={label} hint={hint}>
      <select
        value={inList ? value : ""}
        onChange={(e) => {
          if (e.target.value === "__custom__") { setCustomMode(true); return; }
          onChange(e.target.value);
        }}
      >
        {emptyLabel ? <option value="">{emptyLabel}</option> : <option value="" disabled>{placeholder}</option>}
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
        <option value="__custom__">自定义（手填官方快照名）…</option>
      </select>
    </Field>
  );
}

export function SettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [reference, setReference] = useState({ hasReference: false, url: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  // 表单草稿
  const [provider, setProvider] = useState("qwen");
  const [visionModel, setVisionModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [garmentModel, setGarmentModel] = useState("");
  const [imageQuality, setImageQuality] = useState("high");
  const [visionBaseUrl, setVisionBaseUrl] = useState("");
  const [imageBaseUrl, setImageBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyChanged, setApiKeyChanged] = useState(false);

  const fileInputRef = useRef(null);

  const flash = useCallback((type, text) => {
    if (type === "error") setError(text); else setMessage(text);
    setTimeout(() => (type === "error" ? setError(null) : setMessage(null)), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, rRes] = await Promise.all([
        fetch("/api/import/settings", { cache: "no-store" }),
        fetch("/api/import/settings/reference", { cache: "no-store" }),
      ]);
      if (!sRes.ok) throw new Error("无法加载设置");
      const s = await sRes.json();
      setSettings(s);
      setProvider(s.provider || "qwen");
      setVisionModel(s.visionModel || "");
      setImageModel(s.imageModel || "");
      setGarmentModel(s.garmentModel || "");
      setImageQuality(s.imageQuality || "high");
      setVisionBaseUrl(s.visionBaseUrl || "");
      setImageBaseUrl(s.imageBaseUrl || "");
      if (rRes.ok) setReference(await rRes.json());
    } catch (err) {
      flash("error", err.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const saveSettings = useCallback(async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const bodyPayload = {
        provider,
        visionModel: visionModel.trim(),
        imageModel: imageModel.trim(),
        garmentModel: garmentModel.trim(),
        imageQuality,
        visionBaseUrl: visionBaseUrl.trim(),
        imageBaseUrl: imageBaseUrl.trim(),
      };
      if (apiKeyChanged) bodyPayload.apiKey = apiKey;
      const res = await fetch("/api/import/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "保存失败");
      setSettings(data);
      setApiKeyChanged(false);
      setApiKey("");
      flash("ok", "设置已保存");
    } catch (err) {
      flash("error", err.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }, [provider, visionModel, imageModel, garmentModel, imageQuality, visionBaseUrl, imageBaseUrl, apiKey, apiKeyChanged, flash]);

  const resetDefaults = useCallback(async () => {
    if (!window.confirm("确定清除运行时覆盖层，恢复 .env 中的默认设置？")) return;
    setSaving(true);
    try {
      const res = await fetch("/api/import/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "重置失败");
      setSettings(data);
      setProvider(data.provider || "qwen");
      setVisionModel(data.visionModel || "");
      setImageModel(data.imageModel || "");
      setGarmentModel(data.garmentModel || "");
      setImageQuality(data.imageQuality || "high");
      setVisionBaseUrl(data.visionBaseUrl || "");
      setImageBaseUrl(data.imageBaseUrl || "");
      setApiKey("");
      setApiKeyChanged(false);
      flash("ok", "已恢复默认设置");
    } catch (err) {
      flash("error", err.message || "重置失败");
    } finally {
      setSaving(false);
    }
  }, [flash]);

  const onPickFile = useCallback((event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setSaving(true);
        const res = await fetch("/api/import/settings/reference", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageDataUrl: reader.result }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "上传失败");
        setSettings(data);
        setReference({ hasReference: true, url: reader.result });
        flash("ok", "人体参考图已更新");
      } catch (err) {
        flash("error", err.message || "上传失败");
      } finally {
        setSaving(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    reader.onerror = () => flash("error", "读取文件失败");
    reader.readAsDataURL(file);
  }, [flash]);

  if (loading) {
    return (
      <div className="settings-loading">
        <SpinnerGap className="spin" size={28} weight="bold" />
        <span>加载设置中…</span>
      </div>
    );
  }

  const ready = Boolean(settings?.hasApiKey) && reference.hasReference;
  const catalog = MODEL_CATALOG[provider] || MODEL_CATALOG.qwen;

  return (
    <div className="settings-panel">
      <header className="settings-header">
        <Gear size={22} weight="duotone" />
        <div>
          <h1>设置</h1>
          <p className="settings-sub">管理人体参考图、API Key 与模型参数。修改即时保存到运行时覆盖层（data/settings.json），无需重启。</p>
        </div>
      </header>

      <div className={`settings-status ${ready ? "is-ready" : "is-warn"}`}>
        {ready ? <Check size={18} weight="bold" /> : <Warning size={18} weight="bold" />}
        <span>
          {ready ? "就绪：已配置 Key 与人体参考图" : "未就绪："}
          {!settings?.hasApiKey && " 缺少 API Key"}
          {!settings?.hasApiKey && !reference.hasReference && " 与"}
          {!reference.hasReference && " 缺少人体参考图"}
        </span>
      </div>

      {message && <div className="settings-toast settings-toast--ok"><Check size={16} weight="bold" /> {message}</div>}
      {error && <div className="settings-toast settings-toast--err"><Warning size={16} weight="bold" /> {error}</div>}

      {/* 人体参考图 */}
      <section className="settings-card">
        <div className="settings-card__head">
          <User size={20} weight="duotone" />
          <h2>人体参考图</h2>
        </div>
        <p className="settings-card__desc">用于「搭配上身图」与「AI 上身图」的人物模板。建议使用清晰的正面/全身照。</p>
        <div className="settings-ref">
          <div className="settings-ref__preview">
            {reference.url
              ? <img src={reference.url} alt="人体参考图预览" />
              : <div className="settings-ref__empty">尚未设置</div>}
          </div>
          <div className="settings-ref__actions">
            <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={saving}>
              <Upload size={16} weight="bold" /> 上传 / 更换
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onPickFile} />
            <span className="settings-ref__path">{settings?.modelReference || "data/model-reference.png"}</span>
          </div>
        </div>
      </section>

      {/* Key 管理 */}
      <section className="settings-card">
        <div className="settings-card__head">
          <Key size={20} weight="duotone" />
          <h2>Key 管理</h2>
        </div>
        <p className="settings-card__desc">当前 Key：<code>{settings?.apiKey || "未设置"}</code></p>
        <Field label="更新 API Key" hint="留空则不修改；仅在新输入时提交">
          <input
            type="password"
            value={apiKey}
            placeholder="sk-..."
            onChange={(e) => { setApiKey(e.target.value); setApiKeyChanged(true); }}
          />
        </Field>
      </section>

      {/* 模型管理 */}
      <form className="settings-card" onSubmit={saveSettings}>
        <div className="settings-card__head">
          <Monitor size={20} weight="duotone" />
          <h2>模型管理</h2>
        </div>

        <Field label="服务商">
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>

        <ModelSelect
          label="视觉检测模型"
          hint="用于识别衣物与部位"
          value={visionModel}
          options={catalog.vision}
          placeholder="请选择视觉模型"
          onChange={setVisionModel}
        />

        <ModelSelect
          label="图像生成模型"
          hint="上身图 / 抠图"
          value={imageModel}
          options={catalog.image}
          placeholder="请选择图像模型"
          onChange={setImageModel}
        />

        <ModelSelect
          label="上身图专用模型"
          hint="留空则复用图像生成模型"
          value={garmentModel}
          options={catalog.image}
          placeholder="请选择上身图模型"
          emptyLabel="不单独设置（复用图像生成模型）"
          onChange={setGarmentModel}
        />

        <Field label="图像质量">
          <select value={imageQuality} onChange={(e) => setImageQuality(e.target.value)}>
            {QUALITIES.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
          </select>
        </Field>

        <Field label="视觉 API Base URL" hint="服务商兼容接口地址">
          <input type="text" value={visionBaseUrl} placeholder="https://..." onChange={(e) => setVisionBaseUrl(e.target.value)} />
        </Field>

        <Field label="图像 API Base URL" hint="图像生成接口地址">
          <input type="text" value={imageBaseUrl} placeholder="https://..." onChange={(e) => setImageBaseUrl(e.target.value)} />
        </Field>

        <div className="settings-actions">
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? <><SpinnerGap className="spin" size={16} weight="bold" /> 保存中</> : <><Check size={16} weight="bold" /> 保存设置</>}
          </button>
          <button type="button" className="secondary-button" onClick={resetDefaults} disabled={saving}>
            <X size={16} weight="bold" /> 恢复默认
          </button>
        </div>
      </form>

      <p className="settings-foot">
        <Link size={14} weight="bold" /> 设置保存在 <code>data/settings.json</code>，优先级高于 <code>.env</code>。
      </p>
    </div>
  );
}
