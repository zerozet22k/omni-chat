import { HydratedDocument, InferSchemaType, Schema, model } from "mongoose";

const dataDeletionRequestSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["facebook"],
      required: true,
    },
    providerUserId: { type: String, required: true, index: true },
    confirmationCode: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["completed"],
      default: "completed",
      required: true,
    },
    summary: { type: String, required: true },
  },
  {
    collection: "dataDeletionRequests",
    timestamps: true,
  }
);

export type DataDeletionRequestDocument = HydratedDocument<
  InferSchemaType<typeof dataDeletionRequestSchema>
>;

export const DataDeletionRequestModel = model(
  "DataDeletionRequest",
  dataDeletionRequestSchema
);
