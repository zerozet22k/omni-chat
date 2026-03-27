import { ConversationRoutingState } from "../channels/types";

export const BOT_ACTIVE_ROUTING_STATE: ConversationRoutingState = "bot_active";
export const HUMAN_PENDING_ROUTING_STATE: ConversationRoutingState = "human_pending";
export const HUMAN_ACTIVE_ROUTING_STATE: ConversationRoutingState = "human_active";
export const HUMAN_PENDING_TAG = "human_pending" as const;

export const HUMAN_HANDOFF_QUERY_ROUTING_STATES = [
  HUMAN_PENDING_ROUTING_STATE,
  HUMAN_ACTIVE_ROUTING_STATE,
] as const;

export const HUMAN_HANDOFF_QUERY_TAGS = [HUMAN_PENDING_TAG] as const;

export function normalizeConversationRoutingState(
  routingState: unknown
): ConversationRoutingState {
  if (routingState === HUMAN_PENDING_ROUTING_STATE) {
    return HUMAN_PENDING_ROUTING_STATE;
  }

  if (routingState === HUMAN_ACTIVE_ROUTING_STATE) {
    return HUMAN_ACTIVE_ROUTING_STATE;
  }

  return BOT_ACTIVE_ROUTING_STATE;
}

export function isHumanHandoffRoutingState(routingState: unknown) {
  const normalizedState = normalizeConversationRoutingState(routingState);
  return (
    normalizedState === HUMAN_PENDING_ROUTING_STATE ||
    normalizedState === HUMAN_ACTIVE_ROUTING_STATE
  );
}

export function isHumanActiveRoutingState(routingState: unknown) {
  return normalizeConversationRoutingState(routingState) === HUMAN_ACTIVE_ROUTING_STATE;
}

export function isHumanPendingRoutingState(routingState: unknown) {
  return normalizeConversationRoutingState(routingState) === HUMAN_PENDING_ROUTING_STATE;
}

export function hasHumanPendingTag(tags: unknown) {
  if (!Array.isArray(tags)) {
    return false;
  }

  return tags.includes(HUMAN_PENDING_TAG);
}