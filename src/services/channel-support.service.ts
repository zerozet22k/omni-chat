import { CanonicalChannel } from "../channels/types";
import { AISettingsModel } from "../models";
import { billingService } from "./billing.service";

export type WorkspaceSupportedChannels = Record<CanonicalChannel, boolean>;

export const DEFAULT_SUPPORTED_CHANNELS: WorkspaceSupportedChannels = {
  facebook: true,
  instagram: true,
  telegram: true,
  viber: true,
  tiktok: true,
  line: true,
  website: true,
};

const buildPlanAllowedChannels = (params: {
  allowWebsiteChat: boolean;
  allowedPlatformFamilies: string[];
}): WorkspaceSupportedChannels => {
  const families = new Set(params.allowedPlatformFamilies);
  const metaAllowed = families.has("meta");

  return {
    facebook: metaAllowed,
    instagram: metaAllowed,
    telegram: families.has("telegram"),
    viber: families.has("viber"),
    tiktok: families.has("tiktok"),
    line: families.has("line"),
    website: params.allowWebsiteChat && families.has("website"),
  };
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
    instagram:
      typeof record.instagram === "boolean"
        ? record.instagram
        : DEFAULT_SUPPORTED_CHANNELS.instagram,
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
    line:
      typeof record.line === "boolean"
        ? record.line
        : DEFAULT_SUPPORTED_CHANNELS.line,
    website:
      typeof record.website === "boolean"
        ? record.website
        : DEFAULT_SUPPORTED_CHANNELS.website,
  };
};

class ChannelSupportService {
  defaults() {
    return { ...DEFAULT_SUPPORTED_CHANNELS };
  }

  async getPlanAllowedChannels(workspaceId: string) {
    const billing = (await billingService.getWorkspaceBillingState(workspaceId)).serialized;
    return buildPlanAllowedChannels({
      allowWebsiteChat: billing.entitlements.allowWebsiteChat,
      allowedPlatformFamilies: billing.entitlements.allowedPlatformFamilies,
    });
  }

  async getSupportedChannels(workspaceId: string) {
    const [settings, planAllowedChannels] = await Promise.all([
      AISettingsModel.findOne({ workspaceId }).select("supportedChannels").lean(),
      this.getPlanAllowedChannels(workspaceId),
    ]);
    const storedChannels = normalizeSupportedChannels(settings?.supportedChannels);

    return {
      facebook: planAllowedChannels.facebook ? storedChannels.facebook : false,
      instagram: planAllowedChannels.instagram ? storedChannels.instagram : false,
      telegram: planAllowedChannels.telegram ? storedChannels.telegram : false,
      viber: planAllowedChannels.viber ? storedChannels.viber : false,
      tiktok: planAllowedChannels.tiktok ? storedChannels.tiktok : false,
      line: planAllowedChannels.line ? storedChannels.line : false,
      website: planAllowedChannels.website ? storedChannels.website : false,
    };
  }

  async isChannelEnabled(workspaceId: string, channel: CanonicalChannel) {
    const supportedChannels = await this.getSupportedChannels(workspaceId);
    return supportedChannels[channel];
  }
}

export const channelSupportService = new ChannelSupportService();
