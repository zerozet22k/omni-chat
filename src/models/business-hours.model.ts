import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const timeWindowSchema = new Schema(
  {
    start: { type: String, required: true },
    end: { type: String, required: true },
  },
  { _id: false }
);

const businessDaySchema = new Schema(
  {
    dayOfWeek: { type: Number, required: true },
    enabled: { type: Boolean, default: false },
    windows: { type: [timeWindowSchema], default: [] },
  },
  { _id: false }
);

const businessHoursSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
    },
    timeZone: { type: String, default: "Asia/Bangkok" },
    weeklySchedule: { type: [businessDaySchema], default: [] },
  },
  {
    collection: "business_hours",
    timestamps: true,
  }
);

export type BusinessHoursDocument = HydratedDocument<
  InferSchemaType<typeof businessHoursSchema>
>;

export const BusinessHoursModel = model("BusinessHours", businessHoursSchema);
