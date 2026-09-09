import { useState, useCallback, useRef, useEffect } from "react";

// Shared toast state with a properly-cleared timer: a new toast cancels any
// timer still pending from a previous one (so an earlier toast can't clear
// a later, still-visible one), and the timer is cleared on unmount so it
// never fires setState on an unmounted component.
export function useToast() {
  const [toast, setToast] = useState(null);
  const timeoutRef = useRef(null);

  const showToast = useCallback((msg) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setToast(msg);
    timeoutRef.current = setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  return { toast, showToast };
}
