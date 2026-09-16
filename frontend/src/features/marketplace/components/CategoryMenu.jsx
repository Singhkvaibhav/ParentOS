import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { subcategoryLabel } from "../../../constants";

// Stage 1 of the category redesign: a Vinted-style flyout (categories on
// the left, the hovered/tapped one's subcategories on the right) built
// entirely from what the backend already validates - see
// backend/config.js's SUBCATEGORIES. No category or subcategory appears
// here that the API wouldn't accept, which is the whole point of doing
// this in two stages rather than designing the menu first and hoping the
// data model catches up.
//
// `categories`/`subcategoriesByCategory` come from the parent
// (SearchFilters) rather than this component calling useMarketplaceConfig()
// itself - it's rendered as SearchFilters' child and needs the exact same
// config, so a second independent call here would just fire a second,
// redundant GET /api/meta/config on every mount.
//
// onSelect(categoryId, subcategoryId | null) - null means "this category,
// no specific subcategory" (the "View all X" row, or clicking the
// category itself).
export default function CategoryMenu({ categories, subcategoriesByCategory, onSelect }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!activeCategory && categories.length > 0) setActiveCategory(categories[0].id);
  }, [categories, activeCategory]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    function handleEscape(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const active = categories.find((c) => c.id === activeCategory);
  const subIds = subcategoriesByCategory[activeCategory] || [];

  function choose(categoryId, subcategoryId) {
    setOpen(false);
    onSelect(categoryId, subcategoryId);
  }

  return (
    <div className="category-menu" ref={containerRef}>
      <button
        type="button"
        className="category-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {t("categoryMenu.trigger")} <ChevronDown size={14} />
      </button>

      {open && (
        <div className="category-menu-panel">
          <div className="category-menu-list" role="tablist">
            {categories.map((c) => {
              const label = t(`categories.${c.id}`, { defaultValue: c.label });
              return (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={activeCategory === c.id}
                  className={`category-menu-item ${activeCategory === c.id ? "category-menu-item-active" : ""}`}
                  onMouseEnter={() => setActiveCategory(c.id)}
                  onClick={() => setActiveCategory(c.id)}
                >
                  <c.icon size={16} />
                  {label}
                </button>
              );
            })}
          </div>

          {active && (
            <div className="category-menu-sub">
              <button type="button" className="category-menu-viewall" onClick={() => choose(active.id, null)}>
                {t("categoryMenu.viewAll", { category: t(`categories.${active.id}`, { defaultValue: active.label }) })}
              </button>
              <div className="category-menu-sub-grid">
                {subIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="category-menu-sub-item"
                    onClick={() => choose(active.id, id)}
                  >
                    {t(`subcategories.${active.id}.${id}`, { defaultValue: subcategoryLabel(active.id, id) })}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
