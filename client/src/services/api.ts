import axios from "axios";
import type { AuthResponse, Message, Room, RoomType, UserSummary } from "../types";
import { normalizeApiBaseUrl } from "./api-url";

export const apiBaseUrl = normalizeApiBaseUrl(
  import.meta.env.VITE_API_URL || "http://127.0.0.1:3001/api",
);
// Socket.io shares the API's origin unless VITE_SOCKET_URL points somewhere else.
export const socketUrl = import.meta.env.VITE_SOCKET_URL || new URL(apiBaseUrl).origin;

const api = axios.create({
  baseURL: apiBaseUrl,
  headers: { "Content-Type": "application/json" },
});

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) {
    return fallback;
  }

  if (!error.response) {
    return `Cannot reach the API at ${apiBaseUrl}. Start the proyecto3 backend and try again.`;
  }

  const responseData: unknown = error.response.data;
  if (
    typeof responseData === "object" &&
    responseData !== null &&
    "error" in responseData &&
    typeof responseData.error === "string"
  ) {
    if (error.response.status >= 500) {
      const requestId =
        "requestId" in responseData && typeof responseData.requestId === "string"
          ? ` (request ID: ${responseData.requestId})`
          : "";
      return `The server returned an error: ${responseData.error}${requestId}`;
    }

    return responseData.error;
  }

  if (error.response.status === 404) {
    return `The API at ${apiBaseUrl} does not have this route. Check that the proyecto3 backend is running.`;
  }

  return `The API request failed with status ${error.response.status}.`;
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("realtime-ai-chat-token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const authApi = {
  register: async (input: {
    email: string;
    username: string;
    password: string;
  }) => (await api.post<AuthResponse>("/auth/register", input)).data,
  login: async (input: { email: string; password: string }) =>
    (await api.post<AuthResponse>("/auth/login", input)).data,
  demo: async () => (await api.post<AuthResponse>("/auth/demo")).data,
};

export const roomApi = {
  list: async () => (await api.get<Room[]>("/rooms")).data,
  create: async (input: {
    name?: string;
    type: RoomType;
    memberIds?: string[];
  }) => (await api.post<Room>("/rooms", input)).data,
  messages: async (roomId: string, page = 1, limit = 50) =>
    (
      await api.get<{ messages: Message[]; page: number; limit: number }>(
        `/rooms/${roomId}/messages`,
        { params: { page, limit } },
      )
    ).data,
};

export const userApi = {
  search: async (query: string, signal?: AbortSignal) =>
    (await api.get<UserSummary[]>("/users/search", { params: { q: query }, signal })).data,
};
