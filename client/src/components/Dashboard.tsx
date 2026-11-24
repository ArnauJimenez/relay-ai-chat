import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  CircleHelp,
  Command,
  Hash,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../context/SocketContext";
import { roomApi } from "../services/api";
import { getInitials } from "../lib/utils";
import type { Room, RoomType } from "../types";
import { ChatRoom } from "./ChatRoom";
import { CreateRoomModal } from "./CreateRoomModal";

type RoomFilter = "all" | RoomType;

const filters: { id: RoomFilter; label: string }[] = [
  { id: "all", label: "All rooms" },
  { id: "AI_ASSISTANT", label: "AI assistants" },
  { id: "GROUP", label: "Groups" },
  { id: "DIRECT", label: "Direct messages" },
];

function roomName(room: Room, userId: string) {
  if (room.name) return room.name;
  if (room.type === "AI_ASSISTANT") return "Gemini assistant";
  if (room.type === "DIRECT") {
    return room.members.find((member) => member.user.id !== userId)?.user.username ?? "Direct conversation";
  }
  return "Untitled room";
}

function RoomIcon({ type }: { type: RoomType }) {
  if (type === "AI_ASSISTANT") return <Bot size={16} />;
  if (type === "DIRECT") return <MessageCircle size={15} />;
  return <Hash size={16} />;
}

export function Dashboard() {
  const { user, logout } = useAuth();
  const { connected, onPresence } = useSocket();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RoomFilter>("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());

  const refreshRooms = useCallback(async () => {
    try {
      setLoadError("");
      const result = await roomApi.list();
      setRooms(result);
      setActiveRoomId((current) => current && result.some((room) => room.id === current) ? current : result[0]?.id ?? null);
    } catch {
      setLoadError("Your rooms couldn't be loaded. Check the API connection and refresh.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  useEffect(() => onPresence((event) => {
    setOnlineUsers((current) => {
      const next = new Set(current);
      if (event.status === "online") next.add(event.userId);
      else next.delete(event.userId);
      return next;
    });
  }), [onPresence]);

  const visibleRooms = useMemo(() => rooms.filter((room) => {
    const matchesFilter = filter === "all" || room.type === filter;
    const matchesSearch = roomName(room, user?.id ?? "").toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  }), [rooms, filter, search, user?.id]);

  const activeRoom = rooms.find((room) => room.id === activeRoomId) ?? null;
  const aiCount = rooms.filter((room) => room.type === "AI_ASSISTANT").length;
  const groupCount = rooms.filter((room) => room.type === "GROUP").length;

  function chooseRoom(room: Room) {
    setActiveRoomId(room.id);
    setSidebarOpen(false);
  }

  function createdRoom(room: Room) {
    // The API returns an existing DM with 200, so drop any copy already in the list.
    setRooms((current) => [room, ...current.filter((item) => item.id !== room.id)]);
    setActiveRoomId(room.id);
    setShowCreate(false);
  }

  return (
    <main className="app-shell">
      {sidebarOpen && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <a className="brand-lockup" href="#home"><span className="brand-mark"><Bot size={18} /></span><span>relay<span className="brand-dot">.</span></span><span className="brand-beta">BETA</span></a>
          <button type="button" className="workspace-switch"><span className="workspace-icon">A</span><span className="workspace-name">Acme Studio<small>Free workspace</small></span><ChevronDown size={15} /></button>
        </div>

        <div className="sidebar-section-heading"><span>WORKSPACE</span><button aria-label="Workspace options"><MoreHorizontal size={17} /></button></div>
        <nav className="main-nav">
          <button className="nav-item active"><Command size={16} /><span>Messages</span><span className="nav-shortcut">⌘ 1</span></button>
          <button className="nav-item" onClick={() => setFilter("GROUP")}><Users size={16} /><span>People</span><span className="nav-count">{new Set(rooms.flatMap((room) => room.members.map(({ user: member }) => member.id))).size}</span></button>
        </nav>

        <div className="room-section-heading"><span>YOUR CONVERSATIONS</span><button type="button" aria-label="Create a room" onClick={() => setShowCreate(true)}><Plus size={16} /></button></div>
        <div className="sidebar-search"><Search size={14} /><input placeholder="Find a room..." value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></div>
        <div className="room-filters">
          {filters.map((item) => <button key={item.id} className={filter === item.id ? "selected" : ""} onClick={() => setFilter(item.id)}>{item.label}{item.id === "AI_ASSISTANT" && aiCount > 0 && <span>{aiCount}</span>}</button>)}
        </div>
        <div className="room-list">
          {loading && <div className="sidebar-loading"><span className="loader-ring" />Loading rooms</div>}
          {!loading && loadError && <div className="sidebar-error">{loadError}<button onClick={() => void refreshRooms()}>Retry</button></div>}
          {!loading && !loadError && visibleRooms.length === 0 && <div className="empty-room-list">{search ? "No rooms match your search." : "Nothing here yet."}<button onClick={() => setShowCreate(true)}>Create a room <Plus size={13} /></button></div>}
          {visibleRooms.map((room) => {
            const name = roomName(room, user?.id ?? "");
            const otherMembers = room.members.filter((member) => member.user.id !== user?.id);
            const someOnline = otherMembers.some(({ user: member }) => onlineUsers.has(member.id));
            return <button type="button" key={room.id} className={`room-list-item ${activeRoomId === room.id ? "active" : ""}`} onClick={() => chooseRoom(room)}>
              <span className={`room-list-icon ${room.type.toLowerCase()}`}><RoomIcon type={room.type} />{room.type === "DIRECT" && <i className={someOnline ? "online" : ""} />}</span>
              <span className="room-list-copy"><span>{name}</span><small>{room.type === "AI_ASSISTANT" ? "AI assistant" : room.type === "GROUP" ? `${room.members.length} members` : someOnline ? "Active now" : "Direct message"}</small></span>
              {room.type === "AI_ASSISTANT" && <span className="room-live-dot" />}
            </button>;
          })}
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-usage"><div><span>YOUR WORKSPACE</span><span>FREE PLAN</span></div><div className="usage-meter"><span style={{ width: `${Math.min(100, Math.max(12, rooms.length * 8))}%` }} /></div><small>{rooms.length} of 20 rooms used <button onClick={() => setShowCreate(true)}>Upgrade <span>↗</span></button></small></div>
          <button className="sidebar-help"><CircleHelp size={15} />Help & resources<span>↗</span></button>
          <div className="profile-card">
            <div className="profile-avatar">{getInitials(user?.username ?? "U")}<i className={connected ? "online" : ""} /></div>
            <div className="profile-copy"><strong>{user?.username ?? "Your account"}</strong><small>{user?.email}</small></div>
            <button type="button" title="Sign out" aria-label="Sign out" onClick={logout}><LogOut size={15} /></button>
          </div>
        </div>
      </aside>

      <div className="main-column">
        <div className="mobile-topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Command size={19} /></button><span>relay<span className="brand-dot">.</span></span><button className="mobile-new-room" onClick={() => setShowCreate(true)} aria-label="Create room"><Plus size={18} /></button></div>
        {activeRoom ? <ChatRoom key={activeRoom.id} room={activeRoom} onBack={() => setSidebarOpen(true)} /> : <div className="welcome-pane">
          <div className="welcome-pattern" />
          <div className="welcome-content"><span className="welcome-mark"><Sparkles size={24} /></span><span className="start-overline">YOUR SPACE, YOUR PACE</span><h1>Good ideas start<br />with a <em>hello.</em></h1><p>Choose a conversation from the sidebar, or start a new one. Your next big thought could be one message away.</p><button className="primary-button" onClick={() => setShowCreate(true)}>Start a conversation <Plus size={16} /></button><div className="welcome-stats"><span><strong>{rooms.length}</strong> conversations</span><i /><span><strong>{groupCount}</strong> group rooms</span><i /><span><strong>{aiCount}</strong> AI assistants</span></div></div>
          <div className="welcome-bottom"><span>MADE FOR MOMENTUM</span><span><span className={`status-dot ${connected ? "" : "muted-dot"}`} /> {connected ? "REALTIME CONNECTED" : "CONNECTING TO REALTIME"}</span></div>
        </div>}
      </div>
      <div className="ambient-grain" />
      {showCreate && <CreateRoomModal onClose={() => setShowCreate(false)} onCreated={createdRoom} />}
    </main>
  );
}
