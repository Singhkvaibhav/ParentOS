import { apiFetch } from "./api";

export const metaService = {
  // Public marketplace config - categories, conditions, delivery fee and
  // field limits - served from the same source of truth the API validates
  // against (backend/config.js), so the UI can't drift out of sync with it.
  config: () => apiFetch("/meta/config"),
};
