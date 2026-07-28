import React from "react";
import { TShirt, User, Plus, Gear, MagnifyingGlass } from "@phosphor-icons/react";
import { SettingsPanel } from "./SettingsPanel.jsx";

const CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "upperbody", label: "上衣" },
  { id: "wholebody_up", label: "外套" },
  { id: "lowerbody", label: "下装" },
  { id: "accessories_up", label: "配饰" },
  { id: "necklace", label: "项链" },
  { id: "bag", label: "包包" },
  { id: "shoes", label: "鞋履" },
];

const TABS = [
  { id: "wardrobe", label: "衣橱", Icon: TShirt },
  { id: "me", label: "我的", Icon: User },
];

const TYPE_LABEL = {
  upperbody: "上衣",
  wholebody_up: "外套",
  lowerbody: "下装",
  accessories_up: "配饰",
  necklace: "项链",
  bag: "包包",
  shoes: "鞋履",
};

/**
 * 手机端首页（与 Ardot 设计稿 12:1 一致）。
 * 纯展示组件：传入 items 即可渲染，交互通过回调上抛。
 * activeTab === "wardrobe" → 衣橱网格 + 顶部"导入"按钮
 * activeTab === "me"      → SettingsPanel（设置：DashScope API Key / 参考图 / 模型选择）
 */
export function MobileHome({
  items = [],
  activeCategory = "all",
  onSelectCategory,
  onOpenItem,
  onImport,
  activeTab = "wardrobe",
  onSelectTab,
}) {
  const onMe = activeTab === "me";
  const grid = items.slice(0, 6).map((item) => ({
    id: item.id,
    name: item.name || "未命名",
    type: TYPE_LABEL[item.part] || item.part || "",
    image: item.image || item.previewUrl || null,
    colors: Array.isArray(item.palette) ? item.palette.slice(0, 2) : [],
  }));

  return (
    <div className="mobile-home">
      <div className="m-statusbar">
        <span>9:41</span>
        <span className="m-battery" />
      </div>

      <header className="m-appbar">
        <span className="m-brand">{onMe ? "设置" : "衣橱"}</span>
        <div className="m-appbar-actions">
          {!onMe && (
            <button
              className="m-icon-btn"
              type="button"
              aria-label="导入单品"
              onClick={() => onImport && onImport()}
            >
              <Plus size={18} weight="bold" aria-hidden="true" />
            </button>
          )}
          <button
            className="m-icon-btn"
            type="button"
            aria-label="搜索"
          >
            <MagnifyingGlass size={18} aria-hidden="true" />
          </button>
          <button
            className={"m-icon-btn" + (onMe ? " active" : "")}
            type="button"
            aria-label="设置"
            onClick={() => onSelectTab && onSelectTab(onMe ? "wardrobe" : "me")}
            aria-pressed={onMe}
          >
            <Gear size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      {!onMe && (
        <>
          <div className="m-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input placeholder="搜索单品、颜色、风格…" />
          </div>

          <nav className="m-chips" aria-label="按单品种类筛选">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={"m-chip" + (c.id === activeCategory ? " active" : "")}
                onClick={() => onSelectCategory && onSelectCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </nav>

          <section className="m-gallery-section">
            <h2 className="m-section-label">我的衣橱</h2>
            {grid.length === 0 ? (
              <p className="m-empty-hint">点击右上角 + 导入你的第一件单品</p>
            ) : (
              <div className="m-grid">
                {grid.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="m-card"
                    onClick={() => onOpenItem && onOpenItem(item)}
                  >
                    <div
                      className="m-card-img"
                      style={
                        item.image
                          ? { backgroundImage: `url(${item.image})` }
                          : undefined
                      }
                    />
                    <div className="m-card-info">
                      <div className="m-card-name">{item.name}</div>
                      <div className="m-card-row">
                        <span className="m-card-type">{item.type}</span>
                        <span className="m-swatches">
                          {item.colors.map((c, i) => (
                            <span
                              className="m-swatch"
                              key={i}
                              style={{ background: c }}
                            />
                          ))}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {onMe && (
        <main className="m-settings-mount">
          <SettingsPanel />
        </main>
      )}

      <nav className="m-tabbar" aria-label="主导航">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={"m-tab" + (id === activeTab ? " active" : "")}
            onClick={() => onSelectTab && onSelectTab(id)}
            aria-pressed={id === activeTab}
          >
            <Icon size={22} weight={id === activeTab ? "fill" : "regular"} aria-hidden="true" />
            <span className="m-tab-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}