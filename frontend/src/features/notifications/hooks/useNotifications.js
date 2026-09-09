import { useState, useEffect, useCallback, useRef } from "react";
import { notificationsService } from "../../../services/notifications";

const POLL_INTERVAL_MS = 60000;

// Polls for notifications rather than using WebSockets/SSE - the same
// reasoning as the message polling: much simpler, and appropriate at
// current volume. A minute is deliberately unhurried; this is an ambient
// "you have things waiting" signal, not a live feed.
export function useNotifications(enabled) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await notificationsService.list();
      if (mountedRef.current) {
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      }
    } catch {
      // A failed poll shouldn't surface an error - the next one will
      // likely succeed, and this is ambient information.
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
    if (!enabled) return;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, enabled]);

  const markAllRead = useCallback(async () => {
    await notificationsService.markAllRead();
    await refresh();
  }, [refresh]);

  return { notifications, unreadCount, refresh, markAllRead };
}
