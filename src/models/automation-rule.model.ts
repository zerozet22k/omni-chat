import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const automationRuleSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    type: {
      type: String,
      required: true,
      default: "after_hours_auto_reply",
    },
    name: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    trigger: { type: Schema.Types.Mixed, default: {} },
    action: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "automation_rules",
    timestamps: true,
  }
);

automationRuleSchema.index({ workspaceId: 1, type: 1 });

export type AutomationRuleDocument = HydratedDocument<
  InferSchemaType<typeof automationRuleSchema>
>;

export const AutomationRuleModel = model(
  "AutomationRule",
  automationRuleSchema
);
