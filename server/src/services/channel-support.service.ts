import { CanonicalChannel } from "../channels/types";
import { AISettingsModel } from "../models";

export type WorkspaceSupportedChannels = Record<CanonicalChannel, boolean>;

export const DEFAULT_SUPPORTED_CHANNELS: WorkspaceSupportedChannels = {
  facebook: true,
  telegram: true,
  viber: true,
  tiktok: true,
};

const normalizeSupportedChannels = (
  value: unknown
): WorkspaceSupportedChannels => {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  return {
    facebook:
      typeof record.facebook === "boolean"
        ? record.facebook
        : DEFAULT_SUPPORTED_CHANNELS.facebook,
    telegram:
      typeof record.telegram === "boolean"
        ? record.telegram
        : DEFAULT_SUPPORTED_CHANNELS.telegram,
    viber:
      typeof record.viber === "boolean"
        ? record.viber
        : DEFAULT_SUPPORTED_CHANNELS.viber,
    tiktok:
      typeof record.tiktok === "boolean"
        ? record.tiktok
        : DEFAULT_SUPPORTED_CHANNELS.tiktok,
  };
};

class ChannelSupportService {
  defaults() {
    return { ...DEFAULT_SUPPORTED_CHANNELS };
  }

  async getSupportedChannels(workspaceId: string) {
    const settings = await AISettingsModel.findOne({ workspaceId })
      .select("supportedChannels")
      .lean();

    return normalizeSupportedChannels(settings?.supportedChannels);
  }

  async isChannelEnabled(workspaceId: string, channel: CanonicalChannel) {
    const supportedChannels = await this.getSupportedChannels(workspaceId);
    return supportedChannels[channel];
  }
}

export const channelSupportService = new ChannelSupportService();
