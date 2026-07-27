import React from "react";

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
  { id: "wardrobe", label: "衣橱" },
  { id: "me", label: "我的" },
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
 */
export function MobileHome({
  items = [],
  activeCategory = "all",
  onSelectCategory,
  onOpenItem,
  activeTab = "wardrobe",
  onSelectTab,
}) {
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
        <span className="m-brand">衣橱</span>
        <div className="m-appbar-actions">
          <button className="m-icon-btn" type="button" aria-label="搜索">
            <span className="m-glyph">⌕</span>
          </button>
          <div className="m-avatar">A</div>
        </div>
      </header>

      <div className="m-search">
        <span className="m-glyph">⌕</span>
        <input placeholder="搜索单品、颜色、风格…" />
      </div>

      <nav className="m-chips">
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

      <section className="m-video-section">
        <h2 className="m-section-label">穿搭视频</h2>
        <div className="m-video-card">
          <button className="m-play" type="button" aria-label="播放穿搭视频">
            <span />
          </button>
          <span className="m-video-title">秋冬通勤 · 驼色风衣</span>
          <span className="m-duration">0:42</span>
        </div>
      </section>

      <section className="m-gallery-section">
        <h2 className="m-section-label">我的衣橱</h2>
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
      </section>

      <nav className="m-tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"m-tab" + (t.id === activeTab ? " active" : "")}
            onClick={() => onSelectTab && onSelectTab(t.id)}
          >
            <span className="m-tab-icon" />
            <span className="m-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
