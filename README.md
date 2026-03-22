
```
elqen-one
├─ APPREADME.md
├─ client
│  ├─ index.html
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ public
│  ├─ src
│  │  ├─ App.tsx
│  │  ├─ components
│  │  │  └─ app-shell.tsx
│  │  ├─ features
│  │  │  ├─ automations
│  │  │  ├─ channels
│  │  │  │  └─ ChannelConnectionCard.tsx
│  │  │  ├─ contacts
│  │  │  ├─ inbox
│  │  │  │  ├─ ChannelBadge.tsx
│  │  │  │  ├─ Composer.tsx
│  │  │  │  ├─ ContactPanel.tsx
│  │  │  │  ├─ ConversationList.tsx
│  │  │  │  └─ ThreadView.tsx
│  │  │  ├─ knowledge
│  │  │  ├─ settings
│  │  │  └─ ui
│  │  │     ├─ FilterChip.tsx
│  │  │     ├─ MetricCard.tsx
│  │  │     ├─ Select.tsx
│  │  │     └─ StatusBadge.tsx
│  │  ├─ hooks
│  │  │  └─ use-session.tsx
│  │  ├─ index.css
│  │  ├─ main.tsx
│  │  ├─ pages
│  │  │  ├─ AISettingsPage.tsx
│  │  │  ├─ AnalyticsPage.tsx
│  │  │  ├─ AutomationsPage.tsx
│  │  │  ├─ CannedRepliesPage.tsx
│  │  │  ├─ ChannelsPage.tsx
│  │  │  ├─ InboxPage.tsx
│  │  │  ├─ KnowledgePage.tsx
│  │  │  └─ LoginPage.tsx
│  │  ├─ services
│  │  │  ├─ api.ts
│  │  │  └─ realtime.ts
│  │  ├─ types
│  │  │  └─ models.ts
│  │  ├─ utils
│  │  └─ vite-env.d.ts
│  ├─ tsconfig.json
│  └─ vite.config.ts
├─ docs
│  ├─ api-contracts.md
│  ├─ messaging-architecture.md
│  └─ migration-notes.md
├─ LICENSE
└─ server
   ├─ package-lock.json
   ├─ package.json
   ├─ scripts
   │  ├─ dev-public-cloudflare.mjs
   │  └─ dev-public.mjs
   ├─ src
   │  ├─ app.ts
   │  ├─ channels
   │  │  ├─ adapter.registry.ts
   │  │  ├─ base.adapter.ts
   │  │  ├─ facebook.adapter.ts
   │  │  ├─ telegram.adapter.ts
   │  │  ├─ tiktok.adapter.ts
   │  │  ├─ types.ts
   │  │  └─ viber.adapter.ts
   │  ├─ config
   │  │  └─ env.ts
   │  ├─ db
   │  ├─ lib
   │  │  ├─ async-handler.ts
   │  │  ├─ errors.ts
   │  │  ├─ logger.ts
   │  │  ├─ mongo.ts
   │  │  ├─ realtime.ts
   │  │  └─ validators.ts
   │  ├─ middleware
   │  │  └─ error-handler.ts
   │  ├─ models
   │  │  ├─ ai-settings.model.ts
   │  │  ├─ audit-log.model.ts
   │  │  ├─ automation-rule.model.ts
   │  │  ├─ business-hours.model.ts
   │  │  ├─ canned-reply.model.ts
   │  │  ├─ channel-connection.model.ts
   │  │  ├─ contact.model.ts
   │  │  ├─ conversation.model.ts
   │  │  ├─ index.ts
   │  │  ├─ knowledge-item.model.ts
   │  │  ├─ message-delivery.model.ts
   │  │  ├─ message.model.ts
   │  │  ├─ user.model.ts
   │  │  └─ workspace.model.ts
   │  ├─ routes
   │  │  ├─ api
   │  │  │  ├─ ai-settings.ts
   │  │  │  ├─ audit-logs.ts
   │  │  │  ├─ auth.ts
   │  │  │  ├─ automations.ts
   │  │  │  ├─ canned-replies.ts
   │  │  │  ├─ channels.ts
   │  │  │  ├─ contacts.ts
   │  │  │  ├─ conversations.ts
   │  │  │  └─ knowledge.ts
   │  │  └─ webhooks
   │  │     ├─ facebook.ts
   │  │     ├─ telegram.ts
   │  │     ├─ tiktok.ts
   │  │     └─ viber.ts
   │  ├─ scripts
   │  │  └─ seed.ts
   │  ├─ server.ts
   │  ├─ services
   │  │  ├─ ai-reply.service.ts
   │  │  ├─ audit-log.service.ts
   │  │  ├─ automation.service.ts
   │  │  ├─ canned-reply.service.ts
   │  │  ├─ channel-connection.service.ts
   │  │  ├─ contact.service.ts
   │  │  ├─ conversation.service.ts
   │  │  ├─ inbound-webhook.service.ts
   │  │  ├─ knowledge.service.ts
   │  │  ├─ message.service.ts
   │  │  └─ outbound-message.service.ts
   │  └─ tests
   │     ├─ fixtures
   │     └─ messaging-core.test.ts
   └─ tsconfig.json

```