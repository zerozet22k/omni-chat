export const BOT_PAUSE_DURATION_MS = 60 * 60 * 1000;

export type BotPauseState = "active" | "expired" | null;

function toOptionalString(value: unknown) {
  return value == null ? null : String(value);
}

export function buildBotPauseWindow(startedAt: Date) {
  return {
    botPausedAt: startedAt,
    botPausedUntil: new Date(startedAt.getTime() + BOT_PAUSE_DURATION_MS),
  };
}

export function getBotPauseState(value: {
  botPausedAt?: Date | null;
  botPausedUntil?: Date | null;
  resolvedAt?: Date | null;
}, referenceTime = new Date()): BotPauseState {
  if (value.resolvedAt || !value.botPausedAt) {
    return null;
  }

  const pausedUntil = value.botPausedUntil
    ? new Date(value.botPausedUntil)
    : new Date(value.botPausedAt.getTime() + BOT_PAUSE_DURATION_MS);

  return pausedUntil.getTime() > referenceTime.getTime() ? "active" : "expired";
}

export function isBotPauseBlockingAutomation(value: {
  botPausedAt?: Date | null;
  resolvedAt?: Date | null;
}) {
  return !!value.botPausedAt && !value.resolvedAt;
}

export function serializeBotPause(value: {
  botPausedAt?: Date | null;
  botPausedUntil?: Date | null;
  botPausedByUserId?: unknown;
  resolvedAt?: Date | null;
}, referenceTime = new Date()) {
  return {
    botPausedAt: value.botPausedAt?.toISOString() ?? null,
    botPausedUntil:
      value.botPausedUntil?.toISOString() ??
      (value.botPausedAt
        ? new Date(value.botPausedAt.getTime() + BOT_PAUSE_DURATION_MS).toISOString()
        : null),
    botPausedByUserId: toOptionalString(value.botPausedByUserId),
    botPauseState: getBotPauseState(value, referenceTime),
  };
}