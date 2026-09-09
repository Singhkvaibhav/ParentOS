import { apiFetch } from "./api";

export const connectService = {
  onboard: () => apiFetch("/connect/onboard", { method: "POST" }),
  status: () => apiFetch("/connect/status"),
};
