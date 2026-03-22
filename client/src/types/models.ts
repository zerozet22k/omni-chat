import { OutboundContentBlock } from "./outbound-content";

export type Channel = "facebook" | "telegram" | "viber" | "tiktok";
export type ConversationStatus = "open" | "pending" | "resolved";
export type MessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "file"
  | "sticker"
  | "location"
  | "contact"
  | "interactive"
  | "unsupported"
  | "system";

export interface SessionData {
  token: string;
  user: {
    _id: string;
    email: string;
    name: string;
    avatarUrl?: string;
  };
  workspaces: Array<{
    _id: string;
    name: string;
    slug: string;
    timeZone: string;
    role: "owner" | "admin" | "staff";
    status?: "active" | "invited" | "disabled";
  }>;
  activeWorkspaceId: string;
}

export interface Conversation {
  _id: string;
  workspaceId: string;
  channel: Channel;
  channelAccountId: string;
  externalChatId: string;
  externalUserId?: string;
  contactId?: string;
  assigneeUserId?: string | null;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt?: string;
  lastMessageText?: string;
  aiEnabled: boolean;
  aiState:
  | "idle"
  | "suggesting"
  | "auto_replied"
  | "needs_human"
  | "human_requested"
  | "human_active";
  tags: string[];
  contactName?: string;
  contact?: {
    _id: string;
    primaryName: string;
    channelIdentities?: Array<{
      channel: Channel;
      externalUserId: string;
      displayName?: string;
      username?: string;
      avatar?: string;
    }>;
  } | null;
  assignee?: {
    _id: string;
    name: string;
    avatarUrl?: string;
  } | null;
}

export interface Message {
  _id: string;
  conversationId: string;
  channel: Channel;
  direction: "inbound" | "outbound";
  senderType: "customer" | "agent" | "automation" | "ai" | "system";
  kind: MessageKind;
  text?: {
    body?: string;
    plain?: string;
  };
  media?: Array<{
    url?: string;
    mimeType?: string;
    filename?: string;
    size?: number;
    width?: number;
    height?: number;
    durationMs?: number;
    thumbnailUrl?: string;
    isTemporary?: boolean;
    expiresAt?: string | null;
    expirySource?: "provider_ttl" | "signed_url" | "unknown" | null;
    lastValidatedAt?: string | null;
    storedAssetId?: string | null;
    storedAssetUrl?: string | null;
  }>;
  location?: {
    lat?: number;
    lng?: number;
    label?: string;
  };
  contact?: {
    name?: string;
    phone?: string;
  };
  unsupportedReason?: string | null;
  status: "received" | "queued" | "sent" | "delivered" | "read" | "failed";
  meta?: Record<string, unknown> & {
    deliveryError?: string | null;
  };
  delivery?: {
    status: "queued" | "sent" | "delivered" | "read" | "failed";
    externalMessageId?: string | null;
    error?: string | null;
    request?: Record<string, unknown>;
  } | null;
  createdAt: string;
}

export interface Contact {
  _id: string;
  primaryName: string;
  phones: string[];
  notes?: string;
  channelIdentities: Array<{
    channel: Channel;
    externalUserId: string;
    displayName?: string;
    username?: string;
    avatar?: string;
  }>;
}

export interface ChannelConnection {
  _id: string;
  workspaceId: string;
  channel: Channel;
  displayName: string;
  externalAccountId: string;
  status: "active" | "inactive" | "pending" | "error";
  webhookUrl?: string | null;
  webhookVerified: boolean;
  verificationState:
  | "unverified"
  | "pending"
  | "verified"
  | "failed"
  | "pending_provider_verification";
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  lastError?: string | null;
  credentials: Record<string, unknown>;
  webhookConfig: Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

export interface KnowledgeItem {
  _id: string;
  workspaceId: string;
  title: string;
  content: string;
  tags: string[];
  isActive?: boolean;
}

export interface CannedReply {
  _id: string;
  workspaceId: string;
  title: string;
  body: string;
  blocks: OutboundContentBlock[];
  triggers: string[];
  category: string;
  isActive?: boolean;
}

export interface AISettings {
  workspaceId: string;
  enabled: boolean;
  autoReplyEnabled: boolean;
  afterHoursEnabled: boolean;
  confidenceThreshold: number;
  fallbackMessage: string;
  geminiModel: string;
  hasGeminiApiKey: boolean;
  supportedChannels: Record<Channel, boolean>;
}

export interface BusinessHoursDay {
  dayOfWeek: number;
  enabled: boolean;
  windows: Array<{
    start: string;
    end: string;
  }>;
}

export interface BusinessHours {
  workspaceId: string;
  timeZone: string;
  weeklySchedule: BusinessHoursDay[];
}

export interface AutomationState {
  businessHours?: BusinessHours | null;
  afterHoursRule?: {
    _id: string;
    name: string;
    isActive: boolean;
    action?: {
      fallbackText?: string;
    };
  } | null;
}

export interface AuditLog {
  _id: string;
  workspaceId?: string;
  conversationId?: string;
  messageId?: string;
  actorType: string;
  actorId?: string | null;
  eventType: string;
  reason?: string | null;
  confidence?: number | null;
  sourceHints: string[];
  data?: Record<string, unknown>;
  createdAt: string;
}
