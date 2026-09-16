import { useTranslation } from "react-i18next";

// Curated display order for the two languages shipped today (Finnish
// first). Filtered against i18n's own `supportedLngs` (i18n/index.js)
// rather than assumed here as a second hardcoded list - so a language
// added there in the future shows up automatically instead of silently
// staying invisible until someone remembers to also update this file.
const PREFERRED_ORDER = ["fi", "en"];

export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const supported = i18n.options.supportedLngs?.filter((l) => l !== "cimode") ?? PREFERRED_ORDER;
  const languages = [
    ...PREFERRED_ORDER.filter((l) => supported.includes(l)),
    ...supported.filter((l) => !PREFERRED_ORDER.includes(l)),
  ];
  const current = languages.includes(i18n.resolvedLanguage) ? i18n.resolvedLanguage : languages[0];

  return (
    <div className="lang-switch" role="group" aria-label={t("language.label")}>
      {languages.map((lng) => (
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
