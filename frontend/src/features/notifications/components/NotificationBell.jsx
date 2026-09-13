import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, X } from "lucide-react";

function timeAgo(iso, t) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t("notifications.justNow");
  if (seconds < 3600) return t("notifications.minutesAgo", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("notifications.hoursAgo", { count: Math.floor(seconds / 3600) });
  return t("notifications.daysAgo", { count: Math.floor(seconds / 86400) });
}

export default function NotificationBell({ notificationsHook }) {
  const { t } = useTranslation();
  const { notifications, unreadCount, markAllRead } = notificationsHook;
  const [open, setOpen] = useState(false);

  function handleOpen() {
    setOpen(true);
    // Opening the panel is the natural "I've seen these" moment - making
    // the user click each one to clear a badge would be busywork.
    if (unreadCount > 0) markAllRead();
  }

  return (
    <>
      <button onClick={handleOpen} className="icon-button" aria-label={t("header.notificationsAria")} style={{ position: "relative" }}>
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="unread-dot" style={{ position: "absolute", top: "-4px", right: "-4px" }}>
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal-sheet modal-sheet-small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="uk-display modal-title">{t("notifications.title")}</h2>
              <button onClick={() => setOpen(false)} aria-label={t("listingDetails.closeAria")}><X size={20} /></button>
            </div>

            {notifications.length === 0 ? (
              <p className="muted">{t("notifications.empty")}</p>
            ) : (
              <div className="inbox-list">
                {notifications.map((n) => (
                  <div key={n.id} className="inbox-item">
                    <p className="inbox-item-title">{n.title}</p>
                    {n.body && <p className="uk-clamp2 small">{n.body}</p>}
                    <p className="small">{timeAgo(n.created_at, t)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
