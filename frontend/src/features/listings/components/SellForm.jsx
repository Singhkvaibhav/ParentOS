import { useState, useEffect } from "react";
import { X, Camera } from "lucide-react";
import { CITIES, AREA_DATA, areaEntry, sizeLabelFor } from "../../../constants";
import { useMarketplaceConfig } from "../../marketplace/hooks/useMarketplaceConfig";
import { compressImage, eurosToCents } from "../../../utils";
import { listingsService } from "../../../services/listings";
import { uploadsService } from "../../../services/uploads";
import { useAuth } from "../../auth/hooks/useAuth";

export default function SellForm({ onClose, onCreated, onUpdated, showToast, editingListing }) {
  const { user } = useAuth();
  const isEditing = !!editingListing;
  const { categories, conditions, loaded: configLoaded, failed: configFailed } = useMarketplaceConfig();
  const [category, setCategory] = useState(editingListing?.category || null);
  const [title, setTitle] = useState(editingListing?.title || "");
  const [price, setPrice] = useState(editingListing ? String((editingListing.price_cents / 100).toFixed(2)) : "");
  const [sizeOrAge, setSizeOrAge] = useState(editingListing?.size_or_age || "");
  const [condition, setCondition] = useState(editingListing?.condition || null);
  const [city, setCity] = useState(editingListing?.city || CITIES[0]);
  const [area, setArea] = useState(editingListing?.area || AREA_DATA[CITIES[0]][0].area);
  const [description, setDescription] = useState(editingListing?.description || "");
  // photoPreview is just for display (local blob URL or the already-stored
  // URL); photoUrl is the real object-storage URL that actually gets saved.
  const [photoPreview, setPhotoPreview] = useState(editingListing?.photo_url || null);
  const [photoUrl, setPhotoUrl] = useState(editingListing?.photo_url || null);
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
      const { url } = await uploadsService.uploadImage(localDataUrl);
      setPhotoUrl(url);
    } catch {
      showToast("Couldn't upload that photo - try another one.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleSubmit() {
    if (!title.trim() || !(Number(price) > 0)) {
      showToast("Fill in a title and a price above \u20ac0.");
      return;
    }
    if (photoBusy) {
      showToast("Still uploading the photo - one second.");
      return;
    }
    setSubmitting(true);
    const priceCents = eurosToCents(price);
    try {
      if (isEditing) {
        const { listing } = await listingsService.update(
          editingListing.id,
          { category, title: title.trim(), priceCents, sizeOrAge, condition, city, area, description, photoUrl }
        );
        onUpdated(listing);
        showToast("Listing updated.");
      } else {
        const { listing } = await listingsService.create(
          { category, title: title.trim(), priceCents, sizeOrAge, condition, city, area, description, photoUrl }
        );
        onCreated(listing);
        showToast("Listing published.");
      }
      onClose();
    } catch (e) {
      showToast(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title">{isEditing ? "Edit listing" : "List an item"}</h2>
          <button onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <p className="field-label">Category</p>
        <div className="pill-row mb-4">
          {categories.map((c) => (
            <button key={c.id} onClick={() => setCategory(c.id)} className={`pill pill-toggle ${category === c.id ? "pill-active" : ""}`}>
              <c.icon size={14} />{c.label}
            </button>
          ))}
        </div>

        <div className="form-stack">
          <div>
            <p className="field-label">Photo (optional)</p>
            <label className="photo-picker">
              <Camera size={16} style={{ color: "var(--stone)" }} />
              {photoBusy ? "Uploading..." : photoUrl ? "Photo added - tap to replace" : "Take or choose a photo"}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhoto} />
            </label>
            {photoPreview && <img src={photoPreview} alt="Listing preview" className="photo-preview" />}
          </div>

          <div>
            <p className="field-label">Title</p>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Reima winter overalls" className="input" />
          </div>

          <div className="two-col">
            <div>
              <p className="field-label">Price (\u20ac)</p>
              <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="15" className="input" />
            </div>
            <div>
              <p className="field-label">{sizeLabelFor(category)}</p>
              <input value={sizeOrAge} onChange={(e) => setSizeOrAge(e.target.value)} placeholder={category === "toys" ? "3+ years" : "86 cm"} className="input" />
            </div>
          </div>

          <div className="two-col">
            <div>
              <p className="field-label">Condition</p>
              <select value={condition} onChange={(e) => setCondition(e.target.value)} className="select select-full">
                {conditions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <p className="field-label">City</p>
              <select value={city} onChange={(e) => { setCity(e.target.value); setArea(AREA_DATA[e.target.value][0].area); }} className="select select-full">
                {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="two-col">
            <div>
              <p className="field-label">Area</p>
              <select value={area} onChange={(e) => setArea(e.target.value)} className="select select-full">
                {AREA_DATA[city].map((a) => <option key={a.area} value={a.area}>{a.area}</option>)}
              </select>
            </div>
            <div>
              <p className="field-label">Pincode</p>
              <input value={areaEntry(city, area)?.pincode || ""} readOnly disabled className="input input-disabled" />
            </div>
          </div>

          <div>
            <p className="field-label">Description</p>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Condition details, why you're selling, anything a buyer should know." className="input textarea" />
          </div>
        </div>

        {configFailed && (
          <p className="small">
            Couldn&apos;t load the marketplace settings, so publishing is unavailable right now.
            Please refresh and try again.
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
          {submitting ? "Saving..." : isEditing ? "Save changes" : "Publish listing"}
        </button>
      </div>
    </div>
  );
}
