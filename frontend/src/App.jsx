import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LogIn,
  LogOut,
  Inbox as InboxIcon,
  Plus,
  Search,
} from "lucide-react";
import AuthModal from "./features/auth/components/AuthModal";
import Inbox from "./features/messaging/components/Inbox";
import NotificationBell from "./features/notifications/components/NotificationBell";
import LanguageSwitcher from "./components/ui/LanguageSwitcher";
import { useAuth } from "./features/auth/hooks/useAuth";
import { useConversations } from "./features/messaging/hooks/useMessages";
import { useNotifications } from "./features/notifications/hooks/useNotifications";
import { useToast } from "./hooks/useToast";
import AppRoutes from "./app/routes";

export default function App() {
  const { t } = useTranslation();
  const { user, logout, loading } = useAuth();
  const navigate = useNavigate();
  const [authView, setAuthView] = useState(null);
  const [showInbox, setShowInbox] = useState(false);
  const { toast, showToast } = useToast();
  const conversationsHook = useConversations(!!user);
  const notificationsHook = useNotifications(!!user);

  return (
    <div className="uk-root">
      <header className="app-header">
        <Link to="/" className="uk-display brand">
          Uusiksi
        </Link>

        <div className="header-search">
          <Search size={18} aria-hidden="true" />

          <input
            type="search"
            placeholder={t("header.searchPlaceholder")}
            aria-label={t("header.searchAriaLabel")}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;

              const query = event.currentTarget.value.trim();

              if (query) {
                navigate(`/marketplace?q=${encodeURIComponent(query)}`);
              } else {
                navigate("/marketplace");
              }
            }}
          />
        </div>

        <div className="header-actions">
          <LanguageSwitcher />
          {user && <NotificationBell notificationsHook={notificationsHook} />}
          {user && (
            <button onClick={() => setShowInbox(true)} className="icon-button" aria-label={t("header.inboxAria")} style={{ position: "relative" }}>
              <InboxIcon size={16} />
              {conversationsHook.totalUnread > 0 && <span className="unread-dot" style={{ position: "absolute", top: "-4px", right: "-4px" }}>{conversationsHook.totalUnread}</span>}
            </button>
          )}
          {!loading && (user ? (
            <>
              {user.isAdmin && (
                <Link to="/moderation" className="header-link">{t("header.moderation")}</Link>
              )}
              <Link to="/profile" className="header-link">{t("header.greeting", { name: user.name.split(" ")[0] })}</Link>
              <button onClick={logout} className="icon-button" aria-label={t("header.logoutAria")}><LogOut size={16} /></button>
            </>
          ) : (
            <button onClick={() => setAuthView("login")} className="btn btn-outline btn-sm"><LogIn size={14} /> {t("header.login")}</button>
          ))}
          <button onClick={() => navigate("/marketplace?sell=1")} className="btn btn-berry btn-sm"><Plus size={16} /> {t("header.sell")}</button>
        </div>
      </header>

      <AppRoutes showToast={showToast} />

      <footer className="app-footer">
        <div className="app-footer-inner">
          <div className="app-footer-brand">
            <span className="uk-display brand">Uusiksi</span>
            <p className="small">{t("footer.tagline")}</p>
          </div>
          <p className="small app-footer-copyright">{t("footer.copyright", { year: new Date().getFullYear() })}</p>
        </div>
      </footer>

      {authView && <AuthModal initialView={authView} onClose={() => setAuthView(null)} showToast={showToast} />}
      {showInbox && <Inbox onClose={() => setShowInbox(false)} conversationsHook={conversationsHook} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
