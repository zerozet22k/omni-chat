# Railway Deployment

This repo is prepared to run as two Railway services from one GitHub repository:

- `server` for the API and webhooks
- `client` for the React app

Do not deploy the repo root as a single Railway service. The repository root is only the monorepo orchestrator, not a standalone production app.

## Before Railway

1. Push the current repo to GitHub.
2. Keep `client/.env` and `server/.env` out of Git. The examples to copy from are:
   - `client/.env.example`
   - `server/.env.example`
3. Use Node 20 or newer for both services.
4. Do not rely on Railway env auto-detection for these subfolder examples. This repo keeps service env templates inside `client/` and `server/`, so treat those files as your manual source of truth when filling Railway variables.

## Railway Layout

Create one Railway project with at least these services:

- `omni-chat-server`
- `omni-chat-client`

For each service, connect the same GitHub repo, then set the **Root Directory**:

- server service root: `server`
- client service root: `client`

The `server/` and `client/` directories now each include a `Dockerfile`, so once the service root is correct Railway can build either service without relying on root-level monorepo detection.

With those roots set, Railway can use the package scripts already in this repo:

- server build: `npm run build`
- server start: `npm run start`
- client build: `npm run build`
- client start: `npm run start`

## Required Infrastructure

The server needs:

- MongoDB
- Redis

Set `MONGO_URL` to your managed Mongo connection string.
Set `REDIS_URL` to your Redis connection string.

## Recommended Deploy Order

1. Deploy the `server` service first.
2. Copy the server public URL.
3. Set `client` `VITE_API_URL` to that server URL.
4. Deploy the `client` service.
5. Copy the client public URL.
6. Set these server variables to the client URL:
   - `CLIENT_URL`
   - `SOCKET_ORIGIN`
   - `CORS_ALLOWED_ORIGINS`
7. Set `PUBLIC_WEBHOOK_BASE_URL` on the server to the server public URL.
8. Redeploy both services once the URLs are wired.

## Server Variables

Minimum production variables for `server`:

- `CLIENT_URL`
- `CORS_ALLOWED_ORIGINS`
- `SOCKET_ORIGIN`
- `PUBLIC_WEBHOOK_BASE_URL`
- `MONGO_URL`
- `MONGO_DB`
- `REDIS_URL`
- `REDIS_REQUIRED=true`
- `JWT_SECRET`
- `SESSION_SECRET`
- `FIELD_ENCRYPTION_KEY`

Common optional variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `META_APP_ID`
- `META_APP_SECRET`
- `META_WEBHOOK_VERIFY_TOKEN`
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`
- `GEMINI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_API_BASE_URL`

## Client Variables

Recommended variables for `client`:

- `VITE_API_URL`
- `VITE_TENANT_MODE`
- `VITE_ALLOW_SIGNUP`
- `VITE_SITE_SUPPORT_EMAIL`
- `VITE_SITE_BILLING_EMAIL`

## GitHub Checklist

Before pushing for Railway:

- make sure `client/package-lock.json` is in GitHub
- make sure `server/package-lock.json` is in GitHub
- commit `client/.env.example`
- commit `server/.env.example`
- commit `docs/deploy-railway.md`

## Notes

- The client now serves its built `dist` folder with `client/scripts/serve-dist.mjs`, so Railway can run it as a normal web service.
- The server already binds to `PORT`, which matches Railway's runtime model.
- If you use Railway public domains first and custom domains later, update `CLIENT_URL`, `SOCKET_ORIGIN`, `CORS_ALLOWED_ORIGINS`, and `PUBLIC_WEBHOOK_BASE_URL` after the custom domain is live.

## Troubleshooting

- If Railway shows `Error creating build plan with Railpack`, it is usually still trying to build the repo root instead of `client/` or `server/`.
- Open the service `Settings`, set the `Root Directory` first, then redeploy.
- Create two services, not one:
  - one for `server`
  - one for `client`
- If Railway still does not pick up the `Dockerfile` automatically, verify the service source is the GitHub repo and the root directory matches the folder that contains the `Dockerfile`.
