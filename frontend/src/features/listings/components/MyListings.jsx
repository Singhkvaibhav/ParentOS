import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatEuro } from "../../../utils";
import SellForm from "./SellForm";
import { translateServerError } from "../../../i18n/errorMessages";

// A seller managing their own listings: edit, status transitions, delete.
// Receives the listings hook rather than owning it, because the profile
// page and the hook's refresh are shared with other surfaces.
export default function MyListings({ listingsHook, showToast }) {
  const { t } = useTranslation();
  const STATUS_LABEL = {
    active: t("myListings.statusActive"),
    reserved: t("myListings.statusReserved"),
    sold: t("myListings.statusSold"),
  };
  const { listings, loading, refresh, reserve, markSold, relist, remove } = listingsHook;
  const [editing, setEditing] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  async function run(fn) {
    try {
      await fn();
    } catch (e) {
      showToast(translateServerError(e.message, t));
    }
  }

  async function handleDelete(id) {
    await run(() => remove(id));
    setConfirmDeleteId(null);
  }

  return (
    <>
      <h2 className="uk-display page-title mt-5">{t("myListings.title")}</h2>
      {loading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : listings.length === 0 ? (
        <p className="muted">{t("myListings.empty")}</p>
      ) : (
        <div className="my-listings">
          {listings.map((l) => (
            <div key={l.id} className="my-listing-row">
              <div className="my-listing-info">
                <p className="my-listing-title">
                  {l.title}
                  <span className={`status-badge status-${l.status}`}>{STATUS_LABEL[l.status]}</span>
                </p>
                <p className="small">{formatEuro(l.price_cents)} &middot; {l.area}, {l.city}</p>
              </div>
              <div className="my-listing-actions">
                <button onClick={() => setEditing(l)} className="btn btn-outline btn-sm">{t("myListings.edit")}</button>
                {l.status === "active" && (
                  <button onClick={() => run(() => reserve(l.id))} className="btn btn-outline btn-sm">{t("myListings.markReserved")}</button>
                )}
                {l.status === "active" && (
                  <button onClick={() => run(() => markSold(l.id))} className="btn btn-outline btn-sm">{t("myListings.markSold")}</button>
                )}
                {l.status === "sold" && (
                  <button onClick={() => run(() => relist(l.id))} className="btn btn-moss btn-sm">{t("myListings.relist")}</button>
                )}
                {l.status === "reserved" && (
                  <span className="small">{t("myListings.paymentInProgress")}</span>
                )}
                {confirmDeleteId === l.id ? (
                  <>
                    <button onClick={() => handleDelete(l.id)} className="btn btn-berry btn-sm">{t("myListings.confirmDelete")}</button>
                    <button onClick={() => setConfirmDeleteId(null)} className="link-button">{t("myListings.cancel")}</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDeleteId(l.id)} className="btn btn-outline btn-sm">{t("myListings.delete")}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <SellForm
          editingListing={editing}
          onClose={() => setEditing(null)}
          onUpdated={refresh}
          showToast={showToast}
        />
      )}
    </>
  );
}
