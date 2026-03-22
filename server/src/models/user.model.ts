import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    role: { type: String, default: "owner" },
    avatarUrl: { type: String },
    workspaceIds: [{ type: Schema.Types.ObjectId, ref: "Workspace" }],
  },
  {
    collection: "users",
    timestamps: true,
  }
);

export type UserDocument = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const UserModel = model("User", userSchema);
