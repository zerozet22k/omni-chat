import type { AuthContext, WorkspaceContext } from "./auth";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      workspace?: WorkspaceContext["workspace"];
      workspaceMembership?: WorkspaceContext["workspaceMembership"];
    }
  }
}

export {};
