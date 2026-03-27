# Elqen Zero

Elqen Zero is a multi-workspace omni-channel business inbox for real customer operations. Businesses can connect messaging channels, manage customer conversations in one workspace-first inbox, and publish customer-facing website chat pages without mixing public routes into the internal app.

## Current Product Surface

- Internal workspace app under `/workspace/:slug/...`
- Public customer pages under `/w/:slug` and `/w/:slug/chat`
- Platform operations portal under `/portal`
- Multi-workspace accounts with account, workspace creation, and invite acceptance flows
- Shared inbox with realtime updates, contact context, media handling, stickers, and channel-aware message rendering
- AI settings, knowledge, canned replies, business-hours automation, billing foundations, workspace profile, and member management
- Public website chat with visitor detail capture and a composer-style chat UI
- Channel adapters and webhook flows for Facebook, Instagram, Telegram, Viber, TikTok, LINE, and website chat

## Stack

- `client`: React 18, Vite, TypeScript, MUI, Tailwind, Socket.IO client
- `server`: Express, TypeScript, Socket.IO, MongoDB/Mongoose, Redis, BullMQ, Stripe, Zod
- Data model: MongoDB is the source of truth; Redis is used for fast coordination, queueing, idempotency, and short-lived state

## Repo Layout

```text
.
|- client/   React app and public/internal routes
|- server/   API, webhooks, auth, workers, and channel services
|- docs/     deployment and architecture notes
|- scripts/  repo-level helper scripts
```

## Key Routes

- `/` landing page
- `/login` client login
- `/portal/...` internal platform portal
- `/account/...` account and workspace selection
- `/workspace/:slug/...` internal workspace screens
- `/w/:slug` public workspace landing/chat entry
- `/w/:slug/chat` public customer chat view

## Local Development

### Requirements

- Node.js 20 or newer
- MongoDB
- Redis

### Install

```bash
npm install
npm install --prefix client
npm install --prefix server
```

### Environment

Copy the example files and fill in the values you need:

```powershell
Copy-Item client/.env.example client/.env
Copy-Item server/.env.example server/.env
```

Important local defaults:

- client runs on `http://localhost:3000`
- server runs on `http://localhost:4000`
- client uses `VITE_API_URL` to reach the API
- server needs MongoDB and Redis configured before full channel and worker behavior is available

For local Redis, Docker is the recommended path:

```bash
docker run --name omni-chat-redis -p 6379:6379 -d redis:7-alpine
```

### Run

Start both apps together from the repo root:

```bash
npm run dev
```

If you need the public webhook dev flow:

```bash
npm run dev:public
```

Useful package-level commands:

```bash
npm run build --prefix client
npm run build --prefix server
npm run test --prefix client
npm run test --prefix server
```

## Deployment

This repo is prepared for Railway as two services from one GitHub repository:

- `server` service rooted at `server/`
- `client` service rooted at `client/`

Do not deploy the repository root as a single Railway service. The root package is only for local orchestration.

Production entrypoints already exist:

- server build: `npm run build`
- server start: `npm run start`
- client build: `npm run build`
- client start: `npm run start`

The client production server serves the built `dist` folder directly, so Railway can run it as a standard web service.
Both `client/` and `server/` now include a `Dockerfile` for more reliable Railway builds when each service points at the correct root directory.

See [docs/deploy-railway.md](docs/deploy-railway.md) for the full Railway setup, required variables, and deploy order.

## Environment Notes

Common production variables:

- client: `VITE_API_URL`
- server: `CLIENT_URL`, `SOCKET_ORIGIN`, `CORS_ALLOWED_ORIGINS`, `PUBLIC_WEBHOOK_BASE_URL`
- data services: `MONGO_URL`, `MONGO_DB`, `REDIS_URL`
- auth and secrets: `JWT_SECRET`, `SESSION_SECRET`, `FIELD_ENCRYPTION_KEY`
- optional integrations: Google OAuth, Meta, Stripe, Gemini/OpenAI model config

The canonical examples live in:

- `client/.env.example`
- `server/.env.example`

## Product Notes

- This repo is product code, not a demo scaffold.
- Internal app routes are workspace-first.
- Public customer chat stays separate from internal workspace routes.
- Redis is a coordination layer, not the long-term business record store.

## License

See `LICENSE`.
