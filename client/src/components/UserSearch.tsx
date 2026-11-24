import { useEffect, useState } from "react";
import { LoaderCircle, Search, X } from "lucide-react";
import { userApi } from "../services/api";
import { getInitials } from "../lib/utils";
import type { UserSummary } from "../types";

interface UserSearchProps {
  selected: UserSummary[];
  onChange: (users: UserSummary[]) => void;
  maxSelections: number;
}

interface SearchResult {
  query: string;
  users: UserSummary[];
  failed: boolean;
}

const minQueryLength = 2;
const debounceMs = 300;

function Avatar({ user }: { user: UserSummary }) {
  return <span className="user-avatar" aria-hidden="true">{getInitials(user.username)}</span>;
}

export function UserSearch({ selected, onChange, maxSelections }: UserSearchProps) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const term = query.trim();

  useEffect(() => {
    if (term.length < minQueryLength) {
      return;
    }

    // Each keystroke cancels the previous timer and in-flight request, so stale results never win.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      userApi
        .search(term, controller.signal)
        .then((users) => setResult({ query: term, users, failed: false }))
        .catch(() => {
          if (!controller.signal.aborted) {
            setResult({ query: term, users: [], failed: true });
          }
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  const current = result?.query === term ? result : null;
  const candidates = (current?.users ?? []).filter(
    (user) => !selected.some((item) => item.id === user.id),
  );

  function pick(user: UserSummary) {
    onChange([...selected, user].slice(-maxSelections));
    setQuery("");
  }

  function remove(userId: string) {
    onChange(selected.filter((user) => user.id !== userId));
  }

  return (
    <div className="user-search">
      {selected.length > 0 && (
        <ul className="user-chip-list" aria-label="Selected people">
          {selected.map((user) => (
            <li key={user.id} className="user-chip">
              <Avatar user={user} />
              <span>{user.username}</span>
              <button type="button" aria-label={`Remove ${user.username}`} onClick={() => remove(user.id)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="input-shell user-search-input">
        <Search size={15} />
        <input
          id="user-search"
          type="search"
          autoComplete="off"
          placeholder="Search by email or username"
          aria-describedby="user-search-status"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {term.length >= minQueryLength && (
        <div className="user-search-results" id="user-search-status" aria-live="polite">
          {!current && <div className="user-search-status"><LoaderCircle size={14} className="spin" /> Searching…</div>}
          {current?.failed && <div className="user-search-status error">Search is unavailable right now. Try again in a moment.</div>}
          {current && !current.failed && candidates.length === 0 && (
            <div className="user-search-status">No people match “{term}”.</div>
          )}
          {current && !current.failed && candidates.map((user) => (
            <button type="button" key={user.id} className="user-result" onClick={() => pick(user)}>
              <Avatar user={user} />
              <span className="user-result-copy">
                <strong>{user.username}</strong>
                <small>{user.email}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
