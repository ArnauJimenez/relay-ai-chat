# Relay client

The client is a React 19, TypeScript, Vite, and Tailwind CSS application for the
chat backend in the parent directory.

## Run locally

1. Start the backend and database from the repository root.
2. Copy `.env.example` to `.env` if the API or Socket.io server uses a different
   address.
3. Run `npm install` and then `npm run dev` from this directory.
4. Open `http://127.0.0.1:5174`.

The default API base is `http://127.0.0.1:3001/api`; the default Socket.io
server is `http://127.0.0.1:3001`. Both can be configured with `VITE_API_URL`
and `VITE_SOCKET_URL`.

## Scripts

- `npm run dev` starts the Vite development server.
- `npm run build` type-checks and creates the production build in `dist/`.
- `npm run lint` runs Oxlint.

Sign-in and registration use the backend REST API. Authenticated screens use
Socket.io for live messages, Gemini response streaming, typing indicators, and
room presence. AI message bodies are rendered as GitHub-flavored Markdown.
