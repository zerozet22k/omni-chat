import { UserDocument, WorkspaceDocument, WorkspaceMembershipDocument } from "../models";

export type AuthContext = {
  userId: string;
  email: string;
  user: UserDocument;
};

export type WorkspaceContext = {
  workspace: WorkspaceDocument;
  workspaceMembership: WorkspaceMembershipDocument;
};
