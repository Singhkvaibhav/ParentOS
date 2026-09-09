import { apiFetch } from "./api";

export const uploadsService = {
  uploadImage: (imageDataUrl) => apiFetch("/uploads", { method: "POST", body: { imageDataUrl } }),
};
