import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogIn, LogOut, Inbox as InboxIcon, Plus } from "lucide-react";
import AuthModal from "./features/auth/components/AuthModal";
import Inbox from "./features/messaging/components/Inbox";
import NotificationBell from "./features/notifications/components/NotificationBell";
import { useAuth } from "./features/auth/hooks/useAuth";
import { useConversations } from "./features/messaging/hooks/useMessages";
import { useNotifications } from "./features/notifications/hooks/useNotifications";
import { useToast } from "./hooks/useToast";
import AppRoutes from "./app/routes";

export default function App() {
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
        <Link to="/" className="uk-display brand">Uusiksi</Link>
        <div className="header-actions">
          {user && <NotificationBell notificationsHook={notificationsHook} />}
          {user && (
            <button onClick={() => setShowInbox(true)} className="icon-button" aria-label="Inbox" style={{ position: "relative" }}>
              <InboxIcon size={16} />
              {conversationsHook.totalUnread > 0 && <span className="unread-dot" style={{ position: "absolute", top: "-4px", right: "-4px" }}>{conversationsHook.totalUnread}</span>}
            </button>
          )}
          {!loading && (user ? (
            <>
              {user.isAdmin && (
                <Link to="/moderation" className="header-name" style={{ textDecoration: "underline" }}>Moderation</Link>
              )}
              <Link to="/profile" className="header-name" style={{ textDecoration: "underline" }}>Hi, {user.name.split(" ")[0]}</Link>
              <button onClick={logout} className="icon-button" aria-label="Log out"><LogOut size={16} /></button>
            </>
          ) : (
            <button onClick={() => setAuthView("login")} className="btn btn-outline btn-sm"><LogIn size={14} /> Log in</button>
          ))}
          <button onClick={() => navigate("/marketplace?sell=1")} className="btn btn-berry btn-sm"><Plus size={16} /> Sell an item</button>
        </div>
      </header>

      <AppRoutes showToast={showToast} />

      <footer className="app-footer">
        <p className="small">Uusiksi is a Helsinki-area MVP with real authentication, messaging, and Stripe payments - see the project README's "Known limitations" section for what's still worth addressing before a real launch.</p>
      </footer>

      {authView && <AuthModal initialView={authView} onClose={() => setAuthView(null)} showToast={showToast} />}
      {showInbox && <Inbox onClose={() => setShowInbox(false)} conversationsHook={conversationsHook} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
