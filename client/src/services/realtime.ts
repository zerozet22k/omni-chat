import { io, Socket } from "socket.io-client";
import { API_BASE_URL } from "./api-base";

export type WorkspaceSocketEvent =
  | "conversation.created"
  | "conversation.updated"
  | "message.received"
  | "message.sent"
  | "message.failed"
  | "connection.updated";

export const connectWorkspaceSocket = (workspaceId: string): Socket => {
  return io(API_BASE_URL, {
    transports: ["websocket", "polling"],
    query: {
      workspaceId,
    },
  });
};
