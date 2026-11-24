import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, CircleAlert, Copy, Paperclip, Sparkles, WandSparkles } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../context/SocketContext";
import { roomApi } from "../services/api";
import { formatTime, getInitials } from "../lib/utils";
import type { Message, Room, RoomType } from "../types";

const MarkdownContent = lazy(async () => import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })));

interface ChatRoomProps {
  room: Room;
  onBack: () => void;
}

function roomTitle(room: Room, userId: string) {
  if (room.name) return room.name;
  if (room.type === "AI_ASSISTANT") return "Gemini assistant";
  if (room.type === "DIRECT") {
    const otherMember = room.members.find((member) => member.user.id !== userId);
    return otherMember?.user.username ?? "Direct conversation";
  }
  return "Untitled room";
}

function roomTypeLabel(type: RoomType) {
  return type === "AI_ASSISTANT" ? "AI WORKSPACE" : type === "DIRECT" ? "DIRECT MESSAGE" : "GROUP ROOM";
}

export function ChatRoom({ room, onBack }: ChatRoomProps) {
  const { user } = useAuth();
  const { connected, joinRoom, leaveRoom, sendMessage, startTyping, stopTyping, onMessage, onStreamStart, onStreamChunk, onStreamEnd, onTyping, onPresence, onError } = useSocket();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [triggerAi, setTriggerAi] = useState(room.type === "AI_ASSISTANT");
  const [showScroll, setShowScroll] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStarted = useRef(false);
  const title = roomTitle(room, user?.id ?? "");
  const otherMembers = room.members.filter((member) => member.user.id !== user?.id);

  const addMessage = useCallback((message: Message) => {
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index >= 0) {
        const next = [...current];
        next[index] = { ...next[index], ...message };
        return next;
      }
      return [...current, message].sort(
        (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
      );
    });
  }, []);

  useEffect(() => {
    const cleanups = [
      onMessage((message) => { if (message.roomId === room.id) addMessage(message); }),
      onStreamStart((event) => {
        if (event.roomId !== room.id) return;
        setThinking(true);
        addMessage({
          id: event.messageId,
          roomId: event.roomId,
          senderId: null,
          isAi: true,
          content: "",
          status: "STREAMING",
          createdAt: event.createdAt,
          sender: null,
        });
      }),
      onStreamChunk((event) => {
        if (event.roomId !== room.id) return;
        setThinking(false);
        setMessages((current) => current.map((message) =>
          message.id === event.messageId
            ? { ...message, content: message.content + event.chunk, status: "STREAMING" }
            : message,
        ));
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }),
      onStreamEnd((event) => {
        if (event.roomId !== room.id) return;
        setThinking(false);
        setMessages((current) => current.map((message) =>
          message.id === event.messageId
            ? {
                ...message,
                content: event.content,
                status: event.status,
                ...(event.error === undefined ? {} : { error: event.error }),
                ...(event.errorStatus === undefined
                  ? {}
                  : { errorStatus: event.errorStatus }),
                ...(event.errorCode === undefined
                  ? {}
                  : { errorCode: event.errorCode }),
              }
            : message,
        ));
      }),
      onTyping((event) => {
        if (event.roomId !== room.id || event.userId === user?.id) return;
        setTypingUsers((current) => event.isTyping
          ? [...new Set([...current, event.userId])]
          : current.filter((id) => id !== event.userId));
      }),
      onPresence((event) => {
        setOnlineUsers((current) => {
          const next = new Set(current);
          if (event.status === "online") next.add(event.userId);
          else next.delete(event.userId);
          return next;
        });
      }),
      onError((event) => setError(event.message)),
    ];

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [room.id, user?.id, addMessage, onMessage, onStreamStart, onStreamChunk, onStreamEnd, onTyping, onPresence, onError]);

  useEffect(() => {
    let active = true;
    joinRoom(room.id);
    roomApi.messages(room.id)
      .then(({ messages: history }) => {
        if (active) {
          setMessages((current) => {
            const byId = new Map(current.map((message) => [message.id, message]));
            for (const message of history) {
              byId.set(message.id, { ...byId.get(message.id), ...message });
            }
            return [...byId.values()].sort(
              (left, right) =>
                new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
            );
          });
        }
      })
      .catch(() => {
        if (active) setError("Message history could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (typingStarted.current) {
        stopTyping(room.id);
        typingStarted.current = false;
      }
      leaveRoom(room.id);
    };
  }, [room.id, joinRoom, leaveRoom, stopTyping]);

  useEffect(() => {
    if (!showScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, typingUsers, showScroll]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    setShowScroll(element.scrollHeight - element.scrollTop - element.clientHeight > 160);
  }

  function handleDraft(value: string) {
    setDraft(value);
    if (room.type === "AI_ASSISTANT") return;
    if (value.trim()) {
      if (!typingStarted.current) {
        startTyping(room.id);
        typingStarted.current = true;
      }
    } else if (typingStarted.current) {
      stopTyping(room.id);
      typingStarted.current = false;
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (value.trim()) {
      typingTimer.current = setTimeout(() => {
        if (typingStarted.current) {
          stopTyping(room.id);
          typingStarted.current = false;
        }
      }, 1800);
    }
  }

  function submitMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (typingStarted.current) {
      stopTyping(room.id);
      typingStarted.current = false;
    }
    sendMessage(room.id, content, triggerAi);
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setShowScroll(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  }

  async function copyMessage(message: Message) {
    await navigator.clipboard.writeText(message.content);
    setCopied(message.id);
    setTimeout(() => setCopied(null), 1500);
  }

  const typingNames = useMemo(() => typingUsers.map((id) =>
    room.members.find((member) => member.user.id === id)?.user.username ?? "Someone",
  ), [typingUsers, room.members]);

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <button type="button" className="back-button" onClick={onBack}>‹</button>
        <div className="chat-room-avatar">{room.type === "AI_ASSISTANT" ? <Bot size={18} /> : <span>{getInitials(title)}</span>}</div>
        <div className="chat-heading">
          <div className="chat-title-line"><h1>{title}</h1>{room.type === "AI_ASSISTANT" && <span className="ai-chip"><Sparkles size={11} /> GEMINI</span>}</div>
          <div className="chat-subline"><span className={`room-type-dot ${room.type.toLowerCase()}`} />{roomTypeLabel(room.type)}<span className="subline-sep">/</span>{room.type === "AI_ASSISTANT" ? "Ready when you are" : `${otherMembers.length + 1} ${otherMembers.length === 0 ? "member" : "members"}`}</div>
        </div>
        <div className="header-right">
          {room.type !== "AI_ASSISTANT" && <div className="header-members">
            {otherMembers.slice(0, 3).map(({ user: member }) => <span key={member.id} className="tiny-avatar" title={member.username}>{getInitials(member.username)}<i className={onlineUsers.has(member.id) ? "online" : ""} /></span>)}
            {otherMembers.length > 3 && <span className="more-members">+{otherMembers.length - 3}</span>}
          </div>}
          <div className={`connection-indicator ${connected ? "connected" : ""}`}><span /> {connected ? "CONNECTED" : "OFFLINE"}</div>
          <button type="button" className="header-more" aria-label="Room options"><ChevronDown size={16} /></button>
        </div>
      </header>

      <div className="messages-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="messages-inner">
          {loading && <div className="loading-history"><span className="loader-ring" />Loading conversation</div>}
          {error && <div className="inline-error"><CircleAlert size={15} />{error}<button onClick={() => setError("")}>Dismiss</button></div>}
          {!loading && messages.length === 0 && <div className="conversation-start">
            <div className="start-icon">{room.type === "AI_ASSISTANT" ? <WandSparkles size={23} /> : <MessageCircleIcon />}</div>
            <span className="start-overline">A FRESH PAGE</span>
            <h2>{room.type === "AI_ASSISTANT" ? "What are we thinking about?" : "Make the first move."}</h2>
            <p>{room.type === "AI_ASSISTANT" ? "Ask a question, explore a thought, or start with a rough idea. We can shape it together." : `This is the beginning of ${title}. Send a note to get things going.`}</p>
            {room.type === "AI_ASSISTANT" && <div className="suggestion-row">
              {["Help me think through an idea", "Summarize a concept", "Write something together"].map((suggestion) => <button key={suggestion} onClick={() => { handleDraft(suggestion); textareaRef.current?.focus(); }}>{suggestion}<ArrowUp size={13} /></button>)}
            </div>}
          </div>}

          {!loading && messages.map((message, index) => {
            const ownMessage = message.senderId === user?.id;
            const previous = messages[index - 1];
            const grouped = previous && previous.senderId === message.senderId && previous.isAi === message.isAi && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;
            return <article className={`message-row ${ownMessage ? "own-message" : ""} ${message.isAi ? "assistant-message" : ""} ${grouped ? "grouped-message" : ""}`} key={message.id}>
              {!grouped && <div className={`message-avatar ${message.isAi ? "ai-message-avatar" : ownMessage ? "user-message-avatar" : ""}`}>{message.isAi ? <Bot size={15} /> : getInitials(message.sender?.username ?? user?.username ?? "U")}</div>}
              <div className="message-content-wrap">
                {!grouped && <div className="message-meta"><span className="message-author">{message.isAi ? "Gemini" : ownMessage ? "You" : message.sender?.username ?? "Member"}</span>{message.isAi && <span className="ai-label">AI</span>}<time>{formatTime(message.createdAt)}</time>{message.status === "FAILED" && <span className="failed-label">FAILED</span>}</div>}
                <div className={`message-bubble ${message.isAi ? "markdown-bubble" : ownMessage ? "human-bubble" : ""}`}>
                  {message.isAi ? <div className="markdown-content">{message.status === "FAILED" && message.error ? <p className="ai-stream-error">{message.error}{message.errorStatus ? ` (HTTP ${message.errorStatus}${message.errorCode ? ` · ${message.errorCode}` : ""})` : ""}</p> : <Suspense fallback={<>{message.content}<span className="stream-caret" /></>}><MarkdownContent content={message.content || (message.status === "STREAMING" ? "" : "_No response was generated._")} /></Suspense>}{message.status === "STREAMING" && <span className="stream-caret" />}</div> : <p>{message.content}</p>}
                  {!message.isAi && <span className="message-check"><Check size={12} /><Check size={12} /></span>}
                </div>
                {message.content && <button className="message-copy" onClick={() => void copyMessage(message)} aria-label="Copy message">{copied === message.id ? <Check size={13} /> : <Copy size={13} />}</button>}
              </div>
            </article>;
          })}
          {thinking && <div className="message-row assistant-message thinking-row"><div className="message-avatar ai-message-avatar"><Bot size={15} /></div><div className="message-content-wrap"><div className="message-meta"><span className="message-author">Gemini</span><span className="ai-label">AI</span></div><div className="thinking-bubble"><span /><span /><span /></div></div></div>}
          {typingNames.length > 0 && <div className="typing-banner"><span className="typing-dots"><i /><i /><i /></span><span><b>{typingNames.join(", ")}</b> {typingNames.length === 1 ? "is" : "are"} typing</span></div>}
          <div ref={bottomRef} />
        </div>
        {showScroll && <button className="scroll-bottom" onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth" })}><ArrowDown size={16} /> Latest messages</button>}
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={submitMessage}>
          <textarea ref={textareaRef} rows={1} placeholder={room.type === "AI_ASSISTANT" ? "Ask Gemini anything..." : `Message ${title}`} value={draft} onChange={(event) => {
            handleDraft(event.target.value);
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`;
          }} onKeyDown={handleInputKeyDown} aria-label="Write a message" />
          <div className="composer-bottom">
            <div className="composer-tools">
              <button type="button" className="tool-button" aria-label="Attach file" title="Attachments coming soon"><Paperclip size={16} /></button>
              {room.type !== "AI_ASSISTANT" && <button type="button" className={`ai-toggle ${triggerAi ? "active" : ""}`} onClick={() => setTriggerAi(!triggerAi)}><Sparkles size={13} />{triggerAi ? "AI on" : "Ask AI"}<span className="toggle-knob" /></button>}
              {room.type === "AI_ASSISTANT" && <span className="composer-model"><span className="model-spark">✳</span> Gemini 2.5 Flash <ChevronDown size={13} /></span>}
            </div>
            <div className="composer-hints"><span><kbd>↵</kbd> send</span><span><kbd>⇧ ↵</kbd> new line</span><button type="submit" className="send-button" disabled={!draft.trim()} aria-label="Send message"><ArrowUp size={17} /></button></div>
          </div>
        </form>
        <div className="composer-footnote">{room.type === "AI_ASSISTANT" ? "Gemini can make mistakes. Check important information." : "Your messages are visible to everyone in this room."}</div>
      </div>
    </section>
  );
}

function MessageCircleIcon() {
  return <span className="message-start-glyph">↗</span>;
}
