import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const platformSettingsSchema = new Schema(
  {
    singletonKey: {
      type: String,
      required: true,
      unique: true,
      default: "default",
    },
    payments: {
      stripe: {
        enabled: {
          type: Boolean,
          default: true,
        },
      },
      manualEmail: {
        enabled: {
          type: Boolean,
          default: true,
        },
        contactEmail: {
          type: String,
          default: "elqenzero@gmail.com",
        },
      },
      kbzpay: {
        enabled: {
          type: Boolean,
          default: false,
        },
        contactEmail: {
          type: String,
          default: "elqenzero@gmail.com",
        },
      },
    },
  },
  {
    collection: "platform_settings",
    timestamps: true,
  }
);

export type PlatformSettingsDocument = HydratedDocument<
  InferSchemaType<typeof platformSettingsSchema>
>;

export const PlatformSettingsModel = model(
  "PlatformSettings",
  platformSettingsSchema
);
