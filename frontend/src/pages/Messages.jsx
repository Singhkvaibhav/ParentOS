import { useState } from "react";
import { useAuth } from "../features/auth/hooks/useAuth";
import { useConversations } from "../features/messaging/hooks/useMessages";
import ChatThread from "../features/messaging/components/ChatThread";

export default function Messages() {
  const { user } = useAuth();
  const { conversations, loading, reply, markRead } = useConversations(!!user);
  const [openId, setOpenId] = useState(null);
  const open = conversations.find((c) => c.id === openId);

  if (!user) return <p className="muted p-6">Log in to see your messages.</p>;

  function handleOpen(c) {
    setOpenId(c.id);
    if (c.unreadCount > 0) markRead(c.id);
  }

  return (
    <section className="page-section">
      <h1 className="uk-display page-title">Messages</h1>
      {loading ? (
        <p className="muted">Loading...</p>
      ) : !open ? (
        conversations.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <div className="inbox-list">
            {conversations.map((c) => (
              <button key={c.id} onClick={() => handleOpen(c)} className="inbox-item">
                <p className="inbox-item-title">
                  {c.listingTitle} &middot; {c.otherPartyName}
                  <span className={`role-badge role-${c.role}`}>{c.role === "buyer" ? "Buying" : "Selling"}</span>
                  {c.unreadCount > 0 && <span className="unread-dot">{c.unreadCount}</span>}
                </p>
                <p className="uk-clamp2 small">{c.lastMessage}</p>
              </button>
            ))}
          </div>
        )
      ) : (
        <div>
          <button onClick={() => setOpenId(null)} className="link-button mb-3">&larr; Back to messages</button>
          <ChatThread
            conversation={open}
            listing={{ seller_name: open.sellerName, sellerName: open.sellerName }}
            role={open.role}
            aiTyping={false}
            onSend={(text) => reply(open.id, text)}
          />
        </div>
      )}
    </section>
  );
}
