import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, SpinnerGap, Trash, X, MagnifyingGlass, Moon, Sun, TShirt, Gear } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { MobileHome } from "./MobileHome.jsx";
import { SettingsPanel } from "./SettingsPanel.jsx";
import { appApi, isNative } from "./lib/api.js";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";

const TYPES = [
  { id: "all", label: "全部" },
  { id: "upperbody", label: "上衣", singular: "上衣" },
  { id: "wholebody_up", label: "外套", singular: "外套" },
  { id: "lowerbody", label: "下装", singular: "下装" },
  { id: "accessories_up", label: "配饰", singular: "配饰" },
  { id: "necklace", label: "项链", singular: "项链" },
  { id: "bag", label: "包包", singular: "包包" },
  { id: "shoes", label: "鞋履", singular: "鞋履" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));

const NAV_TITLES = {
  wardrobe: "衣橱",
  settings: "设置",
};


function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}


function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

function GalleryItem({ item, selected, onOpen, outfitMode, onToggleOutfit }) {
  const type = TYPE_MAP[item.part]?.singular || "衣橱单品";

  const handleClick = () => {
    if (outfitMode) onToggleOutfit(item.id);
    else onOpen(item.id);
  };

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}${outfitMode ? " outfit-selectable" : ""}`}
      type="button"
      onClick={handleClick}
      aria-label={outfitMode ? `选择 ${item.name || type} 加入搭配` : `查看 ${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <div className="gallery-item__media">
        <OptimizedImage
          src={item.thumbnail || item.image}
          alt=""
          sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 240px"
          breakpoints={[120, 180, 240, 320, 480]}
        />
      </div>
      <div className="gallery-item__info">
        <span className="gallery-item__name">{item.name || type}</span>
        <span className="gallery-item__type">{type}</span>
      </div>
      {outfitMode && (
        <span className="outfit-check" aria-hidden="true">
          <Check size={16} weight="bold" />
        </span>
      )}
    </button>
  );
}

function OutfitResultModal({ imageUrl, prompt, onPromptChange, onRegenerate, onClose, loading, error, isStitch, onStitch }) {
  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="outfit-modal" role="dialog" aria-modal="true" aria-label={isStitch ? "搭配拼接预览" : "搭配上身效果"}>
        <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="关闭搭配结果">
          <X size={24} weight="light" aria-hidden="true" />
        </button>
        <h2 className="outfit-modal__title">{isStitch ? "搭配拼接预览" : "搭配上身效果"}</h2>
        {error && <p className="status error" role="status">{error}</p>}
        {loading && (
          <div className="outfit-loading">
            <SpinnerGap size={32} className="import-spinner" />
            <span>{isStitch ? "正在拼接产品图…" : "正在生成搭配上身图…"}</span>
          </div>
        )}
        {imageUrl && !loading && (
          <OptimizedImage
            className="outfit-result-photo"
            src={imageUrl}
            alt={isStitch ? "搭配拼接预览" : "搭配上身效果"}
            sizes="(max-width: 860px) 100vw, 640px"
            breakpoints={[320, 480, 640, 800, 1024]}
            priority
          />
        )}
        {!isStitch && (
          <div className="outfit-prompt-row">
            <input
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              placeholder="额外搭配方向（可选），例如：暖色系、通勤风"
              aria-label="额外搭配方向"
            />
            <button className="primary-button" type="button" onClick={onRegenerate} disabled={loading}>
              <Check size={15} weight="bold" aria-hidden="true" /> 重新生成
            </button>
          </div>
        )}
        {isStitch && (
          <div className="outfit-prompt-row">
            <button className="primary-button" type="button" onClick={onStitch} disabled={loading}>
              <Check size={15} weight="bold" aria-hidden="true" /> 重新拼接
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`移除 ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="添加细节"
          aria-label="添加细节标签"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="添加细节">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>可选</small>
        </div>
        <p>未检测到明显的次要颜色。</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>添加次要颜色</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`选择${label}`}
        />
        <span className="selected-color-copy">
          <small>已选</small>
          <strong>{value || "自定义"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>图片建议色</span>
        <small>点击应用</small>
      </div>
      <div className="palette" aria-label={`${label} 图片建议色`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`使用 ${color} 作为${label}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "取消取色" : `从图片取${label}`}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>名称</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "衣橱单品"}
        />
      </label>

      <label className="field">
        <span>类别</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>颜色</legend>
        <div className="colors-editor">
          <ColorControl
            label="主色"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="次要颜色"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `点击衣物任意位置提取${sampling}颜色。` : sampleStatus || "主色取自图片。仅当某颜色占有明显面积时才会建议次要颜色。"}</p>
      </fieldset>

      <div className="field details-field">
        <span>细节</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "衣橱单品";
  const hasModeledImage = Boolean(item.modeledImage);
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("修改已保存。");
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("该处为透明区域，请直接在衣物上取色。");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`已将 ${color} 提取为${sampling}颜色。`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`选中的${type}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">点击衣物取色</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="选中的衣橱单品">
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="关闭查看器" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      {hasModeledImage ? (
        <div className="modeled-hero">
          <OptimizedImage
            className="modeled-hero-photo"
            src={item.modeledImage}
            alt={`${draft.name || type} 上身效果`}
            sizes="(max-width: 860px) 100vw, 520px"
            breakpoints={[320, 480, 640, 800, 1040, 1280]}
            quality={82}
            priority
          />
          <div className="viewer-heading modeled-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className="viewer-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <div className="viewer-details editing">
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        {closeBlocked && <p className="unsaved-notice" role="status">关闭前请先保存或取消修改。</p>}

        <div className="viewer-actions">
          <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
            <Trash size={15} weight="regular" aria-hidden="true" /> 删除
          </button>
          <span className="action-spacer" />
          <button className="secondary-button" type="button" onClick={cancelEditing}>取消</button>
          <button className="primary-button" type="button" onClick={saveEditing}>
            <Check size={15} weight="bold" aria-hidden="true" /> 保存
          </button>
        </div>
      </div>
    </aside>
    </div>
    </div>
  );
}

export function App() {
  const [items, setItems] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [outfitMode, setOutfitMode] = useState(false);
  const [selectedOutfitIds, setSelectedOutfitIds] = useState([]);
  const [outfitResult, setOutfitResult] = useState(null);
  const [outfitLoading, setOutfitLoading] = useState(false);
  const [outfitError, setOutfitError] = useState("");
  const [outfitPrompt, setOutfitPrompt] = useState("");
  const [outfitIsStitch, setOutfitIsStitch] = useState(false);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("wardrobe-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [activeNav, setActiveNav] = useState("wardrobe");
  const importTriggerRef = useRef(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("wardrobe-theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    appApi.listWardrobe()
      .then((loadedItems) => {
        const edits = readEdits();
        const deleted = readDeletedItems();
        const visibleItems = loadedItems.filter((item) => !deleted.has(item.id));
        setItems(visibleItems.map((item) => ({ ...item, ...(edits[item.id] || {}) })));
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const typeFiltered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    const filtered = term
      ? typeFiltered.filter((item) => {
          const name = String(item.name || "").toLowerCase();
          const part = String(item.part || "").toLowerCase();
          const palette = Array.isArray(item.palette) ? item.palette.join(" ").toLowerCase() : "";
          return name.includes(term) || part.includes(term) || palette.includes(term);
        })
      : typeFiltered;
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items, search]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
  };

  const saveItem = (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    persistEdit(updatedItem);
  };

  const deleteItem = async (id) => {
    if (id.startsWith("import-")) {
      try {
        await appApi.deleteWardrobeItem(id);
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
  }, []);

  const toggleOutfitMode = useCallback(() => {
    setOutfitMode((current) => {
      if (!current) setSelectedId(null);
      return !current;
    });
    setSelectedOutfitIds([]);
    setOutfitResult(null);
    setOutfitError("");
  }, []);

  const toggleOutfitItem = useCallback((id) => {
    setSelectedOutfitIds((current) => current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id]);
  }, []);

  const generateOutfit = useCallback(async () => {
    if (selectedOutfitIds.length < 1) return;
    const chosen = items.filter((item) => selectedOutfitIds.includes(item.id));
    const params = isNative ? chosen.map((item) => item.id) : chosen.map((item) => item.image);
    setOutfitLoading(true);
    setOutfitError("");
    setOutfitResult(null);
    setOutfitIsStitch(false);
    try {
      const data = await appApi.createOutfit(params, outfitPrompt.trim() || undefined);
      setOutfitResult(data.imageUrl);
    } catch (requestError) {
      const raw = requestError?.message || "生成失败";
      setOutfitError(/overdue-payment|Access denied|good standing|insufficient/i.test(raw)
        ? "千问账号状态异常或欠费，无法生成图像。请到阿里云百炼控制台确认账户余额/状态后重试。"
        : raw);
    } finally {
      setOutfitLoading(false);
    }
  }, [selectedOutfitIds, items, outfitPrompt]);

  const stitchOutfit = useCallback(() => {
    const chosen = items.filter((item) => selectedOutfitIds.includes(item.id));
    if (chosen.length < 1) return;
    setOutfitLoading(true);
    setOutfitError("");
    setOutfitResult(null);
    setOutfitIsStitch(true);

    // 身体部位 → 画布区域（相对坐标：x 中心锚定，y 顶部比例，w/h 宽高比例）
    const PART_ZONES = {
      accessories_up: { x: 0.50, y: 0.04, w: 0.36, h: 0.18 }, // 帽/头饰 → 头部
      necklace:       { x: 0.50, y: 0.16, w: 0.30, h: 0.12 }, // 项链 → 颈部（领口下方）
      upperbody:      { x: 0.50, y: 0.22, w: 0.48, h: 0.28 }, // 上衣 → 胸/躯干
      wholebody_up:   { x: 0.50, y: 0.20, w: 0.58, h: 0.40 }, // 外套 → 覆盖躯干（宽于上衣）
      lowerbody:      { x: 0.50, y: 0.52, w: 0.38, h: 0.38 }, // 下装 → 腿
      bag:            { x: 0.76, y: 0.46, w: 0.30, h: 0.34 }, // 包包 → 身侧/手部
      shoes:          { x: 0.50, y: 0.89, w: 0.42, h: 0.10 }, // 鞋履 → 脚
    };
    // 由内到外的图层顺序：下装/鞋先画 → 上衣 → 外套压在上面 → 帽子/项链 → 包包最前
    const Z_ORDER = ["lowerbody", "shoes", "upperbody", "wholebody_up", "accessories_up", "necklace", "bag"];

    const sorted = [...chosen].sort((a, b) => {
      const orderA = Z_ORDER.indexOf(a.part);
      const orderB = Z_ORDER.indexOf(b.part);
      return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
    });

    const loadImage = (item) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ img, item });
      img.onerror = () => reject(new Error(`「${item.name || "单品"}」图片加载失败`));
      img.src = item.image;
    });

    Promise.all(sorted.map(loadImage))
      .then((loaded) => {
        const W = 540;
        const H = 820;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const context = canvas.getContext("2d");
        const paper = getComputedStyle(document.documentElement).getPropertyValue("--paper")?.trim() || "#f7f4ef";
        const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink")?.trim() || "#3a352c";

        // 背景
        context.fillStyle = paper;
        context.fillRect(0, 0, W, H);

        // 简单人体轮廓（头/颈/躯干/腿/脚），极淡，作叠放参考
        const cx = W / 2;
        context.fillStyle = "rgba(155, 145, 128, 0.14)";
        context.strokeStyle = "rgba(110, 100, 88, 0.30)";
        context.lineWidth = 1.5;
        // 头
        context.beginPath();
        context.ellipse(cx, H * 0.13, W * 0.105, H * 0.055, 0, 0, Math.PI * 2);
        context.fill(); context.stroke();
        // 颈
        context.fillRect(cx - W * 0.045, H * 0.185, W * 0.09, H * 0.022);
        context.strokeRect(cx - W * 0.045, H * 0.185, W * 0.09, H * 0.022);
        // 躯干（肩→腰）
        const shoulderTop = H * 0.205;
        const shoulderW = W * 0.34;
        const waistY = H * 0.50;
        const waistW = W * 0.24;
        context.beginPath();
        context.moveTo(cx - shoulderW / 2, shoulderTop);
        context.lineTo(cx + shoulderW / 2, shoulderTop);
        context.lineTo(cx + waistW / 2, waistY);
        context.lineTo(cx - waistW / 2, waistY);
        context.closePath();
        context.fill(); context.stroke();
        // 腿（腰→脚踝）
        const legBotY = H * 0.90;
        const legBotW = W * 0.22;
        context.beginPath();
        context.moveTo(cx - waistW / 2, waistY);
        context.lineTo(cx + waistW / 2, waistY);
        context.lineTo(cx + legBotW / 2, legBotY);
        context.lineTo(cx - legBotW / 2, legBotY);
        context.closePath();
        context.fill(); context.stroke();
        // 脚
        context.beginPath();
        context.ellipse(cx - legBotW * 0.30, legBotY + H * 0.018, W * 0.08, H * 0.014, 0, 0, Math.PI * 2);
        context.fill(); context.stroke();
        context.beginPath();
        context.ellipse(cx + legBotW * 0.30, legBotY + H * 0.018, W * 0.08, H * 0.014, 0, 0, Math.PI * 2);
        context.fill(); context.stroke();

        // 沿人体结构叠加各件衣物（透明背景会透出轮廓 → 看起来像穿在身上）
        loaded.forEach(({ img, item }) => {
          const zone = PART_ZONES[item.part];
          if (!zone) return;
          const zw = zone.w * W;
          const zh = zone.h * H;
          const zx = (zone.x - zone.w / 2) * W;
          const zy = zone.y * H;
          const fit = Math.min(zw / img.naturalWidth, zh / img.naturalHeight);
          const dw = img.naturalWidth * fit;
          const dh = img.naturalHeight * fit;
          const dx = zx + (zw - dw) / 2;
          const dy = zy + (zh - dh) / 2;
          context.drawImage(img, dx, dy, dw, dh);
        });

        // 底部一行小字列出选中的单品（用于识别，不遮挡轮廓）
        context.fillStyle = ink;
        context.font = "12px system-ui, sans-serif";
        context.textAlign = "center";
        const legend = sorted.map((item) => String(item.name || "单品").slice(0, 12)).join(" · ");
        context.fillText(legend, cx, H - 10);

        setOutfitResult(canvas.toDataURL("image/png"));
      })
      .catch((stitchError) => setOutfitError(stitchError.message || "拼接失败，请重试。"))
      .finally(() => setOutfitLoading(false));
  }, [selectedOutfitIds, items]);

  return (
    <>
      <div className={`app-shell${selectedItem ? " has-selection" : ""}`}>
        <aside className="app-sidebar" aria-label="主导航">
          <div className="app-sidebar__brand">
            <span className="app-sidebar__logo">衣</span>
            <div className="app-sidebar__brand-text">
              <span className="app-sidebar__brand-name">衣橱</span>
              <span className="app-sidebar__brand-sub">WARDROBE</span>
            </div>
          </div>

          <nav className="app-nav" aria-label="主导航菜单">
            {[
              { id: "wardrobe", label: "衣橱", Icon: TShirt },
              { id: "settings", label: "设置", Icon: Gear },
            ].map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={`app-nav__item${activeNav === id ? " active" : ""}`}
                onClick={() => setActiveNav(id)}
                aria-pressed={activeNav === id}
              >
                <Icon size={18} weight={activeNav === id ? "fill" : "regular"} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <button type="button" className="app-import-btn" onClick={() => importTriggerRef.current?.click()}>
            <Plus size={16} weight="bold" aria-hidden="true" /> 导入单品
          </button>

          <div className="app-sidebar__profile">
            <div className="app-sidebar__avatar" aria-hidden="true">A</div>
            <div className="app-sidebar__profile-text">
              <p className="app-sidebar__profile-name">我的衣橱</p>
              <p className="app-sidebar__profile-email">{items.length} 件单品</p>
            </div>
          </div>
        </aside>

        <div className="app-main">
          <header className="app-topbar">
            <div className="app-topbar__title-group">
              <h1 className="app-topbar__title">{NAV_TITLES[activeNav]}</h1>
              <p className="app-topbar__subtitle">{items.length} 件单品</p>
            </div>
            <div className="app-topbar__controls">
              <div className="app-search">
                <MagnifyingGlass size={16} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="搜索单品"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="搜索衣橱单品"
                />
              </div>
              <button
                type="button"
                className="app-icon-btn"
                onClick={() => setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))}
                aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
              >
                {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className={`outfit-toggle${outfitMode ? " active" : ""}`}
                onClick={toggleOutfitMode}
                aria-pressed={outfitMode}
              >
                {outfitMode ? "退出搭配" : "搭配"}
              </button>
              <div className="app-topbar__avatar" aria-hidden="true">A</div>
            </div>
          </header>

          {activeNav === "wardrobe" ? (
            <main className="gallery-pane">
              <nav className="category-nav" aria-label="按单品种类筛选衣橱">
                {TYPES.map((type) => (
                  <button
                    key={type.id}
                    type="button"
                    className={activeType === type.id ? "active" : ""}
                    onClick={() => chooseType(type.id)}
                    aria-pressed={activeType === type.id}
                  >
                    {type.label}
                  </button>
                ))}
              </nav>

              {error && <p className="status error">{error}</p>}
              {!error && loading && <p className="status">正在加载衣橱</p>}
              {!error && !loading && !items.length && <p className="status empty">拖入、粘贴或添加照片，导入你的第一件单品。</p>}

              {!!items.length && (
                <section className={`gallery-grid${outfitMode ? " outfit-grid" : ""}`} aria-label={`${TYPE_MAP[activeType]?.label || "全部"} 衣橱单品`}>
                  {visibleItems.map((item) => (
                    <GalleryItem
                      key={item.id}
                      item={item}
                      selected={outfitMode ? selectedOutfitIds.includes(item.id) : selectedId === item.id}
                      onOpen={setSelectedId}
                      outfitMode={outfitMode}
                      onToggleOutfit={toggleOutfitItem}
                    />
                  ))}
                </section>
              )}
            </main>
          ) : activeNav === "settings" ? (
            <SettingsPanel />
          ) : (
            <div className="app-placeholder">
              <div className="app-placeholder__icon">
                <Gear size={32} weight="duotone" aria-hidden="true" />
              </div>
              <h2>{NAV_TITLES[activeNav]}模块建设中</h2>
              <p>该模块尚未实现，敬请期待。</p>
            </div>
          )}

          {selectedItem && !outfitMode && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} />}

          {outfitMode && selectedOutfitIds.length > 0 && (
            <div className="outfit-bar" role="region" aria-label="搭配生成">
              <span className="outfit-bar__count">已选 {selectedOutfitIds.length} 件</span>
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={() => setSelectedOutfitIds([])}>清空</button>
              <button className="secondary-button" type="button" onClick={stitchOutfit} disabled={outfitLoading}>
                直接拼接
              </button>
              <button className="primary-button" type="button" onClick={generateOutfit} disabled={outfitLoading}>
                {outfitLoading ? <SpinnerGap size={15} className="import-spinner" /> : <Check size={15} weight="bold" aria-hidden="true" />} 生成上身图
              </button>
            </div>
          )}

          {(outfitResult || outfitLoading || outfitError) && (
            <OutfitResultModal
              imageUrl={outfitResult}
              prompt={outfitPrompt}
              onPromptChange={setOutfitPrompt}
              onRegenerate={generateOutfit}
              onClose={() => { setOutfitResult(null); setOutfitError(""); setOutfitIsStitch(false); }}
              loading={outfitLoading}
              error={outfitError}
              isStitch={outfitIsStitch}
              onStitch={stitchOutfit}
            />
          )}
        </div>

        <WardrobeImportFlow onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} triggerRef={importTriggerRef} />
      </div>
      <div className="mobile-mount">
        <MobileHome
          items={visibleItems}
          activeCategory={activeType}
          onSelectCategory={chooseType}
          onOpenItem={(it) => setSelectedId(it.id)}
          activeTab="wardrobe"
          onSelectTab={() => {}}
        />
      </div>
    </>
  );
}
