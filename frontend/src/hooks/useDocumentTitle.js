import { useEffect } from "react";

const BASE_TITLE = "Uusiksi";

// Sets the browser tab title for the lifetime of whatever page called
// this, restoring the base title on unmount. This is a client-side,
// real-browser-only improvement (correct tab titles, correct names when
// bookmarking/sharing a link via copy-paste) - it does NOT help a crawler
// or link-preview bot that doesn't run JavaScript, which is what
// backend/seo/routes.js exists to serve instead for /listing/:id
// specifically.
export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = `${title} · ${BASE_TITLE}`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
