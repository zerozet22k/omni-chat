import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { env } from "../config/env";

type RealtimeEventName =
  | "conversation.created"
  | "conversation.updated"
  | "contact.updated"
  | "message.received"
  | "message.sent"
  | "message.failed"
  | "connection.updated"
  | "presence.updated"
  | "user.updated";

type RealtimePayload = {
  workspaceId: string;
  [key: string]: unknown;
};

let io: SocketIOServer | null = null;
const socketPresenceState = new Map<
  string,
  {
    workspaceId?: string;
    userId?: string;
    userName?: string;
    conversationId?: string | null;
    isComposing?: boolean;
  }
>();

const getWorkspaceRoom = (workspaceId: string) => `workspace:${workspaceId}`;

const buildConversationPresenceSnapshot = (
  workspaceId: string,
  conversationId: string
) => {
  const deduped = new Map<
    string,
    {
      userId: string;
      userName: string;
      isComposing: boolean;
      connectionCount: number;
    }
  >();

  for (const state of socketPresenceState.values()) {
    if (
      state.workspaceId !== workspaceId ||
      state.conversationId !== conversationId ||
      !state.userId ||
      !state.userName
    ) {
      continue;
    }

    const existing = deduped.get(state.userId);
    if (existing) {
      existing.isComposing = existing.isComposing || !!state.isComposing;
      existing.connectionCount += 1;
      continue;
    }

    deduped.set(state.userId, {
      userId: state.userId,
      userName: state.userName,
      isComposing: !!state.isComposing,
      connectionCount: 1,
    });
  }

  return Array.from(deduped.values()).sort((a, b) =>
    a.userName.localeCompare(b.userName)
  );
};

const emitConversationPresence = (workspaceId?: string, conversationId?: string | null) => {
  if (!io || !workspaceId || !conversationId) {
    return;
  }

  io.to(getWorkspaceRoom(workspaceId)).emit("presence.updated", {
    workspaceId,
    conversationId,
    viewers: buildConversationPresenceSnapshot(workspaceId, conversationId),
  });
};

export const initializeRealtime = (server: HttpServer) => {
  io = new SocketIOServer(server, {
    cors: {
      origin: env.SOCKET_ORIGIN || env.CLIENT_URL,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    const workspaceId = socket.handshake.query.workspaceId;
    const userId = socket.handshake.query.userId;
    const userName = socket.handshake.query.userName;
    if (typeof workspaceId === "string" && workspaceId.trim()) {
      socket.join(getWorkspaceRoom(workspaceId));
    }

    socketPresenceState.set(socket.id, {
      workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
      userId: typeof userId === "string" ? userId : undefined,
      userName: typeof userName === "string" ? userName : undefined,
      conversationId: null,
      isComposing: false,
    });

    socket.on("workspace.subscribe", (nextWorkspaceId: string) => {
      if (typeof nextWorkspaceId === "string" && nextWorkspaceId.trim()) {
        socket.join(getWorkspaceRoom(nextWorkspaceId));
        const current = socketPresenceState.get(socket.id);
        if (current) {
          current.workspaceId = nextWorkspaceId;
        }
      }
    });

    socket.on("workspace.unsubscribe", (nextWorkspaceId: string) => {
      if (typeof nextWorkspaceId === "string" && nextWorkspaceId.trim()) {
        socket.leave(getWorkspaceRoom(nextWorkspaceId));
      }
    });

    socket.on(
      "conversation.view",
      (payload: { conversationId?: string | null } | string | null | undefined) => {
        const current = socketPresenceState.get(socket.id);
        if (!current) {
          return;
        }

        const previousConversationId = current.conversationId;
        const nextConversationId =
          typeof payload === "string"
            ? payload
            : typeof payload?.conversationId === "string"
              ? payload.conversationId
              : null;

        current.conversationId = nextConversationId?.trim() || null;
        current.isComposing = false;

        emitConversationPresence(current.workspaceId, previousConversationId);
        emitConversationPresence(current.workspaceId, current.conversationId);
      }
    );

    socket.on(
      "conversation.compose",
      (payload:
        | { conversationId?: string | null; active?: boolean }
        | undefined) => {
        const current = socketPresenceState.get(socket.id);
        if (!current) {
          return;
        }

        const nextConversationId =
          typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : current.conversationId;
        const previousConversationId = current.conversationId;

        current.conversationId = nextConversationId || null;
        current.isComposing = !!payload?.active;

        emitConversationPresence(current.workspaceId, previousConversationId);
        emitConversationPresence(current.workspaceId, current.conversationId);
      }
    );

    socket.on("disconnect", () => {
      const current = socketPresenceState.get(socket.id);
      socketPresenceState.delete(socket.id);
      emitConversationPresence(current?.workspaceId, current?.conversationId);
    });
  });

  return io;
};

export const emitRealtimeEvent = (
  event: RealtimeEventName,
  payload: RealtimePayload
) => {
  if (!io) {
    return;
  }

  io.to(getWorkspaceRoom(payload.workspaceId)).emit(event, payload);
};

export const syncRealtimeUserProfile = (params: {
  userId: string;
  userName: string;
}) => {
  const userId = params.userId.trim();
  const userName = params.userName.trim();
  if (!userId || !userName) {
    return;
  }

  const affectedConversations = new Map<string, Set<string>>();

  for (const state of socketPresenceState.values()) {
    if (state.userId !== userId) {
      continue;
    }

    state.userName = userName;

    if (!state.workspaceId || !state.conversationId) {
      continue;
    }

    const workspaceConversations =
      affectedConversations.get(state.workspaceId) ?? new Set<string>();
    workspaceConversations.add(state.conversationId);
    affectedConversations.set(state.workspaceId, workspaceConversations);
  }

  for (const [workspaceId, conversationIds] of affectedConversations.entries()) {
    for (const conversationId of conversationIds) {
      emitConversationPresence(workspaceId, conversationId);
    }
  }
};
