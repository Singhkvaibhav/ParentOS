import { useState, useEffect, useCallback } from "react";
import { transactionsService } from "../../../services/transactions";

// A user's orders (as buyer and as seller), plus the lifecycle actions
// either party can take.
//
// Extracted from Profile.jsx, which had grown to hold three unrelated
// domains at once - orders, payouts, and listing management. Each was a
// self-contained slice of state with its own loading and its own actions;
// the only thing they shared was being rendered on the same page, which
// isn't a reason to live in the same file.
export function useOrders(enabled) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setOrders([]);
      setLoading(false);
      return;
    }
    try {
      const { transactions } = await transactionsService.mine();
      setOrders(transactions);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  // Every action refetches rather than patching local state. The server
  // decides what a transition produces - the new status, its timestamp,
  // whether it was even allowed - so predicting it here would let the UI
  // drift from the actual record, which for orders means showing someone
  // the wrong thing about their money.
  const act = useCallback(async (fn) => {
    await fn();
    await refresh();
  }, [refresh]);

  return {
    orders,
    loading,
    error,
    refresh,
    confirmReceipt: (id) => act(() => transactionsService.confirmReceipt(id)),
    markFulfilled: (id) => act(() => transactionsService.markFulfilled(id)),
    raiseDispute: (id, reason) => act(() => transactionsService.raiseDispute(id, reason)),
  };
}
