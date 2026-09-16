import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X, Camera } from "lucide-react";
import { CITIES, AREA_DATA, areaEntry, sizeLabelFor, subcategoryLabel } from "../../../constants";
import { useMarketplaceConfig } from "../../marketplace/hooks/useMarketplaceConfig";
import { compressImage, eurosToCents } from "../../../utils";
import { listingsService } from "../../../services/listings";
import { uploadsService } from "../../../services/uploads";
import { useAuth } from "../../auth/hooks/useAuth";
import { translateServerError } from "../../../i18n/errorMessages";
import { track } from "../../../productAnalytics";

export default function SellForm({ onClose, onCreated, onUpdated, showToast, editingListing }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isEditing = !!editingListing;
  const { categories, conditions, subcategoriesByCategory, loaded: configLoaded, failed: configFailed } = useMarketplaceConfig();
  const [category, setCategory] = useState(editingListing?.category || null);
  const [subcategory, setSubcategory] = useState(editingListing?.subcategory || null);
  const [title, setTitle] = useState(editingListing?.title || "");
  const [price, setPrice] = useState(editingListing ? String((editingListing.price_cents / 100).toFixed(2)) : "");
  const [sizeOrAge, setSizeOrAge] = useState(editingListing?.size_or_age || "");
  const [condition, setCondition] = useState(editingListing?.condition || null);
  const [city, setCity] = useState(editingListing?.city || CITIES[0]);
  const [area, setArea] = useState(editingListing?.area || AREA_DATA[CITIES[0]][0].area);
  const [description, setDescription] = useState(editingListing?.description || "");
  // photoPreview is just for display (local blob URL or the already-stored
  // URL); photoUrl/photoThumbUrl are the real object-storage URLs that
  // actually get saved - the thumb is what the marketplace grid renders,
  // so listings created before it existed (or if generating one failed)
  // simply have none and the grid falls back to the full-size photo.
  const [photoPreview, setPhotoPreview] = useState(editingListing?.photo_url || null);
  const [photoUrl, setPhotoUrl] = useState(editingListing?.photo_url || null);
  const [photoThumbUrl, setPhotoThumbUrl] = useState(editingListing?.photo_thumb_url || null);
  const [photoBusy, setPhotoBusy] = useState(false);

  // Defaults are seeded from the server's list rather than hardcoded, so
  // the form can never pre-select a value the backend would reject.
  useEffect(() => {
    if (category === null && categories.length > 0) setCategory(categories[0].id);
    if (condition === null && conditions.length > 0) setCondition(conditions[1] ?? conditions[0]);
  }, [categories, conditions, category, condition]);
  const [submitting, setSubmitting] = useState(false);

  async function handlePhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoBusy(true);
    try {
      const localDataUrl = await compressImage(file);
      setPhotoPreview(localDataUrl); // shows instantly while the upload happens
      const { url, thumbUrl } = await uploadsService.uploadImage(localDataUrl);
      setPhotoUrl(url);
      setPhotoThumbUrl(thumbUrl || null);
    } catch {
      showToast(t("sellForm.toastPhotoFail"));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleSubmit() {
    if (!title.trim() || !(Number(price) > 0)) {
      showToast(t("sellForm.toastFillTitlePrice"));
      return;
    }
    if (photoBusy) {
      showToast(t("sellForm.toastStillUploading"));
      return;
    }
    setSubmitting(true);
    const priceCents = eurosToCents(price);
    try {
      if (isEditing) {
        const { listing } = await listingsService.update(
          editingListing.id,
          { category, subcategory, title: title.trim(), priceCents, sizeOrAge, condition, city, area, description, photoUrl, photoThumbUrl }
        );
        onUpdated(listing);
        showToast(t("sellForm.toastUpdated"));
      } else {
        const { listing } = await listingsService.create(
          { category, subcategory, title: title.trim(), priceCents, sizeOrAge, condition, city, area, description, photoUrl, photoThumbUrl }
        );
        onCreated(listing);
        track("listing_created", { category, hasPhoto: !!photoUrl });
        showToast(t("sellForm.toastPublished"));
      }
      onClose();
    } catch (e) {
      showToast(translateServerError(e, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title">{isEditing ? t("sellForm.editTitle") : t("sellForm.newTitle")}</h2>
          <button onClick={onClose} aria-label={t("listingDetails.closeAria")}><X size={20} /></button>
        </div>

        <p className="field-label">{t("sellForm.category")}</p>
        <div className="pill-row mb-4">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                // A subcategory belongs to the category it was picked
                // under - carrying it across to a different category would
                // either be meaningless or, once the server validates it,
                // rejected outright at submit time.
                if (c.id !== category) setSubcategory(null);
                setCategory(c.id);
              }}
              className={`pill pill-toggle ${category === c.id ? "pill-active" : ""}`}
            >
              <c.icon size={14} />{t(`categories.${c.id}`, { defaultValue: c.label })}
            </button>
          ))}
        </div>

        {(subcategoriesByCategory[category] || []).length > 0 && (
          <>
            <p className="field-label">{t("sellForm.subcategory")}</p>
            <div className="pill-row mb-4">
              {subcategoriesByCategory[category].map((id) => (
                <button
                  key={id}
                  onClick={() => setSubcategory(subcategory === id ? null : id)}
                  className={`pill pill-toggle ${subcategory === id ? "pill-active" : ""}`}
                >
                  {t(`subcategories.${category}.${id}`, { defaultValue: subcategoryLabel(category, id) })}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="form-stack">
          <div>
            <p className="field-label">{t("sellForm.photoLabel")}</p>
            <label className="photo-picker">
              <Camera size={16} style={{ color: "var(--stone)" }} />
              {photoBusy ? t("sellForm.uploading") : photoUrl ? t("sellForm.photoAddedTapReplace") : t("sellForm.takeOrChoosePhoto")}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhoto} />
            </label>
            {photoPreview && <img src={photoPreview} alt="" className="photo-preview" />}
          </div>

          <div>
            <p className="field-label">{t("sellForm.titleLabel")}</p>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("sellForm.titlePlaceholder")} className="input" />
          </div>

          <div className="two-col">
            <div>
              <p className="field-label">{t("sellForm.priceLabel")}</p>
              <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={t("sellForm.pricePlaceholder")} className="input" />
            </div>
            <div>
              <p className="field-label">{t(`sizeLabel.${sizeLabelFor(category)}`)}</p>
              <input value={sizeOrAge} onChange={(e) => setSizeOrAge(e.target.value)} placeholder={category === "toys" ? t("sellForm.agePlaceholderToys") : t("sellForm.sizePlaceholderOther")} className="input" />
            </div>
          </div>

          <div className="two-col">
            <div>
              <p className="field-label">{t("sellForm.conditionLabel")}</p>
              <select value={condition} onChange={(e) => setCondition(e.target.value)} className="select select-full">
                {conditions.map((c) => <option key={c} value={c}>{t(`conditions.${c}`, { defaultValue: c })}</option>)}
              </select>
            </div>
            <div>
              <p className="field-label">{t("sellForm.cityLabel")}</p>
              <select value={city} onChange={(e) => { setCity(e.target.value); setArea(AREA_DATA[e.target.value][0].area); }} className="select select-full">
                {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="two-col">
            <div>
              <p className="field-label">{t("sellForm.areaLabel")}</p>
              <select value={area} onChange={(e) => setArea(e.target.value)} className="select select-full">
                {AREA_DATA[city].map((a) => <option key={a.area} value={a.area}>{a.area}</option>)}
              </select>
            </div>
            <div>
              <p className="field-label">{t("sellForm.pincodeLabel")}</p>
              <input value={areaEntry(city, area)?.pincode || ""} readOnly disabled className="input input-disabled" />
            </div>
          </div>

          <div>
            <p className="field-label">{t("sellForm.descriptionLabel")}</p>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder={t("sellForm.descriptionPlaceholder")} className="input textarea" />
          </div>
        </div>

        {configFailed && (
          <p className="small">
            {t("sellForm.configFailed")}
          </p>
        )}
        <button
          onClick={handleSubmit}
          /* Disabled until the server has told us what's valid. Publishing
             with guessed categories/conditions would fail validation at
             submit time with a confusing error, after the user has already
             filled the whole form. */
          disabled={submitting || !configLoaded || configFailed || !category || !condition}
          className="btn btn-berry btn-block mt-5"
        >
          {submitting ? t("sellForm.saving") : isEditing ? t("sellForm.saveChanges") : t("sellForm.publishListing")}
        </button>
      </div>
    </div>
  );
}
