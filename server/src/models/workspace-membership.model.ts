import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "staff"] as const;
export const WORKSPACE_MEMBER_STATUSES = [
  "active",
  "invited",
  "disabled",
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
      enum: WORKSPACE_MEMBER_ROLES,
      required: true,
      default: "staff",
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
