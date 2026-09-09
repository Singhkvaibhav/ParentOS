import { useState } from "react";
import { Bell, X } from "lucide-react";

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function NotificationBell({ notificationsHook }) {
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
      <button onClick={handleOpen} className="icon-button" aria-label="Notifications" style={{ position: "relative" }}>
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
              <h2 className="uk-display modal-title">Notifications</h2>
              <button onClick={() => setOpen(false)} aria-label="Close"><X size={20} /></button>
            </div>

            {notifications.length === 0 ? (
              <p className="muted">Nothing yet - you'll hear from us when someone messages you or buys something.</p>
            ) : (
              <div className="inbox-list">
                {notifications.map((n) => (
                  <div key={n.id} className="inbox-item">
                    <p className="inbox-item-title">{n.title}</p>
                    {n.body && <p className="uk-clamp2 small">{n.body}</p>}
                    <p className="small">{timeAgo(n.created_at)}</p>
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
