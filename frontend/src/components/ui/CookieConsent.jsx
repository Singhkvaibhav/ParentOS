import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENABLED, hasAnsweredConsent, setConsent } from "../../productAnalytics";

// Renders nothing at all when analytics isn't configured (ENABLED false) -
// there's nothing to ask consent for. See productAnalytics.js: nothing is
// captured until Accept is pressed (opt_out_capturing_by_default: true).
export default function CookieConsent() {
  const { t } = useTranslation();
  const [answered, setAnswered] = useState(true);

  useEffect(() => {
    if (ENABLED) setAnswered(hasAnsweredConsent());
  }, []);

  if (!ENABLED || answered) return null;

  function respond(accepted) {
    setConsent(accepted);
    setAnswered(true);
  }

  return (
    <div className="cookie-consent" role="dialog" aria-live="polite">
      <p className="small">{t("cookieConsent.message")}</p>
      <div className="cookie-consent-actions">
        <button className="btn btn-outline btn-sm" onClick={() => respond(false)}>
          {t("cookieConsent.decline")}
        </button>
        <button className="btn btn-berry btn-sm" onClick={() => respond(true)}>
          {t("cookieConsent.accept")}
        </button>
      </div>
    </div>
  );
}
