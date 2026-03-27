# Elqen Zero Server

This branch contains the backend service only, exported from the main `omni-chat` monorepo so Railway can deploy it as a single service repo.

## What Is Included

- Express API
- webhook routes
- realtime server
- MongoDB integration
- Redis/BullMQ coordination
- Dockerfile for Railway

## Local Run

```bash
npm install
npm run build
npm run start
```

## Railway

- Use this branch as the source branch
- Root directory should be the repository root
- Add MongoDB and Redis services
- Set env vars from `.env.example`

The frontend is not included in this branch.
