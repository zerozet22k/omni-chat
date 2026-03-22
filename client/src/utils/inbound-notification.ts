export type MessageReceivedRealtimePayload = {
  workspaceId?: string;
  conversationId?: string;
  messageId?: string;
  direction?: string;
  senderType?: string;
  kind?: string;
};

export const INBOUND_NOTIFICATION_SOUND_DATA_URI =
  // Tiny WAV beep for lightweight bundled notification sound.
  "data:audio/wav;base64,UklGRmQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YUAAAAAAgICAf39/f4CAgH9/f39/gICAf39/f4CAgH9/f39/gICAf39/f4CAgH9/f39/gICAf39/f4CAgH9/f39/gICAf39/f4CAgH9/f39/gICAf39/f4CAgA==";

/**
 * Decide whether a websocket message.received payload should trigger sound.
 * Rules:
 * - only new messageId values
 * - only inbound customer messages
 */
export function shouldPlayInboundNotification(
  payload: MessageReceivedRealtimePayload,
  seenMessageIds: Set<string>
): boolean {
  const messageId = payload.messageId?.trim();
  if (!messageId) {
    return false;
  }

  if (seenMessageIds.has(messageId)) {
    return false;
  }

  if (payload.direction !== "inbound") {
    return false;
  }

  if (payload.senderType !== "customer") {
    return false;
  }

  return true;
}
