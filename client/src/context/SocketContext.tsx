import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { io, type Socket } from "socket.io-client";
import { socketUrl } from "../services/api";
import { useAuth } from "./AuthContext";
import type { Message, MessageStatus } from "../types";

interface AiStreamStart {
  messageId: string;
  roomId: string;
  createdAt: string;
}

interface AiStreamChunk {
  messageId: string;
  roomId: string;
  chunk: string;
}

interface AiStreamEnd {
  messageId: string;
  roomId: string;
  content: string;
  status: MessageStatus;
  error?: string;
  errorStatus?: number;
  errorCode?: string;
}

interface TypingUpdate {
  roomId: string;
  userId: string;
  isTyping: boolean;
}

interface PresenceUpdate {
  userId: string;
  status: "online" | "offline";
}

interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
  joinRoom: (roomId: string) => void;
  leaveRoom: (roomId: string) => void;
  sendMessage: (roomId: string, content: string, triggerAi: boolean) => void;
  startTyping: (roomId: string) => void;
  stopTyping: (roomId: string) => void;
  onMessage: (handler: (message: Message) => void) => () => void;
  onStreamStart: (handler: (event: AiStreamStart) => void) => () => void;
  onStreamChunk: (handler: (event: AiStreamChunk) => void) => () => void;
  onStreamEnd: (handler: (event: AiStreamEnd) => void) => () => void;
  onTyping: (handler: (event: TypingUpdate) => void) => () => void;
  onPresence: (handler: (event: PresenceUpdate) => void) => () => void;
  onError: (handler: (event: { message: string }) => void) => () => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token) {
      setSocket(null);
      setConnected(false);
      return;
    }

    const connection = io(socketUrl, {
      auth: { token },
      autoConnect: true,
      reconnection: true,
    });
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    connection.on("connect", onConnect);
    connection.on("disconnect", onDisconnect);
    setSocket(connection);

    return () => {
      connection.off("connect", onConnect);
      connection.off("disconnect", onDisconnect);
      connection.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [token]);

  const joinRoom = useCallback((roomId: string) => socket?.emit("room:join", roomId), [socket]);
  const leaveRoom = useCallback((roomId: string) => socket?.emit("room:leave", roomId), [socket]);
  const sendMessage = useCallback(
    (roomId: string, content: string, triggerAi: boolean) =>
      socket?.emit("message:send", { roomId, content, triggerAi }),
    [socket],
  );
  const startTyping = useCallback(
    (roomId: string) => socket?.emit("typing:start", { roomId }),
    [socket],
  );
  const stopTyping = useCallback(
    (roomId: string) => socket?.emit("typing:stop", { roomId }),
    [socket],
  );

  const subscribe = useCallback(
    <T,>(event: string, handler: (payload: T) => void) => {
      if (!socket) return () => undefined;
      socket.on(event, handler);
      return () => socket.off(event, handler);
    },
    [socket],
  );

  const value = useMemo<SocketContextValue>(
    () => ({
      socket,
      connected,
      joinRoom,
      leaveRoom,
      sendMessage,
      startTyping,
      stopTyping,
      onMessage: (handler) => subscribe("message:new", handler),
      onStreamStart: (handler) => subscribe("ai:stream_start", handler),
      onStreamChunk: (handler) => subscribe("ai:stream_chunk", handler),
      onStreamEnd: (handler) => subscribe("ai:stream_end", handler),
      onTyping: (handler) => subscribe("typing:update", handler),
      onPresence: (handler) => subscribe("presence:update", handler),
      onError: (handler) => subscribe("error:event", handler),
    }),
    [socket, connected, joinRoom, leaveRoom, sendMessage, startTyping, stopTyping, subscribe],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  const value = useContext(SocketContext);
  if (!value) {
    throw new Error("useSocket must be used within SocketProvider");
  }
  return value;
}
