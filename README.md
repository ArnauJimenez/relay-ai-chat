# Relay — real-time chat with AI assistants

Relay is a full-stack real-time messaging app. People can chat in private
direct messages and group rooms, and talk to AI assistants that stream their
answers token by token. It is built as a production-style system: JWT-secured
REST and WebSocket APIs, PostgreSQL behind Prisma, rate limits on every costly
path, and a multi-provider LLM failover chain.

**Live demo:** `https://relay-ai-chat-seven.vercel.app` — click **Entrar como invitado / Demo**. No sign-up needed.

---

## Zero-friction demo

1. Open the app and press **Entrar como invitado / Demo**.
2. You get an isolated guest account (token valid 24 h) with two rooms ready:
   - a **direct message with `relay_guide`**, a demo bot that replies in real time, and
   - an **AI assistant** room backed by Gemini, Groq, Mistral, OpenRouter, and Cerebras.
3. To test messaging, open **New conversation → Try the demo bot**. One click opens a DM.
   To test with another person, search by email or username in the same dialog.

Guests cannot log in with a password, see each other's conversations, or appear
in user search. Their accounts and rooms are deleted after 24 hours.

---

## Architecture

```
  Browser (Vercel: React 19 + Vite)
     │  HTTPS  /api/*            JSON, Authorization: Bearer <JWT>
     │  WebSocket (Socket.io)    JWT in handshake auth
     ▼
  API server (Render: Node 24, Express 5, Socket.io, single instance)
     ├── Middleware      CORS · JSON body limit · trust proxy · rate limits · requireAuth
     ├── REST routes     /api/auth · /api/rooms · /api/users/search · /health
     ├── Socket handlers room:join · message:send · typing:* · presence
     ├── Demo service    guest sessions · bot replies · TTL cleanup
     └── AI service      persist STREAMING message → failover chain → stream chunks
                              Groq → Gemini → Mistral → OpenRouter → Cerebras
     │
     ▼  Prisma 7 + @prisma/adapter-pg
  PostgreSQL (Neon)      User · Room · RoomMember · Message
```

### Key engineering decisions

**Private rooms are enforced on the server, never by the client.**
Every route and socket event that touches a room first checks a `RoomMember`
row for the authenticated user ID taken from the verified JWT. REST history
returns `404` for non-members, so it does not reveal whether a room exists.
Socket events (`room:join`, `message:send`, `typing:*`) repeat the same check
against the database; a client cannot forge the sender or join a room by ID.

**Direct messages are exactly one-to-one and unique per pair.**
A `DIRECT` room must have exactly two members. Creating one returns the
existing conversation (`200 OK`) when the pair already has one. The lookup
matches rooms whose members are exactly that pair. A `directKey` column
(the two user IDs, sorted and joined) carries a unique constraint, so two
simultaneous requests cannot both create the DM. The loser of that race gets
the winner's room back.

**User search exposes only what it must.**
`GET /api/users/search?q=` requires a JWT, validates `q` with Zod (2–60
characters, trimmed), and matches case-insensitive partial `email` or
`username`. It selects `id`, `email`, `username`, and `avatarUrl` explicitly,
so password hashes and timestamps are never read. It excludes the caller and
guest accounts, and returns at most 8 results.

**Rate limiting protects every expensive or sensitive path.**

| Path | Limit | Key |
| --- | --- | --- |
| `POST /api/auth/login`, `/register` | 20 / 15 min | client IP |
| `POST /api/auth/demo` | 10 / hour | client IP |
| `GET /api/users/search` | 30 / min | user ID |
| Socket `message:send` | 60 / min | user ID |
| AI responses (LLM calls) | 10 / min | user ID |

The limiter is an in-memory fixed window. It is correct for one instance and
must move to a shared store (for example Redis) before horizontal scaling.
`trust proxy` is set so that behind Render's proxy the limits see the real client IP.

**LLM failover with bounded latency and no mixed answers.**

```
Groq ──timeout/error──▶ Gemini ──timeout/error──▶ Mistral
                       ──timeout/error──▶ OpenRouter ──timeout/error──▶ Cerebras
```

- Each provider gets one attempt under its own `AbortController`, with an 8 s timeout. `AI_PROVIDER_TIMEOUT_MS` may lower this limit but cannot raise it.
- Providers are tried in order. A provider that is not configured (no API key) is skipped.
- HTTP errors (including 429 and 503), timeouts, network errors, and empty responses immediately move to the next provider. Failures are logged by provider, model, attempt, category, and status without logging API keys or response bodies.
- **Clean cut after the first chunk:** once any text has been streamed to the client, a failure marks the message `FAILED` instead of switching providers. Two models never write into the same answer.
- If every provider fails, the message is persisted as `FAILED` and the client gets an `error:event`.

**Degraded dependencies return honest status codes.**
Prisma connectivity errors (`P1001`, `P1017`, `P2024`, and similar) map to
`503 Service Unavailable` with `Retry-After`. Everything else is a `500` with
no internal details.

**Guest accounts are isolated by design.**
Each guest gets a random username and a password hash nobody knows. The
shared `relay_guide` bot is a normal user, so its DMs are separate rooms per
guest. Expired guests are removed hourly, along with rooms left without members.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite 8, TypeScript, Socket.io client, Axios, Tailwind CSS 4 |
| API | Node.js 24, Express 5, Socket.io 4, Zod 4, JWT, bcryptjs, pino |
| Data | PostgreSQL (Neon), Prisma 7 with `@prisma/adapter-pg` |
| AI | `@google/genai` (Gemini), plus Groq, Mistral, OpenRouter, and Cerebras via OpenAI-compatible chat completions |
| Testing | Vitest, Supertest, socket.io-client |
| Hosting | Vercel (client), Render (API, `render.yaml` blueprint), Neon (database) |

Project layout:

```
src/                   API server
  index.ts             Express + Socket.io bootstrap, socket handlers, error handling
  routes/              auth, rooms, users
  services/            llm-providers, ai, demo, rate-limit, cors, prisma
  middlewares/         requireAuth, rate limiting
prisma/                schema and SQL migrations
client/                React application
tests/                 unit and integration suites
render.yaml            Render blueprint
```

---

## Local setup

Requirements: Node.js 24, a PostgreSQL database, and at least one LLM API key.

```bash
# Backend (repository root)
cp .env.example .env
# Set DATABASE_URL, JWT_SECRET and at least one LLM key in .env.
npm install
# Apply existing migrations; use db:migrate while developing schema changes.
npm run db:deploy
# Starts the API at http://127.0.0.1:3001.
npm run dev

# Frontend
cd client
cp .env.example .env
npm install
# Starts the frontend at http://127.0.0.1:5174.
npm run dev
```

### Environment variables (backend)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (`sslmode=require` on Neon) |
| `JWT_SECRET` | yes | Signs session tokens |
| `CORS_ORIGIN` | yes in production | Comma-separated frontend origins, or `*` |
| `GROQ_API_KEY` | at least one provider key | Primary provider |
| `GEMINI_API_KEY` | at least one provider key | First fallback provider |
| `MISTRAL_API_KEY` | at least one provider key | Failover provider |
| `OPENROUTER_API_KEY` | at least one provider key | Failover provider |
| `CEREBRAS_API_KEY` | at least one provider key | Failover provider |
| `GEMINI_MODEL` / `GROQ_MODEL` / `MISTRAL_MODEL` / `OPENROUTER_MODEL` / `CEREBRAS_MODEL` | no | Model overrides (`gemini-3.8-flash` / `openai/gpt-oss-20b` / `mistral-small-latest` / `openrouter/free` / `qwen-3.8-27b`) |
| `AI_PROVIDER_TIMEOUT_MS` | no | Per-provider timeout in milliseconds (default and maximum `8000`; may be lowered) |
| `PORT` | no | Defaults to `3000` locally; Render sets it automatically |

### Frontend variables (`client/`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | yes for production builds | Absolute API base URL, e.g. `https://…onrender.com/api` |
| `VITE_SOCKET_URL` | no | Socket.io origin; defaults to the origin of `VITE_API_URL` |

Production builds fail without an absolute `VITE_API_URL`, so the bundle can
never point at localhost by accident.

---

## Testing

```bash
# Backend type check and unit suites (no database needed)
npx tsc --noEmit -p tsconfig.test.json
npx vitest run \
  tests/llm-failover.test.ts \
  tests/rate-limit-cors.test.ts \
  tests/database-errors.test.ts \
  tests/users-rooms.route.test.ts

# Full suite, including end-to-end API and Socket.io tests (needs a migrated DATABASE_URL)
npm test

# Frontend type check, lint and production build
cd client
npm run build && npm run lint
```

The unit suites cover the failover chain (timeouts, immediate failover on provider
errors, and clean cut after the first chunk), provider endpoints and default
models, rate limiting, CORS parsing, database error classification, user search
validation and field selection, and DM deduplication. They use mocked Prisma and
fake providers.
The integration suite runs against a real database.

---

## Production deployment

1. **Neon.** Create a project and copy the connection string with `sslmode=require`.
2. **Render.** Create a Blueprint from this repository (`render.yaml`). Fill in
   `DATABASE_URL`, `CORS_ORIGIN` (your Vercel URL without a trailing slash), and
   the LLM keys. `JWT_SECRET` is generated. The start command runs
   `prisma migrate deploy` before starting the server. Health check: `/health`.
3. **Vercel.** Import the repository with **Root Directory** set to `client`.
   Set `VITE_API_URL` to `https://<your-render-service>.onrender.com/api`.
4. Add every preview URL you want to use to `CORS_ORIGIN` on Render.

Migrations live in `prisma/migrations/`: `init` creates the schema and
`direct_room_key` adds the DM uniqueness key.

---

## Known limitations

- **Single instance.** Rate limits and Socket.io presence live in process memory. Scaling out needs a shared store and the Socket.io Redis adapter.
- **Email is visible to signed-in users through search.** This is the intended discovery model, but it allows enumeration. Rate limiting and guest exclusion limit the impact. A stricter model would add a per-user visibility setting.
- **No consent step for group membership.** Any member can add an existing user to a group room.
- **Session tokens live in `localStorage`.** That is acceptable for this demo scope. A production version should use `httpOnly` cookies with CSRF protection.
