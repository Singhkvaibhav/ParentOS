import { useTranslation } from "react-i18next";
import { usePayouts } from "../hooks/usePayouts";

// Stripe Connect onboarding. Owns its own state, so the profile page
// doesn't carry payout concerns it otherwise has nothing to do with.
export default function PayoutSetup({ enabled }) {
  const { t } = useTranslation();
  const { status, onboarding, error, startOnboarding } = usePayouts(enabled);

  return (
    <>
      <h2 className="uk-display page-title mt-5">{t("payouts.title")}</h2>
      <div className="profile-card">
        {status?.payoutsEnabled ? (
          <p className="small">{t("payouts.enabled")}</p>
        ) : (
          <>
            <p className="small mb-3">
              {status?.connected
                ? t("payouts.started")
                : t("payouts.notStarted")}
            </p>
            <button onClick={startOnboarding} disabled={onboarding} className="btn btn-moss">
              {onboarding ? t("payouts.redirecting") : status?.connected ? t("payouts.finishSetup") : t("payouts.setUp")}
            </button>
          </>
        )}
        {error && <p className="small">{error}</p>}
      </div>
    </>
  );
}
