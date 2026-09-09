import { useState } from "react";
import { X } from "lucide-react";
import { useAuth } from "../hooks/useAuth";

export default function AuthModal({ initialView = "login", onClose, showToast }) {
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
      if (res.warning === "email-send-failed") showToast("Couldn't send the verification email right now - try \"resend code\" in a moment.");
      setView("verify");
    } catch (e) {
      showToast(e.message);
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
      showToast(e.message);
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
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet modal-sheet-small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title">
            {view === "signup" ? "Create your account" : view === "verify" ? "Verify your email" : "Log in"}
          </h2>
          <button onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        {view === "verify" ? (
          <div className="form-stack">
            <p className="small">{verifyMessage || "Enter the verification code."}</p>
            {devCode && (
              <>
                <p className="small">This build has email verification codes visible for testing - a real deployment wouldn't show this:</p>
                <p className="uk-display verify-code">{devCode}</p>
              </>
            )}
            <div>
              <p className="field-label">Enter the code</p>
              <input value={code} onChange={(e) => setCode(e.target.value)} className="input" />
            </div>
            <button onClick={handleVerify} disabled={busy} className="btn btn-moss btn-block">Confirm</button>
          </div>
        ) : view === "signup" ? (
          <div className="form-stack">
            <div><p className="field-label">Your name</p><input value={name} onChange={(e) => setName(e.target.value)} className="input" /></div>
            <div><p className="field-label">Email</p><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="input" /></div>
            <div><p className="field-label">Password</p><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="input" /></div>
            <button onClick={handleSignup} disabled={busy} className="btn btn-berry btn-block">Sign up</button>
            <p className="small center">Already have an account? <button className="link-button" onClick={() => setView("login")}>Log in</button></p>
          </div>
        ) : (
          <div className="form-stack">
            <div><p className="field-label">Email</p><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="input" /></div>
            <div><p className="field-label">Password</p><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="input" /></div>
            <button onClick={handleLogin} disabled={busy} className="btn btn-moss btn-block">Log in</button>
            <p className="small center">New here? <button className="link-button" onClick={() => setView("signup")}>Create an account</button></p>
          </div>
        )}
      </div>
    </div>
  );
}
