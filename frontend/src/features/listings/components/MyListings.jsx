import { useState } from "react";
import { formatEuro } from "../../../utils";
import SellForm from "./SellForm";

const STATUS_LABEL = { active: "Active", reserved: "Reserved", sold: "Sold" };

// A seller managing their own listings: edit, status transitions, delete.
// Receives the listings hook rather than owning it, because the profile
// page and the hook's refresh are shared with other surfaces.
export default function MyListings({ listingsHook, showToast }) {
  const { listings, loading, refresh, reserve, markSold, relist, remove } = listingsHook;
  const [editing, setEditing] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  async function run(fn) {
    try {
      await fn();
    } catch (e) {
      showToast(e.message);
    }
  }

  async function handleDelete(id) {
    await run(() => remove(id));
    setConfirmDeleteId(null);
  }

  return (
    <>
      <h2 className="uk-display page-title mt-5">My listings</h2>
      {loading ? (
        <p className="muted">Loading...</p>
      ) : listings.length === 0 ? (
        <p className="muted">You haven&apos;t listed anything yet.</p>
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
                <button onClick={() => setEditing(l)} className="btn btn-outline btn-sm">Edit</button>
                {l.status === "active" && (
                  <button onClick={() => run(() => reserve(l.id))} className="btn btn-outline btn-sm">Mark reserved</button>
                )}
                {l.status === "active" && (
                  <button onClick={() => run(() => markSold(l.id))} className="btn btn-outline btn-sm">Mark sold</button>
                )}
                {l.status === "sold" && (
                  <button onClick={() => run(() => relist(l.id))} className="btn btn-moss btn-sm">Relist</button>
                )}
                {l.status === "reserved" && (
                  <span className="small">Payment in progress - resolves automatically</span>
                )}
                {confirmDeleteId === l.id ? (
                  <>
                    <button onClick={() => handleDelete(l.id)} className="btn btn-berry btn-sm">Confirm delete</button>
                    <button onClick={() => setConfirmDeleteId(null)} className="link-button">Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDeleteId(l.id)} className="btn btn-outline btn-sm">Delete</button>
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
