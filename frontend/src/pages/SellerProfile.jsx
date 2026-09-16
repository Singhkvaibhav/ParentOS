import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usersService } from "../services/users";
import { reviewsService } from "../services/reviews";
import { listingsService } from "../services/listings";
import TrustBadge from "../features/profile/components/TrustBadge";
import ListingGrid from "../features/listings/components/ListingGrid";
import { translateServerError } from "../i18n/errorMessages";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

// The "Seller profile" node in the user journey: a buyer deciding whether
// to deal with someone needs to see who they are, what else they're
// selling, and what previous buyers said - all in one place, rather than
// inferring it from a single listing card.
export default function SellerProfile() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const [profile, setProfile] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [listings, setListings] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    usersService.publicProfile(id)
      .then((d) => { if (!cancelled) setProfile(d.user); })
      .catch((e) => { if (!cancelled) setError(translateServerError(e, t)); });

    reviewsService.listForUser(id)
      .then((d) => { if (!cancelled) setReviews(d.reviews); })
      .catch(() => { /* reviews are supplementary - don't fail the page */ });

    // No dedicated "listings by seller" endpoint exists, and adding one
    // just for this would duplicate the browse endpoint's filtering,
    // pagination and moderation rules. Filtering the public feed keeps a
    // single code path - worth revisiting if a seller ever has more
    // listings than one page.
    listingsService.list({ limit: 100 })
      .then((d) => {
        if (!cancelled) setListings(d.listings.filter((l) => String(l.seller_id) === String(id)));
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [id, t]);

  useDocumentTitle(profile?.name);

  if (error) return <p className="muted p-6">{error}</p>;
  if (!profile) return <p className="muted p-6">{t("common.loading")}</p>;

  return (
    <section className="page-section">
      <h1 className="uk-display page-title">{profile.name}</h1>

      <div className="profile-card">
        {profile.trust && <TrustBadge trust={profile.trust} />}
        <p className="small">
          {t("sellerProfile.memberSince", { date: new Date(profile.created_at).toLocaleDateString(i18n.resolvedLanguage) })}
          {profile.listingCount > 0 && t("sellerProfile.listingCount", { count: profile.listingCount })}
        </p>
      </div>

      <h2 className="uk-display page-title mt-5">{t("sellerProfile.theirListings")}</h2>
      {listings.length === 0 ? (
        <p className="muted">{t("sellerProfile.nothingListed")}</p>
      ) : (
        <ListingGrid
          listings={listings}
          loading={false}
          onSelect={(l) => { window.location.href = `/listing/${l.id}`; }}
        />
      )}

      <h2 className="uk-display page-title mt-5">{t("sellerProfile.reviews")}</h2>
      {reviews.length === 0 ? (
        <p className="muted">{t("sellerProfile.noReviews")}</p>
      ) : (
        <div className="inbox-list">
          {reviews.map((r) => (
            <div key={r.id} className="inbox-item">
              <p className="inbox-item-title">
                {"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)} · {r.reviewer_name}
              </p>
              {r.comment && <p className="small">{r.comment}</p>}
            </div>
          ))}
        </div>
      )}

      <p className="mt-4"><Link to="/marketplace" className="link-button">{t("sellerProfile.backToBrowsing")}</Link></p>
    </section>
  );
}
