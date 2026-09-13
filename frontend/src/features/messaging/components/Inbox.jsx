import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { messagingService } from "../../../services/messaging";
import { X } from "lucide-react";
import ChatThread from "./ChatThread";

// Unified inbox: shows every conversation the user is in, whether they're
// the buyer or the seller in it, with a role badge and unread count.
export default function Inbox({ onClose, conversationsHook }) {
  const { t } = useTranslation();
  const { conversations, loading, reply, markRead } = conversationsHook;
  const [openId, setOpenId] = useState(null);
  const open = conversations.find((c) => c.id === openId);
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState(null);

  // The inbox list no longer carries full message arrays (they'd be
  // re-sent for every thread on every poll), so a thread's history is
  // fetched when it's actually opened.
  const loadMessages = useCallback(async () => {
    if (!openId) return;
    const page = await messagingService.getMessages(openId);
    setMessages(page.messages);
    setHasMore(page.hasMore);
    setCursor(page.nextCursor);
  }, [openId]);

  useEffect(() => {
    if (!openId) { setMessages([]); setHasMore(false); setCursor(null); return; }
    loadMessages().catch(() => {});
  }, [openId, loadMessages]);

  async function loadOlder() {
    if (!cursor) return;
    const page = await messagingService.getMessages(openId, { cursor });
    setMessages((prev) => [...page.messages, ...prev]);
    setHasMore(page.hasMore);
    setCursor(page.nextCursor);
  }

  function handleOpen(c) {
    setOpenId(c.id);
    if (c.unreadCount > 0) markRead(c.id);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="uk-display modal-title">{t("inbox.title")}</h2>
          <button onClick={onClose} aria-label={t("listingDetails.closeAria")}><X size={20} /></button>
        </div>

        {!openId ? (
          loading ? (
            <p className="muted">{t("common.loading")}</p>
          ) : conversations.length === 0 ? (
            <p className="muted">{t("inbox.empty")}</p>
          ) : (
            <div className="inbox-list">
              {conversations.map((c) => (
                <button key={c.id} onClick={() => handleOpen(c)} className="inbox-item">
                  <p className="inbox-item-title">
                    {c.listingTitle} &middot; {c.otherPartyName}
                    <span className={`role-badge role-${c.role}`}>{c.role === "buyer" ? t("inbox.buying") : t("inbox.selling")}</span>
                    {c.unreadCount > 0 && <span className="unread-dot">{c.unreadCount}</span>}
                  </p>
                  <p className="uk-clamp2 small">{c.lastMessage}</p>
                </button>
              ))}
            </div>
          )
        ) : (
          <div>
            <button onClick={() => setOpenId(null)} className="link-button mb-3">{t("inbox.backToMessages")}</button>
            {hasMore && (
              <button onClick={() => loadOlder().catch(() => {})} className="link-button mb-3">
                {t("inbox.loadEarlier")}
              </button>
            )}
            {open && (
              <ChatThread
                conversation={{ ...open, messages }}
                listing={{ seller_name: open.sellerName, sellerName: open.sellerName }}
                role={open.role}
                aiTyping={false}
                onSend={async (text) => { await reply(open.id, text); await loadMessages(); }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
