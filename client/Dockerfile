FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts

EXPOSE 3000

CMD ["node", "scripts/serve-dist.mjs"]
