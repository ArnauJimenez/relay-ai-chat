import { useState, type FormEvent } from "react";
import { Bot, Hash, LoaderCircle, MessageCircle, Sparkles, X } from "lucide-react";
import { getApiErrorMessage, roomApi, userApi } from "../services/api";
import type { Room, RoomType, UserSummary } from "../types";
import { UserSearch } from "./UserSearch";

interface CreateRoomModalProps {
  onClose: () => void;
  onCreated: (room: Room) => void;
}

const demoBotUsername = "relay_guide";

const roomChoices: { type: RoomType; title: string; description: string }[] = [
  { type: "AI_ASSISTANT", title: "AI assistant", description: "Think out loud with Gemini" },
  { type: "GROUP", title: "Group room", description: "Bring people into a shared space" },
  { type: "DIRECT", title: "Direct message", description: "A private one-to-one conversation" },
];

export function CreateRoomModal({ onClose, onCreated }: CreateRoomModalProps) {
  const [type, setType] = useState<RoomType>("AI_ASSISTANT");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<UserSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  const maxSelections = type === "DIRECT" ? 1 : 100;
  const directNeedsPerson = type === "DIRECT" && selected.length !== 1;

  function chooseType(nextType: RoomType) {
    setType(nextType);
    setError("");
    // A direct message has exactly one other person, so keep only the latest pick.
    if (nextType === "DIRECT") {
      setSelected((current) => current.slice(-1));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const room = await roomApi.create({
        type,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(type !== "AI_ASSISTANT" ? { memberIds: selected.map((user) => user.id) } : {}),
      });
      onCreated(room);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Couldn't create this room. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  // One click opens (or reopens) the demo DM, so reviewers can try messaging without a second account.
  async function openDemoBot() {
    setDemoLoading(true);
    setError("");
    try {
      const bot = (await userApi.search(demoBotUsername)).find((user) => user.username === demoBotUsername);
      if (!bot) {
        throw new Error("demo bot not found");
      }
      onCreated(await roomApi.create({ type: "DIRECT", memberIds: [bot.id] }));
    } catch (requestError) {
      setError(
        getApiErrorMessage(requestError, "The demo bot isn't available on this server. Search for a person instead."),
      );
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-room-title">
        <div className="modal-header">
          <div><span className="form-kicker">A NEW SPACE</span><h2 id="create-room-title">Start a conversation</h2></div>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={19} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="room-choice-list">
            {roomChoices.map((choice) => {
              const Icon = choice.type === "AI_ASSISTANT" ? Bot : choice.type === "GROUP" ? Hash : MessageCircle;
              return <button type="button" key={choice.type} className={`room-choice ${type === choice.type ? "selected" : ""}`} onClick={() => chooseType(choice.type)}>
                <span className="choice-icon"><Icon size={18} /></span><span className="choice-copy"><strong>{choice.title}</strong><small>{choice.description}</small></span><span className="choice-radio" />
              </button>;
            })}
          </div>

          {type !== "AI_ASSISTANT" && <>
            <label className="field-label" htmlFor="user-search">{type === "DIRECT" ? "Person" : "Members"} <span className="optional-label">{type === "DIRECT" ? "ONE PERSON" : "OPTIONAL"}</span></label>
            {type === "DIRECT" && <button type="button" className="demo-bot-button" onClick={() => void openDemoBot()} disabled={demoLoading || loading}>
              {demoLoading ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
              <span><strong>Try the demo bot</strong><small>Open a live DM with {demoBotUsername} right away</small></span>
            </button>}
            <UserSearch selected={selected} onChange={setSelected} maxSelections={maxSelections} />
          </>}

          <label className="field-label" htmlFor="room-name">Name <span className="optional-label">OPTIONAL</span></label>
          <input className="text-input" id="room-name" placeholder={type === "AI_ASSISTANT" ? "e.g. Writing partner" : "Give this room a name"} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />

          {error && <div className="form-error" role="alert">{error}</div>}
          {directNeedsPerson && !error && <p className="form-hint">Search for one person to start a direct message.</p>}
          <button className="primary-button modal-submit" disabled={loading || demoLoading || directNeedsPerson}>{loading ? <LoaderCircle size={18} className="spin" /> : <>Create room <span>↗</span></>}</button>
        </form>
      </section>
    </div>
  );
}
