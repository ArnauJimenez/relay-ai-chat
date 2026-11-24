export interface User {
  id: string;
  email: string;
  username: string;
  avatarUrl: string | null;
  createdAt?: string;
}

export type RoomType = "DIRECT" | "GROUP" | "AI_ASSISTANT";
export type MessageStatus = "STREAMING" | "COMPLETED" | "FAILED";

export interface RoomMember {
  user: Pick<User, "id" | "username" | "avatarUrl">;
}

export interface Room {
  id: string;
  name: string | null;
  type: RoomType;
  createdAt: string;
  updatedAt: string;
  members: RoomMember[];
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string | null;
  isAi: boolean;
  content: string;
  status: MessageStatus;
  createdAt: string;
  updatedAt?: string;
  sender: Pick<User, "username" | "avatarUrl"> | null;
  error?: string;
  errorStatus?: number;
  errorCode?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export type UserSummary = Pick<User, "id" | "email" | "username" | "avatarUrl">;
