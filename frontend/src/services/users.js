import { apiFetch } from "./api";

export const usersService = {
  publicProfile: (id) => apiFetch(`/users/${id}`),
};
