import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

export const WORKSPACE_MEMBER_PUBLIC_ROLES = [
  "owner",
  "admin",
  "manager",
  "agent",
  "viewer",
] as const;
export const WORKSPACE_MEMBER_STATUSES = [
  "active",
  "invited",
  "disabled",
  "inactive_due_to_plan_limit",
] as const;

const workspaceMembershipSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: {
      type: String,
      enum: WORKSPACE_MEMBER_PUBLIC_ROLES,
      required: true,
      default: "agent",
    },
    status: {
      type: String,
      enum: WORKSPACE_MEMBER_STATUSES,
      required: true,
      default: "active",
    },
    invitedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    inviteTokenHash: {
      type: String,
      default: null,
    },
    inviteExpiresAt: {
      type: Date,
      default: null,
    },
    inviteEmailSentAt: {
      type: Date,
      default: null,
    },
    inviteAcceptedAt: {
      type: Date,
      default: null,
    },
    lastActiveAt: {
      type: Date,
      default: null,
    },
  },
  {
    collection: "workspace_memberships",
    timestamps: true,
  }
);

workspaceMembershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
workspaceMembershipSchema.index({ userId: 1, status: 1 });

export type WorkspaceMembershipDocument = HydratedDocument<
  InferSchemaType<typeof workspaceMembershipSchema>
>;

export const WorkspaceMembershipModel = model(
  "WorkspaceMembership",
  workspaceMembershipSchema
);
