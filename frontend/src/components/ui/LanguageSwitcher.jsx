import { useTranslation } from "react-i18next";

const LANGUAGES = ["fi", "en"];

export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = LANGUAGES.includes(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";

  return (
    <div className="lang-switch" role="group" aria-label={t("language.label")}>
      {LANGUAGES.map((lng) => (
        <button
          key={lng}
          onClick={() => i18n.changeLanguage(lng)}
          className={`lang-switch-option ${current === lng ? "lang-switch-active" : ""}`}
          aria-pressed={current === lng}
        >
          {t(`language.${lng}`)}
        </button>
      ))}
    </div>
  );
}
