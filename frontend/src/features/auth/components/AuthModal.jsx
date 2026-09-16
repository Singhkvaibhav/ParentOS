import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { translateServerError } from "../../../i18n/errorMessages";

export default function AuthModal({ initialView = "login", onClose, showToast }) {
  const { t } = useTranslation();
  const { signup, verify, login } = useAuth();
  const [view, setView] = useState(initialView);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState(null);
  const [verifyMessage, setVerifyMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSignup() {
    setBusy(true);
    try {
      const res = await signup(name, email, password);
      setDevCode(res.devCode); // only present outside production - see backend/services/authService.js
      setVerifyMessage(res.message);
      if (res.warning === "email-send-failed") showToast(t("auth.emailVerificationFailToast"));
      setView("verify");
    } catch (e) {
      showToast(translateServerError(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setBusy(true);
    try {
      await verify(email, code);
      onClose();
    } catch (e) {
      showToast(translateServerError(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin() {
    setBusy(true);
    try {
      await login(email, password);
      onClose();
    } catch (e) {
      showToast(translateServerError(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet modal-sheet-small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title">
            {view === "signup" ? t("auth.createAccount") : view === "verify" ? t("auth.verifyEmail") : t("auth.login")}
          </h2>
          <button onClick={onClose} aria-label={t("listingDetails.closeAria")}><X size={20} /></button>
        </div>

        {view === "verify" ? (
          <div className="form-stack">
            <p className="small">{verifyMessage || t("auth.enterCodeDefault")}</p>
            {devCode && (
              <>
                <p className="small">{t("auth.devCodeNotice")}</p>
                <p className="uk-display verify-code">{devCode}</p>
              </>
            )}
            <div>
              <p className="field-label">{t("auth.enterCodeLabel")}</p>
              <input value={code} onChange={(e) => setCode(e.target.value)} className="input" />
            </div>
            <button onClick={handleVerify} disabled={busy} className="btn btn-moss btn-block">{t("auth.confirm")}</button>
          </div>
        ) : view === "signup" ? (
          <div className="form-stack">
            <div><p className="field-label">{t("auth.yourName")}</p><input value={name} onChange={(e) => setName(e.target.value)} className="input" /></div>
            <div><p className="field-label">{t("auth.email")}</p><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="input" /></div>
            <div><p className="field-label">{t("auth.password")}</p><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="input" /></div>
            <button onClick={handleSignup} disabled={busy} className="btn btn-berry btn-block">{t("auth.signUp")}</button>
            <p className="small center">{t("auth.alreadyHaveAccount")} <button className="link-button" onClick={() => setView("login")}>{t("auth.login")}</button></p>
          </div>
        ) : (
          <div className="form-stack">
            <div><p className="field-label">{t("auth.email")}</p><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="input" /></div>
            <div><p className="field-label">{t("auth.password")}</p><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="input" /></div>
            <button onClick={handleLogin} disabled={busy} className="btn btn-moss btn-block">{t("auth.login")}</button>
            <p className="small center">{t("auth.newHere")} <button className="link-button" onClick={() => setView("signup")}>{t("auth.createAnAccount")}</button></p>
          </div>
        )}
      </div>
    </div>
  );
}
