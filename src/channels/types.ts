export const CHANNELS = ["facebook", "instagram", "telegram", "viber", "tiktok", "line", "website"] as const;
export const MESSAGE_KINDS = [
  "text",
  "image",
  "video",
  "audio",
  "file",
  "sticker",
  "location",
  "contact",
  "interactive",
  "unsupported",
  "system",
] as const;
export const OUTBOUND_MESSAGE_KINDS = [
  "text",
  "image",
  "video",
  "audio",
  "file",
  "sticker",
  "location",
  "contact",
  "interactive",
] as const;
export const SENDER_TYPES = [
  "customer",
  "agent",
  "automation",
  "ai",
  "system",
] as const;
export const DIRECTIONS = ["inbound", "outbound"] as const;
export const DELIVERY_STATUSES = [
  "received",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
] as const;
export const CONVERSATION_STATUSES = [
  "open",
  "pending",
  "resolved",
] as const;

export const CONVERSATION_ROUTING_STATES = [
  "bot_active",
  "human_pending",
  "human_active",
] as const;

export const ATTENTION_ITEM_STATES = [
  "open",
  "bot_replied",
  "awaiting_human",
  "human_replied",
  "closed",
] as const;

export const ATTENTION_NEEDS_HUMAN_REASONS = [
  "low_confidence",
  "manual_request",
  "customer_requested_human",
  "policy_block",
  "bot_failure",
  "after_hours",
  "other",
] as const;

export const ATTENTION_RESOLUTION_TYPES = [
  "bot_reply",
  "human_reply",
  "auto_ack_only",
  "ignored",
  "merged_into_newer_item",
] as const;

export const CHANNEL_CONNECTION_STATUSES = [
  "active",
  "attention_required",
  "restricted_due_to_plan",
  "credentials_invalid",
  "disconnected",
  // Legacy persisted values tolerated while connections are normalized forward.
  "inactive",
  "pending",
  "error",
] as const;
export const CHANNEL_CONNECTION_VERIFICATION_STATES = [
  "unverified",
  "pending",
  "verified",
  "failed",
  "pending_provider_verification",
] as const;

export type CanonicalChannel = (typeof CHANNELS)[number];
export type CanonicalMessageKind = (typeof MESSAGE_KINDS)[number];
export type OutboundMessageKind = (typeof OUTBOUND_MESSAGE_KINDS)[number];
export type CanonicalSenderType = (typeof SENDER_TYPES)[number];
export type CanonicalDirection = (typeof DIRECTIONS)[number];
export type CanonicalDeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export type ConversationRoutingState = (typeof CONVERSATION_ROUTING_STATES)[number];
export type ChannelConnectionStatus =
  (typeof CHANNEL_CONNECTION_STATUSES)[number];
export type ChannelConnectionVerificationState =
  (typeof CHANNEL_CONNECTION_VERIFICATION_STATES)[number];
export type AttentionItemState = (typeof ATTENTION_ITEM_STATES)[number];
export type AttentionNeedsHumanReason =
  (typeof ATTENTION_NEEDS_HUMAN_REASONS)[number];
export type AttentionResolutionType =
  (typeof ATTENTION_RESOLUTION_TYPES)[number];

export interface MessageMetadata extends Record<string, unknown> {
  actorUserId?: string | null;
  actorRunId?: string | null;
  inReplyToMessageId?: string | null;
  attentionItemId?: string | null;
  deliveryError?: string | null;
}

export interface CanonicalMedia {
  url?: string;
  mimeType?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  providerFileId?: string;
  thumbnailUrl?: string;
  isTemporary?: boolean;
  expiresAt?: Date | null;
  expirySource?: "provider_ttl" | "signed_url" | "unknown" | null;
  lastValidatedAt?: Date | null;
  storedAssetId?: string | null;
  storedAssetUrl?: string | null;
}

export interface CanonicalLocation {
  lat: number;
  lng: number;
  label?: string;
}

export interface CanonicalContactPayload {
  name?: string;
  phone?: string;
}

export interface CanonicalInteractivePayload {
  subtype: string;
  label?: string;
  value?: string;
  payload?: unknown;
}

export interface CanonicalTextPayload {
  body: string;
  plain?: string;
}

export interface SenderProfile {
  displayName?: string;
  username?: string;
  avatar?: string;
}

export interface CanonicalMessage {
  channel: CanonicalChannel;
  channelAccountId?: string;
  externalMessageId?: string;
  externalChatId: string;
  externalSenderId?: string;
  direction: CanonicalDirection;
  senderType: CanonicalSenderType;
  kind: CanonicalMessageKind;
  text?: CanonicalTextPayload;
  media?: CanonicalMedia[];
  location?: CanonicalLocation;
  contact?: CanonicalContactPayload;
  interactive?: CanonicalInteractivePayload;
  unsupportedReason?: string;
  raw: unknown;
  meta?: MessageMetadata;
  occurredAt?: Date;
  senderProfile?: SenderProfile;
}

export interface ChannelCapabilities {
  inbound: {
    text: boolean;
    image: boolean;
    video: boolean;
    audio: boolean;
    file: boolean;
    sticker?: boolean;
    location: boolean;
    contact: boolean;
    interactive: boolean;
  };
  outbound: {
    text: boolean;
    image: boolean;
    video: boolean;
    audio: boolean;
    file: boolean;
    sticker?: boolean;
    location: boolean;
    contact: boolean;
    interactive: boolean;
    typingIndicator?: boolean;
  };
}

export interface OutboundCommand {
  senderType: Exclude<CanonicalSenderType, "customer">;
  kind: OutboundMessageKind;
  text?: CanonicalTextPayload;
  media?: CanonicalMedia[];
  location?: CanonicalLocation;
  contact?: CanonicalContactPayload;
  interactive?: CanonicalInteractivePayload;
  meta?: MessageMetadata;
  occurredAt?: Date;
}

export interface SendOutboundResult {
  externalMessageId?: string;
  status: "queued" | "sent" | "failed";
  raw?: unknown;
  error?: string;
  request?: unknown;
}

export interface ChannelAdapter {
  channel: CanonicalChannel;
  getCapabilities(): ChannelCapabilities;
  verifyWebhook?(req: {
    body: unknown;
    rawBody?: string;
    headers: Record<string, string>;
    query: Record<string, string | string[] | undefined>;
    connection?: {
      externalAccountId: string;
      credentials: Record<string, unknown>;
      webhookConfig: Record<string, unknown>;
      webhookUrl?: string | null;
      webhookVerified?: boolean;
      verificationState?: ChannelConnectionVerificationState;
    };
  }): Promise<boolean>;
  parseInbound(
    reqBody: unknown,
    headers?: Record<string, string>
  ): Promise<CanonicalMessage[]>;
  sendOutbound(input: {
    conversation: {
      externalChatId: string;
      channel: CanonicalChannel;
    };
    message: CanonicalMessage;
    connection: {
      externalAccountId: string;
      credentials: Record<string, unknown>;
      webhookConfig: Record<string, unknown>;
    };
  }): Promise<SendOutboundResult>;
}
