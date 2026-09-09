import { useState, useEffect, useCallback, useRef } from "react";
import { messagingService } from "../../../services/messaging";
import { pollUntil } from "../../../utils";

// Listing-scoped thread, used from the listing detail page to start or
// continue "my conversation about this listing" as a buyer.
// `enabled` replaces the old `token` param - see useMyListings.js.
export function useBuyerThread(listingId, enabled) {
  const [conversation, setConversation] = useState(null);
  const [aiTyping, setAiTyping] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async () => {
    if (!listingId || !enabled) return;
    const { conversation } = await messagingService.getThread(listingId);
    if (mountedRef.current) setConversation(conversation);
  }, [listingId, enabled]);

  useEffect(() => { load(); }, [load]);

  const send = useCallback(async (text) => {
    const { conversation: afterSend } = await messagingService.sendBuyerMessage(listingId, text);
    if (mountedRef.current) setConversation(afterSend);

    // The AI reply (if any) is generated out-of-band now, so it won't be in
    // afterSend yet - poll briefly to pick it up once it lands.
    if (!afterSend.sellerReplied) {
      if (mountedRef.current) setAiTyping(true);
      const startingCount = afterSend.messages.length;
      const updated = await pollUntil(
        () => messagingService.getThread(listingId).then((r) => r.conversation),
        (convo) => !!convo && convo.messages.length > startingCount
      );
      if (mountedRef.current) {
        if (updated) setConversation(updated);
        setAiTyping(false);
      }
    }
  }, [listingId]);

  return { conversation, send, aiTyping };
}

// Unified inbox - every conversation the user is in, as buyer or seller,
// each tagged with role + unreadCount. No more separate buyer/seller inbox.
export function useConversations(enabled) {
  const [conversations, setConversations] = useState([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!enabled) { if (mountedRef.current) setLoading(false); return; }
    if (mountedRef.current) setLoading(true);
    const { conversations, totalUnread } = await messagingService.getConversations();
    if (mountedRef.current) {
      setConversations(conversations);
      setTotalUnread(totalUnread);
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const reply = useCallback(async (conversationId, text) => {
    const { conversation: afterReply } = await messagingService.reply(conversationId, text);
    await refresh();

    if (afterReply.role === "buyer" && !afterReply.sellerReplied) {
      // Poll the conversation's own message endpoint rather than the
      // inbox: the inbox intentionally no longer carries full message
      // arrays, so counting them there is no longer possible.
      const startingCount = afterReply.messages?.length ?? 0;
      await pollUntil(
        () => messagingService.getMessages(conversationId),
        (page) => !!page && page.messages.length > startingCount
      );
      if (mountedRef.current) await refresh();
    }
  }, [refresh]);

  const markRead = useCallback(async (conversationId) => {
    await messagingService.markRead(conversationId);
    await refresh();
  }, [refresh]);

  return { conversations, totalUnread, loading, refresh, reply, markRead };
}
