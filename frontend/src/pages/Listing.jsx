import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listingsService } from "../services/listings";
import ListingDetails from "../features/listings/components/ListingDetails";
import { useFavorites } from "../features/listings/hooks/useFavorites";
import { useAuth } from "../features/auth/hooks/useAuth";
import { translateServerError } from "../i18n/errorMessages";

// Deep-link page for a single listing (e.g. shared link). Reuses the same
// detail modal as the marketplace grid, just opened directly from a URL.
export default function Listing() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const favorites = useFavorites(!!user);
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    listingsService.get(id).then((res) => setListing(res.listing)).catch((e) => setError(translateServerError(e.message, t)));
  }, [id, t]);

  if (error) return <p className="muted p-6">{error}</p>;
  if (!listing) return <p className="muted p-6">{t("common.loading")}</p>;

  return (
    <ListingDetails
      listing={listing}
      onClose={() => navigate("/marketplace")}
      showToast={() => {}}
      favorites={favorites}
      onRequireLogin={() => navigate("/marketplace")}
    />
  );
}
