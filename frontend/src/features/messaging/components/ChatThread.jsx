import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Send, Bot } from "lucide-react";

export default function ChatThread({ conversation, listing, role, onSend, aiTyping }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const endRef = useRef(null);
  const messages = conversation?.messages || [];

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, aiTyping]);

  return (
    <div>
      <div className="chat-messages">
        {messages.length === 0 && <p className="small">{t("chat.noMessages")}</p>}
        {messages.map((m, i) => {
          const isMine = m.senderType === role;
          const isAi = m.senderType === "ai";
          return (
            <div key={i} className={`chat-row ${isMine ? "chat-row-mine" : "chat-row-theirs"}`}>
              <div className={`chat-bubble ${isMine ? "chat-bubble-mine" : isAi ? "chat-bubble-ai" : "chat-bubble-theirs"}`}>
                {isAi && <span className="chat-ai-label"><Bot size={12} /> {t("chat.autoReply")}</span>}
                {m.text}
              </div>
            </div>
          );
        })}
        {aiTyping && <p className="small chat-ai-label"><Bot size={12} /> {t("chat.assistantTyping")}</p>}
        <div ref={endRef} />
      </div>
      <div className="chat-input-row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={role === "seller" ? t("chat.replyPlaceholder") : t("chat.askPlaceholder", { name: listing.seller_name || listing.sellerName })}
          className="input chat-input"
        />
        <button
          onClick={() => { if (text.trim()) { onSend(text.trim()); setText(""); } }}
          aria-label={t("chat.sendAria")}
          className="send-button"
        >
          <Send size={14} />
        </button>
      </div>
      {role === "buyer" && (
        <p className="small mt-2">{t("chat.assistantHint")}</p>
      )}
    </div>
  );
}
