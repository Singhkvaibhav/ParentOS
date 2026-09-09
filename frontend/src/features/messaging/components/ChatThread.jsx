import { useState, useRef, useEffect } from "react";
import { Send, Bot } from "lucide-react";

export default function ChatThread({ conversation, listing, role, onSend, aiTyping }) {
  const [text, setText] = useState("");
  const endRef = useRef(null);
  const messages = conversation?.messages || [];

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, aiTyping]);

  return (
    <div>
      <div className="chat-messages">
        {messages.length === 0 && <p className="small">No messages yet - say hello.</p>}
        {messages.map((m, i) => {
          const isMine = m.senderType === role;
          const isAi = m.senderType === "ai";
          return (
            <div key={i} className={`chat-row ${isMine ? "chat-row-mine" : "chat-row-theirs"}`}>
              <div className={`chat-bubble ${isMine ? "chat-bubble-mine" : isAi ? "chat-bubble-ai" : "chat-bubble-theirs"}`}>
                {isAi && <span className="chat-ai-label"><Bot size={12} /> Auto-reply</span>}
                {m.text}
              </div>
            </div>
          );
        })}
        {aiTyping && <p className="small chat-ai-label"><Bot size={12} /> Assistant is typing...</p>}
        <div ref={endRef} />
      </div>
      <div className="chat-input-row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={role === "seller" ? "Reply to the buyer..." : `Ask ${listing.seller_name || listing.sellerName} something...`}
          className="input chat-input"
        />
        <button
          onClick={() => { if (text.trim()) { onSend(text.trim()); setText(""); } }}
          aria-label="Send"
          className="send-button"
        >
          <Send size={14} />
        </button>
      </div>
      {role === "buyer" && (
        <p className="small mt-2">An assistant answers using the listing details until the seller replies personally.</p>
      )}
    </div>
  );
}
