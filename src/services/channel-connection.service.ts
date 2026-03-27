import { randomUUID } from "crypto";
import axios from "axios";
import { adapterRegistry } from "../channels/adapter.registry";
import {
  CanonicalChannel,
  ChannelConnectionStatus,
  ChannelConnectionVerificationState,
} from "../channels/types";
import {
  BusinessHoursModel,
  ChannelConnectionDocument,
  ChannelConnectionModel,
  WorkspaceModel,
} from "../models";
import {
  ForbiddenError,
  IntegrationNotReadyError,
  NotFoundError,
  ValidationError,
} from "../lib/errors";
import { env } from "../config/env";
import { emitRealtimeEvent } from "../lib/realtime";
import { tiktokBusinessMessagingService } from "./tiktok-business-messaging.service";
import { logger } from "../lib/logger";
import { billingService } from "./billing.service";
import { channelSupportService } from "./channel-support.service";
import { withRedisLock } from "../lib/redis-lock";
import { invalidatePortalDashboardCache } from "../lib/portal-dashboard-cache";

type ConnectionPayload = {
  workspaceId: string;
  displayName?: string;
  externalAccountId?: string;
  credentials: Record<string, unknown>;
  webhookConfig: Record<string, unknown>;
};

type ConnectionValidationResult = {
  displayName: string;
  externalAccountId: string;
  credentials: Record<string, unknown>;
  webhookConfig: Record<string, unknown>;
  webhookUrl: string | null;
  webhookVerified: boolean;
  verificationState: ChannelConnectionVerificationState;
  status: ChannelConnectionStatus;
  lastError: string | null;
  diagnostics: Record<string, unknown>;
};

type ChannelPreflightChecklistItem = {
  code: string;
  label: string;
  description: string;
  fixPath: string;
};

const trimString = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const channelToPlatformFamily = (channel: CanonicalChannel) => {
  if (channel === "facebook" || channel === "instagram") {
    return "meta" as const;
  }

  return channel;
};

const formatChannelLabel = (channel: CanonicalChannel) => {
  if (channel === "line") {
    return "LINE";
  }

  if (channel === "tiktok") {
    return "TikTok";
  }

  if (channel === "website") {
    return "Website Chat";
  }

  return channel.charAt(0).toUpperCase() + channel.slice(1);
};

const getFacebookAppConfig = () => {
  const appId = trimString(env.META_APP_ID);
  const appSecret = trimString(env.META_APP_SECRET);
  const webhookVerifyToken = trimString(env.META_WEBHOOK_VERIFY_TOKEN);

  return {
    appId,
    appSecret,
    webhookVerifyToken,
    isConfigured: !!appId && !!appSecret && !!webhookVerifyToken,
  };
};

const formatProviderStatusError = (
  provider: string,
  statusCode: unknown,
  statusMessage: unknown,
  fallback: string
) => {
  const code = typeof statusCode === "number" ? String(statusCode) : "unknown";
  const message = trimString(statusMessage) || fallback;
  return `${provider} error (status=${code}): ${message}`;
};

const formatFacebookGraphError = (error: unknown) => {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const data = error.response?.data as
    | {
        error?: {
          message?: string;
          type?: string;
          code?: number;
          error_subcode?: number;
          fbtrace_id?: string;
        };
      }
    | undefined;

  const graph = data?.error;
  if (!graph) {
    return error.message;
  }

  const parts = [
    graph.message,
    graph.type ? `type=${graph.type}` : "",
    typeof graph.code === "number" ? `code=${graph.code}` : "",
    typeof graph.error_subcode === "number" ? `subcode=${graph.error_subcode}` : "",
    graph.fbtrace_id ? `trace=${graph.fbtrace_id}` : "",
  ].filter(Boolean);

  return parts.join(" | ");
};

class ChannelConnectionService {
  private async buildConnectionPreflightChecklist(
    workspaceId: string
  ): Promise<ChannelPreflightChecklistItem[]> {
    const [workspace, businessHours] = await Promise.all([
      WorkspaceModel.findById(workspaceId).select(
        "_id slug name publicSupportEmail publicWebsiteUrl"
      ),
      BusinessHoursModel.findOne({ workspaceId }).select("weeklySchedule"),
    ]);

    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }

    const profilePath = `/workspace/${workspace.slug}/workspace-profile`;
    const businessHoursPath = `/workspace/${workspace.slug}/business-hours`;
    const checklist: ChannelPreflightChecklistItem[] = [];

    if (!trimString(workspace.name)) {
      checklist.push({
        code: "business_name",
        label: "Business name",
        description: "Add a workspace/business name before connecting providers.",
        fixPath: profilePath,
      });
    }

    if (!trimString(workspace.publicSupportEmail)) {
      checklist.push({
        code: "support_email",
        label: "Support email",
        description:
          "Add a support email so providers have a valid business contact for this workspace.",
        fixPath: profilePath,
      });
    }

    if (!trimString(workspace.publicWebsiteUrl)) {
      checklist.push({
        code: "website_url",
        label: "Website URL",
        description:
          "Add the public website URL before connecting providers that expect business metadata.",
        fixPath: profilePath,
      });
    }

    const hasBusinessHours =
      businessHours?.weeklySchedule?.some(
        (day) => day.enabled && Array.isArray(day.windows) && day.windows.length > 0
      ) ?? false;

    if (!hasBusinessHours) {
      checklist.push({
        code: "business_hours",
        label: "Business hours",
        description:
          "Set business hours so provider setup and support availability are clearly defined.",
        fixPath: businessHoursPath,
      });
    }

    return checklist;
  }

  async assertConnectionPreflight(params: {
    workspaceId: string;
    channel: CanonicalChannel;
    actionLabel: string;
  }) {
    const checklist = await this.buildConnectionPreflightChecklist(params.workspaceId);
    if (!checklist.length) {
      return;
    }

    throw new ValidationError(
      `Complete workspace details before ${params.actionLabel}.`,
      {
        channelPreflight: true,
        channel: params.channel,
        checklist,
        fixPath: checklist[0]?.fixPath ?? null,
      }
    );
  }

  async getEffectiveConnectionState(connection: ChannelConnectionDocument) {
    const [billing, checklist] = await Promise.all([
      billingService.getWorkspaceBillingState(String(connection.workspaceId)),
      this.buildConnectionPreflightChecklist(String(connection.workspaceId)),
    ]);
    const family = channelToPlatformFamily(connection.channel);
    const planAllowsFamily =
      family === "website"
        ? billing.serialized.entitlements.allowWebsiteChat
        : billing.serialized.entitlements.allowedPlatformFamilies.includes(family);

    if (!planAllowsFamily) {
      return {
        status: "restricted_due_to_plan" as const,
        lastError: `${formatChannelLabel(
          connection.channel
        )} is restricted because the current plan no longer includes this platform family.`,
        preflightChecklist: checklist,
      };
    }

    if (checklist.length > 0) {
      return {
        status: "attention_required" as const,
        lastError: checklist[0]?.description ?? connection.lastError ?? null,
        preflightChecklist: checklist,
      };
    }

    if (
      connection.status === "error" ||
      connection.verificationState === "failed" ||
      connection.status === "credentials_invalid"
    ) {
      return {
        status: "credentials_invalid" as const,
        lastError:
          connection.lastError ??
          `${formatChannelLabel(connection.channel)} credentials need attention.`,
        preflightChecklist: checklist,
      };
    }

    if (
      connection.status === "inactive" ||
      connection.status === "disconnected"
    ) {
      return {
        status: "disconnected" as const,
        lastError: connection.lastError ?? null,
        preflightChecklist: checklist,
      };
    }

    if (
      connection.status === "pending" ||
      connection.verificationState === "pending" ||
      connection.verificationState === "pending_provider_verification" ||
      connection.status === "attention_required"
    ) {
      return {
        status: "attention_required" as const,
        lastError:
          connection.lastError ??
          `${formatChannelLabel(connection.channel)} still needs provider setup.`,
        preflightChecklist: checklist,
      };
    }

    return {
      status: "active" as const,
      lastError: connection.lastError ?? null,
      preflightChecklist: checklist,
    };
  }

  async ensureWebsiteChatConnection(workspaceId: string) {
    const existing = await ChannelConnectionModel.findOne({
      workspaceId,
      channel: "website",
    }).sort({ updatedAt: -1 });

    if (!existing) {
      return this.createConnection("website", {
        workspaceId,
        displayName: "Website chat",
        externalAccountId: `website-${workspaceId}`,
        credentials: {},
        webhookConfig: {},
      });
    }

    if (
      existing.status === "active" &&
      trimString(existing.webhookConfig?.connectionKey)
    ) {
      return existing;
    }

    return this.revalidateExistingConnection(String(existing._id), workspaceId, {
      displayName: existing.displayName,
      externalAccountId: existing.externalAccountId,
      credentials: existing.credentials ?? {},
      webhookConfig: existing.webhookConfig ?? {},
    });
  }

  async rehookConnections(params: { workspaceId?: string }) {
    const query: Record<string, unknown> = {};
    if (params.workspaceId) {
      query.workspaceId = params.workspaceId;
    }

    const connections = await ChannelConnectionModel.find(query).sort({ createdAt: 1 });
    const results: Array<{
      connectionId: string;
      channel: CanonicalChannel;
      workspaceId: string;
      status: ChannelConnectionStatus;
      webhookVerified: boolean;
      verificationState: ChannelConnectionVerificationState;
      webhookUrl: string | null;
      lastError: string | null;
    }> = [];

    for (const connection of connections) {
      const updated = await withRedisLock(
        `lock:channel-sync:${String(connection._id)}`,
        30,
        async () => {
          const validation = await this.validateConnection(connection.channel, {
            workspaceId: String(connection.workspaceId),
            displayName: connection.displayName,
            externalAccountId: connection.externalAccountId,
            credentials: connection.credentials ?? {},
            webhookConfig: connection.webhookConfig ?? {},
          });

          return ChannelConnectionModel.findByIdAndUpdate(
            connection._id,
            {
              $set: {
                displayName: validation.displayName,
                externalAccountId: validation.externalAccountId,
                credentials: validation.credentials,
                webhookConfig: validation.webhookConfig,
                webhookUrl: validation.webhookUrl,
                webhookVerified: validation.webhookVerified,
                verificationState: validation.verificationState,
                status: validation.status,
                lastError: validation.lastError,
                capabilities: adapterRegistry.get(connection.channel).getCapabilities(),
              },
            },
            { new: true }
          );
        }
      );

      if (!updated) {
        continue;
      }

      emitRealtimeEvent("connection.updated", {
        workspaceId: String(updated.workspaceId),
        connectionId: String(updated._id),
        channel: updated.channel,
        status: updated.status,
        verificationState: updated.verificationState,
      });

      results.push({
        connectionId: String(updated._id),
        channel: updated.channel,
        workspaceId: String(updated.workspaceId),
        status: updated.status,
        webhookVerified: !!updated.webhookVerified,
        verificationState: updated.verificationState,
        webhookUrl: updated.webhookUrl ?? null,
        lastError: updated.lastError ?? null,
      });
    }

    if (results.length) {
      await invalidatePortalDashboardCache();
    }

    return results;
  }

  async createConnection(
    channel: CanonicalChannel,
    payload: ConnectionPayload
  ): Promise<ChannelConnectionDocument> {
    await billingService.getWorkspaceBillingState(payload.workspaceId);

    const validation = await this.validateConnection(channel, payload);
    const existingConnection = await ChannelConnectionModel.findOne({
      workspaceId: payload.workspaceId,
      channel,
      externalAccountId: validation.externalAccountId,
    }).select("_id channel");

    await billingService.assertCanConnectChannel({
      workspaceId: payload.workspaceId,
      channel,
      ignoreConnectionId: existingConnection ? String(existingConnection._id) : null,
    });

    logger.info("Persisting channel connection", {
      workspaceId: payload.workspaceId,
      channel,
      externalAccountId: validation.externalAccountId,
      status: validation.status,
      verificationState: validation.verificationState,
    });

    let connection: ChannelConnectionDocument;
    try {
      connection = await ChannelConnectionModel.findOneAndUpdate(
        {
          workspaceId: payload.workspaceId,
          channel,
          externalAccountId: validation.externalAccountId,
        },
        {
          $set: {
            workspaceId: payload.workspaceId,
            channel,
            displayName: validation.displayName,
            externalAccountId: validation.externalAccountId,
            credentials: validation.credentials,
            webhookConfig: validation.webhookConfig,
            webhookUrl: validation.webhookUrl,
            webhookVerified: validation.webhookVerified,
            verificationState: validation.verificationState,
            status: validation.status,
            lastError: validation.lastError,
            capabilities: adapterRegistry.get(channel).getCapabilities(),
          },
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        }
      );
    } catch (error) {
      logger.error("Failed to persist channel connection", {
        workspaceId: payload.workspaceId,
        channel,
        externalAccountId: validation.externalAccountId,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
                ...(error && typeof error === "object" && "code" in error
                  ? { code: (error as { code?: unknown }).code }
                  : {}),
                ...(error && typeof error === "object" && "keyPattern" in error
                  ? { keyPattern: (error as { keyPattern?: unknown }).keyPattern }
                  : {}),
                ...(error && typeof error === "object" && "keyValue" in error
                  ? { keyValue: (error as { keyValue?: unknown }).keyValue }
                  : {}),
              }
            : String(error),
      });

      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === 11000
      ) {
        throw new ValidationError(
          "A Facebook connection for this Page already exists in this workspace. Delete or reconnect the existing one."
        );
      }

      throw new ValidationError(
        "Failed to save channel connection",
        error instanceof Error ? error.message : error
      );
    }

    logger.info("Channel connection persisted", {
      workspaceId: payload.workspaceId,
      channel,
      connectionId: String(connection._id),
      externalAccountId: connection.externalAccountId,
    });

    emitRealtimeEvent("connection.updated", {
      workspaceId: payload.workspaceId,
      connectionId: String(connection._id),
      channel: connection.channel,
      status: connection.status,
      verificationState: connection.verificationState,
    });

    await invalidatePortalDashboardCache();
    return connection;
  }

  async updateConnection(
    id: string,
    patch: Partial<{
      displayName: string;
      credentials: Record<string, unknown>;
      webhookConfig: Record<string, unknown>;
      webhookUrl: string | null;
      webhookVerified: boolean;
      verificationState: ChannelConnectionVerificationState;
      status: ChannelConnectionStatus;
      lastError: string | null;
      lastInboundAt: Date | null;
      lastOutboundAt: Date | null;
    }>
  ) {
    const connection = await ChannelConnectionModel.findByIdAndUpdate(
      id,
      { $set: patch },
      { new: true }
    );

    if (!connection) {
      throw new NotFoundError("Channel connection not found");
    }

    emitRealtimeEvent("connection.updated", {
      workspaceId: String(connection.workspaceId),
      connectionId: String(connection._id),
      channel: connection.channel,
      status: connection.status,
      verificationState: connection.verificationState,
    });

    return connection;
  }

  async revalidateExistingConnection(
    id: string,
    workspaceId: string,
    patch: Partial<ConnectionPayload> = {}
  ): Promise<ChannelConnectionDocument> {
    const existing = await ChannelConnectionModel.findById(id);

    if (!existing) {
      throw new NotFoundError("Channel connection not found");
    }

    if (String(existing.workspaceId) !== workspaceId) {
      throw new ForbiddenError("Channel connection does not belong to active workspace");
    }

    const mergedCredentials = {
      ...(existing.credentials ?? {}),
      ...(patch.credentials ?? {}),
    };
    const mergedWebhookConfig = {
      ...(existing.webhookConfig ?? {}),
      ...(patch.webhookConfig ?? {}),
    };

    return withRedisLock(`lock:channel-sync:${id}`, 30, async () => {
      const validation = await this.validateConnection(existing.channel, {
        workspaceId: String(existing.workspaceId),
        displayName: patch.displayName ?? existing.displayName,
        externalAccountId: patch.externalAccountId ?? existing.externalAccountId,
        credentials: mergedCredentials,
        webhookConfig: mergedWebhookConfig,
      });

      await billingService.assertCanConnectChannel({
        workspaceId,
        channel: existing.channel,
        ignoreConnectionId: String(existing._id),
      });

      const connection = await ChannelConnectionModel.findByIdAndUpdate(
        id,
        {
          $set: {
            displayName: validation.displayName,
            externalAccountId: validation.externalAccountId,
            credentials: validation.credentials,
            webhookConfig: validation.webhookConfig,
            webhookUrl: validation.webhookUrl,
            webhookVerified: validation.webhookVerified,
            verificationState: validation.verificationState,
            status: validation.status,
            lastError: validation.lastError,
            capabilities: adapterRegistry.get(existing.channel).getCapabilities(),
          },
        },
        { new: true }
      );

      if (!connection) {
        throw new NotFoundError("Channel connection not found");
      }

      emitRealtimeEvent("connection.updated", {
        workspaceId: String(connection.workspaceId),
        connectionId: String(connection._id),
        channel: connection.channel,
        status: connection.status,
        verificationState: connection.verificationState,
      });

      await invalidatePortalDashboardCache();
      return connection;
    });
  }

  async deleteConnection(id: string) {
    const connection = await ChannelConnectionModel.findByIdAndDelete(id);

    if (!connection) {
      throw new NotFoundError("Channel connection not found");
    }

    emitRealtimeEvent("connection.updated", {
      workspaceId: String(connection.workspaceId),
      connectionId: String(connection._id),
      channel: connection.channel,
      status: "inactive",
      verificationState: "unverified",
    });

    await invalidatePortalDashboardCache();
    return connection;
  }

  async deleteConnectionInWorkspace(id: string, workspaceId: string) {
    const existing = await ChannelConnectionModel.findById(id);

    if (!existing) {
      throw new NotFoundError("Channel connection not found");
    }

    if (String(existing.workspaceId) !== workspaceId) {
      throw new ForbiddenError("Channel connection does not belong to active workspace");
    }

    return this.deleteConnection(id);
  }

  async validateConnection(
    channel: CanonicalChannel,
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    if (channel === "telegram") {
      return this.validateTelegramConnection(payload);
    }

    if (channel === "viber") {
      return this.validateViberConnection(payload);
    }

    if (channel === "facebook") {
      return this.validateFacebookConnection(payload);
    }

    if (channel === "instagram") {
      return this.validateInstagramConnection(payload);
    }

    if (channel === "line") {
      return this.validateLineConnection(payload);
    }

    if (channel === "website") {
      return this.validateWebsiteConnection(payload);
    }

    return this.validateTikTokConnection(payload);
  }

  async getConnectionByWorkspaceAndChannel(params: {
    workspaceId: string;
    channel: CanonicalChannel;
    externalAccountId?: string;
    requireActive?: boolean;
  }) {
    const query: Record<string, unknown> = {
      workspaceId: params.workspaceId,
      channel: params.channel,
    };

    if (params.externalAccountId) {
      query.externalAccountId = params.externalAccountId;
    }

    if (params.requireActive !== false) {
      query.status = "active";
    }

    const connection = await ChannelConnectionModel.findOne(query).sort({
      updatedAt: -1,
    });

    if (!connection) {
      throw new NotFoundError("Channel connection not found");
    }

    emitRealtimeEvent("connection.updated", {
      workspaceId: String(connection.workspaceId),
      connectionId: String(connection._id),
      channel: connection.channel,
      status: connection.status,
      verificationState: connection.verificationState,
      lastInboundAt: connection.lastInboundAt,
    });

    return connection;
  }

  async listConnectionsByWorkspace(workspaceId: string) {
    return ChannelConnectionModel.find({ workspaceId }).sort({ createdAt: -1 });
  }

  async markInboundReceived(connectionId: string, receivedAt = new Date()) {
    const connection = await ChannelConnectionModel.findByIdAndUpdate(
      connectionId,
      {
        $set: {
          lastInboundAt: receivedAt,
          lastError: null,
          status: "active",
        },
      },
      { new: true }
    );

    if (!connection) {
      throw new NotFoundError("Channel connection not found");
    }

    emitRealtimeEvent("connection.updated", {
      workspaceId: String(connection.workspaceId),
      connectionId: String(connection._id),
      channel: connection.channel,
      status: connection.status,
      verificationState: connection.verificationState,
      lastOutboundAt: connection.lastOutboundAt,
    });

    return connection;
  }

  async markOutboundSent(connectionId: string, sentAt = new Date()) {
    const connection = await ChannelConnectionModel.findByIdAndUpdate(
      connectionId,
      {
        $set: {
          lastOutboundAt: sentAt,
          lastError: null,
          status: "active",
        },
      },
      { new: true }
    );

    if (!connection) {
      throw new NotFoundError("Channel connection not found");
    }

    emitRealtimeEvent("connection.updated", {
      workspaceId: String(connection.workspaceId),
      connectionId: String(connection._id),
      channel: connection.channel,
      status: connection.status,
      verificationState: connection.verificationState,
      lastError: connection.lastError,
    });

    return connection;
  }

  async markOutboundFailed(connectionId: string, message: string, attemptedAt = new Date()) {
    const connection = await ChannelConnectionModel.findByIdAndUpdate(
      connectionId,
      {
        $set: {
          lastOutboundAt: attemptedAt,
          lastError: message,
          // Keep verified/runtime-ready connections active even when a specific
          // outbound payload fails (e.g. invalid remote media identifier).
          status: "active",
        },
      },
      { new: true }
    );

    if (!connection) {
      throw new NotFoundError("Channel connection not found");
    }

    emitRealtimeEvent("connection.updated", {
      workspaceId: String(connection.workspaceId),
      connectionId: String(connection._id),
      channel: connection.channel,
      status: connection.status,
      verificationState: connection.verificationState,
      lastError: connection.lastError,
      lastOutboundAt: connection.lastOutboundAt,
    });

    return connection;
  }

  async markConnectionError(connectionId: string, message: string) {
    const connection = await ChannelConnectionModel.findByIdAndUpdate(
      connectionId,
      {
        $set: {
          status: "error",
          lastError: message,
        },
      },
      { new: true }
    );

    if (!connection) {
      throw new NotFoundError("Channel connection not found");
    }

    return connection;
  }

  async resolveFacebookConnection(pageId: string) {
    const connection = await ChannelConnectionModel.findOne({
      channel: "facebook",
      externalAccountId: pageId,
      status: "active",
    });

    if (!connection) {
      throw new NotFoundError(
        `No active Facebook connection found for page ${pageId}`
      );
    }

    return connection;
  }

  async markFacebookWebhookVerified() {
    const webhookUrl = this.buildWebhookUrl("facebook") || undefined;
    const scopedQuery: Record<string, unknown> = {
      channel: "facebook",
    };

    if (webhookUrl) {
      scopedQuery.webhookUrl = webhookUrl;
    }

    const scopedMatches = await ChannelConnectionModel.countDocuments(scopedQuery);
    const effectiveQuery = scopedMatches > 0 ? scopedQuery : { channel: "facebook" };

    if (scopedMatches === 0 && webhookUrl) {
      logger.warn("No Facebook connections matched current PUBLIC_WEBHOOK_BASE_URL during webhook verification; falling back to channel-wide activation", {
        webhookUrl,
      });
    }

    await ChannelConnectionModel.updateMany(effectiveQuery, {
      $set: {
        webhookVerified: true,
        verificationState: "verified",
        status: "active",
        lastError: null,
      },
    });

    const connections = await ChannelConnectionModel.find(effectiveQuery);
    for (const connection of connections) {
      emitRealtimeEvent("connection.updated", {
        workspaceId: String(connection.workspaceId),
        connectionId: String(connection._id),
        channel: connection.channel,
        status: connection.status,
        verificationState: connection.verificationState,
      });
    }

    return connections;
  }

  async resolveTelegramConnection(webhookSecret: string) {
    const connection = await ChannelConnectionModel.findOne({
      channel: "telegram",
      "credentials.webhookSecret": webhookSecret,
      status: "active",
    });

    if (!connection) {
      throw new NotFoundError(
        "No active Telegram connection matched the webhook secret"
      );
    }

    return connection;
  }

  async resolveInstagramConnection(accountId: string) {
    const normalizedAccountId = trimString(accountId);
    if (!normalizedAccountId) {
      throw new ValidationError("Instagram account id is required for webhook resolution");
    }

    const connection = await ChannelConnectionModel.findOne({
      channel: "instagram",
      externalAccountId: normalizedAccountId,
      status: "active",
    });

    if (!connection) {
      throw new NotFoundError(
        `No active Instagram connection found for account ${normalizedAccountId}`
      );
    }

    return connection;
  }

  async resolveViberConnection(
    connectionKey?: string
  ): Promise<ChannelConnectionDocument> {
    const normalizedKey = trimString(connectionKey);
    if (!normalizedKey) {
      throw new ValidationError(
        "Viber webhook connectionKey is required for runtime resolution"
      );
    }

    const keyedConnection = await ChannelConnectionModel.findOne({
      channel: "viber",
      "webhookConfig.connectionKey": normalizedKey,
      status: "active",
    });

    if (!keyedConnection) {
      throw new NotFoundError(
        `No active Viber connection matched connectionKey=${normalizedKey}`
      );
    }

    return keyedConnection;
  }

  async resolveTikTokConnection(
    businessId?: string
  ): Promise<ChannelConnectionDocument> {
    const normalizedBusinessId = trimString(businessId);
    if (!normalizedBusinessId) {
      throw new ValidationError(
        "TikTok webhook payload is missing user_openid/business_id"
      );
    }

    const connection = await ChannelConnectionModel.findOne({
      channel: "tiktok",
      externalAccountId: normalizedBusinessId,
      status: "active",
    });

    if (!connection) {
      throw new NotFoundError(
        `No active TikTok connection matched business_id=${normalizedBusinessId}`
      );
    }

    return connection;
  }

  async resolveLineConnection(botUserId?: string): Promise<ChannelConnectionDocument> {
    const normalizedBotUserId = trimString(botUserId);
    if (!normalizedBotUserId) {
      throw new ValidationError("LINE webhook payload is missing destination bot user id");
    }

    const connection = await ChannelConnectionModel.findOne({
      channel: "line",
      externalAccountId: normalizedBotUserId,
      status: "active",
    });

    if (!connection) {
      throw new NotFoundError(
        `No active LINE connection matched destination=${normalizedBotUserId}`
      );
    }

    return connection;
  }

  async resolveWebsiteConnection(
    connectionKey?: string
  ): Promise<ChannelConnectionDocument> {
    const normalizedKey = trimString(connectionKey);
    if (!normalizedKey) {
      throw new ValidationError(
        "Website webhook connectionKey is required for runtime resolution"
      );
    }

    const connection = await ChannelConnectionModel.findOne({
      channel: "website",
      "webhookConfig.connectionKey": normalizedKey,
      status: "active",
    });

    if (!connection) {
      throw new NotFoundError(
        `No active Website connection matched connectionKey=${normalizedKey}`
      );
    }

    return connection;
  }

  async markInstagramWebhookVerified() {
    const webhookUrl = this.buildWebhookUrl("instagram") || undefined;
    const scopedQuery: Record<string, unknown> = {
      channel: "instagram",
    };

    if (webhookUrl) {
      scopedQuery.webhookUrl = webhookUrl;
    }

    const scopedMatches = await ChannelConnectionModel.countDocuments(scopedQuery);
    const effectiveQuery = scopedMatches > 0 ? scopedQuery : { channel: "instagram" };

    if (scopedMatches === 0 && webhookUrl) {
      logger.warn("No Instagram connections matched current PUBLIC_WEBHOOK_BASE_URL during webhook verification; falling back to channel-wide activation", {
        webhookUrl,
      });
    }

    await ChannelConnectionModel.updateMany(effectiveQuery, {
      $set: {
        webhookVerified: true,
        verificationState: "verified",
        status: "active",
        lastError: null,
      },
    });

    const connections = await ChannelConnectionModel.find(effectiveQuery);
    for (const connection of connections) {
      emitRealtimeEvent("connection.updated", {
        workspaceId: String(connection.workspaceId),
        connectionId: String(connection._id),
        channel: connection.channel,
        status: connection.status,
        verificationState: connection.verificationState,
      });
    }

    return connections;
  }

  async serialize(connection: ChannelConnectionDocument) {
    const effectiveState = await this.getEffectiveConnectionState(connection);
    return {
      ...connection.toObject(),
      rawStatus: connection.status,
      status: effectiveState.status,
      lastError: effectiveState.lastError,
      preflightChecklist: effectiveState.preflightChecklist,
      credentials: this.summarizeCredentials(
        connection.channel,
        connection.credentials ?? {}
      ),
      webhookConfig: this.summarizeWebhookConfig(
        connection.channel,
        connection.webhookConfig ?? {}
      ),
    };
  }

  async serializeMany(connections: ChannelConnectionDocument[]) {
    return Promise.all(connections.map((connection) => this.serialize(connection)));
  }

  getPublicWebhookBaseUrl() {
    const baseUrl = trimTrailingSlash(env.PUBLIC_WEBHOOK_BASE_URL.trim());
    return baseUrl || "";
  }

  private buildWebhookUrl(
    channel:
      | "facebook"
      | "instagram"
      | "telegram"
      | "viber"
      | "tiktok"
      | "line"
      | "website",
    query?: Record<string, string>
  ) {
    const baseUrl = this.getPublicWebhookBaseUrl();
    if (!baseUrl) {
      return "";
    }

    const url = new URL(`/webhooks/${channel}`, `${baseUrl}/`);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value) {
          url.searchParams.set(key, value);
        }
      });
    }

    return url.toString();
  }

  private async validateTelegramConnection(
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    const botToken = trimString(payload.credentials.botToken);
    if (!botToken) {
      throw new ValidationError("Telegram bot token is required");
    }

    const meResponse = await axios
      .get(`https://api.telegram.org/bot${botToken}/getMe`)
      .catch((error) => {
        throw new ValidationError(
          "Telegram bot token validation failed",
          error instanceof Error ? error.message : error
        );
      });

    if (!meResponse.data?.ok || !meResponse.data?.result?.id) {
      throw new ValidationError("Telegram bot token validation failed");
    }

    const webhookSecret =
      trimString(payload.credentials.webhookSecret) || randomUUID();
    const webhookUrl = this.buildWebhookUrl("telegram");
    const bot = meResponse.data.result as {
      id: number;
      first_name?: string;
      username?: string;
      can_join_groups?: boolean;
      supports_inline_queries?: boolean;
    };

    if (!webhookUrl) {
      return {
        displayName:
          payload.displayName?.trim() ||
          bot.first_name ||
          (bot.username ? `@${bot.username}` : "Telegram bot"),
        externalAccountId: String(bot.id),
        credentials: {
          botToken,
          webhookSecret,
        },
        webhookConfig: payload.webhookConfig,
        webhookUrl: null,
        webhookVerified: false,
        verificationState: "pending",
        status: "pending",
        lastError:
          "PUBLIC_WEBHOOK_BASE_URL is required before Telegram webhook registration can complete.",
        diagnostics: {
          provider: {
            id: bot.id,
            username: bot.username,
            firstName: bot.first_name,
            canJoinGroups: bot.can_join_groups,
            supportsInlineQueries: bot.supports_inline_queries,
          },
        },
      };
    }

    try {
      const setWebhookResponse = await axios.post(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          url: webhookUrl,
          secret_token: webhookSecret,
          allowed_updates: ["message", "edited_message", "callback_query"],
        }
      );

      return {
        displayName:
          payload.displayName?.trim() ||
          bot.first_name ||
          (bot.username ? `@${bot.username}` : "Telegram bot"),
        externalAccountId: String(bot.id),
        credentials: {
          botToken,
          webhookSecret,
        },
        webhookConfig: payload.webhookConfig,
        webhookUrl,
        webhookVerified: !!setWebhookResponse.data?.ok,
        verificationState: setWebhookResponse.data?.ok ? "verified" : "failed",
        status: setWebhookResponse.data?.ok ? "active" : "error",
        lastError: setWebhookResponse.data?.ok
          ? null
          : "Telegram rejected webhook registration",
        diagnostics: {
          provider: {
            id: bot.id,
            username: bot.username,
            firstName: bot.first_name,
          },
          webhook: setWebhookResponse.data,
        },
      };
    } catch (error) {
      return {
        displayName:
          payload.displayName?.trim() ||
          bot.first_name ||
          (bot.username ? `@${bot.username}` : "Telegram bot"),
        externalAccountId: String(bot.id),
        credentials: {
          botToken,
          webhookSecret,
        },
        webhookConfig: payload.webhookConfig,
        webhookUrl,
        webhookVerified: false,
        verificationState: "failed",
        status: "error",
        lastError:
          error instanceof Error
            ? error.message
            : "Telegram webhook registration failed",
        diagnostics: {
          provider: {
            id: bot.id,
            username: bot.username,
            firstName: bot.first_name,
          },
        },
      };
    }
  }

  private async validateViberConnection(
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    const authToken = trimString(payload.credentials.authToken);
    if (!authToken) {
      throw new ValidationError("Viber auth token is required");
    }

    const accountInfoResponse = await axios
      .post(
        "https://chatapi.viber.com/pa/get_account_info",
        {},
        {
          headers: {
            "X-Viber-Auth-Token": authToken,
          },
        }
      )
      .catch((error) => {
        throw new ValidationError(
          "Viber auth token validation failed",
          error instanceof Error ? error.message : error
        );
      });

    if (accountInfoResponse.data?.status !== 0) {
      throw new ValidationError(
        formatProviderStatusError(
          "Viber account validation",
          accountInfoResponse.data?.status,
          accountInfoResponse.data?.status_message,
          "Viber auth token validation failed"
        )
      );
    }

    const account = accountInfoResponse.data as {
      id?: string;
      uri?: string;
      name?: string;
      avatar?: string;
    };
    const connectionKey =
      trimString(payload.webhookConfig.connectionKey) || randomUUID();
    const externalAccountId =
      trimString(account.id) || trimString(account.uri) || payload.externalAccountId;

    if (!externalAccountId) {
      throw new ValidationError(
        "Viber account validation succeeded but did not return an account identifier"
      );
    }

    const webhookUrl = this.buildWebhookUrl("viber", { connectionKey });
    if (!webhookUrl) {
      return {
        displayName:
          payload.displayName?.trim() || account.name || "Viber public account",
        externalAccountId,
        credentials: {
          authToken,
        },
        webhookConfig: {
          ...payload.webhookConfig,
          connectionKey,
        },
        webhookUrl: null,
        webhookVerified: false,
        verificationState: "pending",
        status: "pending",
        lastError:
          "PUBLIC_WEBHOOK_BASE_URL is required before Viber webhook registration can complete.",
        diagnostics: {
          provider: {
            id: account.id,
            uri: account.uri,
            name: account.name,
            avatar: account.avatar,
          },
        },
      };
    }

    try {
      const setWebhookResponse = await axios.post(
        "https://chatapi.viber.com/pa/set_webhook",
        {
          url: webhookUrl,
          event_types: [
            "message",
            "conversation_started",
            "delivered",
            "seen",
            "failed",
          ],
          send_name: true,
          send_photo: true,
        },
        {
          headers: {
            "X-Viber-Auth-Token": authToken,
          },
        }
      );

      const success = setWebhookResponse.data?.status === 0;

      return {
        displayName:
          payload.displayName?.trim() || account.name || "Viber public account",
        externalAccountId,
        credentials: {
          authToken,
        },
        webhookConfig: {
          ...payload.webhookConfig,
          connectionKey,
        },
        webhookUrl,
        webhookVerified: success,
        verificationState: success ? "verified" : "failed",
        status: success ? "active" : "error",
        lastError: success
          ? null
          : formatProviderStatusError(
              "Viber set_webhook",
              setWebhookResponse.data?.status,
              setWebhookResponse.data?.status_message,
              "Viber webhook registration failed"
            ),
        diagnostics: {
          provider: {
            id: account.id,
            uri: account.uri,
            name: account.name,
            status: setWebhookResponse.data?.status,
            statusMessage: setWebhookResponse.data?.status_message,
          },
          webhook: {
            url: webhookUrl,
            connectionKey,
            result: setWebhookResponse.data,
          },
        },
      };
    } catch (error) {
      const providerData =
        axios.isAxiosError(error) && error.response?.data
          ? (error.response.data as Record<string, unknown>)
          : null;

      return {
        displayName:
          payload.displayName?.trim() || account.name || "Viber public account",
        externalAccountId,
        credentials: {
          authToken,
        },
        webhookConfig: {
          ...payload.webhookConfig,
          connectionKey,
        },
        webhookUrl,
        webhookVerified: false,
        verificationState: "failed",
        status: "error",
        lastError: providerData
          ? formatProviderStatusError(
              "Viber set_webhook",
              providerData.status,
              providerData.status_message,
              "Viber webhook registration failed"
            )
          : error instanceof Error
            ? error.message
            : "Viber webhook registration failed",
        diagnostics: {
          provider: {
            id: account.id,
            uri: account.uri,
            name: account.name,
            status: providerData?.status,
            statusMessage: providerData?.status_message,
          },
          webhook: {
            url: webhookUrl,
            connectionKey,
            error: providerData ?? (error instanceof Error ? error.message : "unknown"),
          },
        },
      };
    }
  }

  private async validateFacebookConnection(
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    const pageAccessToken = trimString(payload.credentials.pageAccessToken);
    const facebookAppConfig = getFacebookAppConfig();

    logger.info("Validating Facebook channel connection", {
      workspaceId: payload.workspaceId,
      hasPageAccessToken: !!pageAccessToken,
      hasMetaAppId: !!facebookAppConfig.appId,
      hasMetaAppSecret: !!facebookAppConfig.appSecret,
      hasMetaWebhookVerifyToken: !!facebookAppConfig.webhookVerifyToken,
      publicWebhookBaseUrlConfigured: !!this.getPublicWebhookBaseUrl(),
    });

    if (!pageAccessToken) {
      throw new ValidationError("Facebook page access token is required");
    }

    if (!facebookAppConfig.appId || !facebookAppConfig.appSecret) {
      throw new ValidationError(
        "META_APP_ID and META_APP_SECRET are required to validate Facebook page tokens"
      );
    }

    const appAccessToken = `${facebookAppConfig.appId}|${facebookAppConfig.appSecret}`;
    const debugTokenResponse = await axios
      .get("https://graph.facebook.com/v19.0/debug_token", {
        params: {
          input_token: pageAccessToken,
          access_token: appAccessToken,
        },
      })
      .catch((error) => {
        const graphError = formatFacebookGraphError(error);
        logger.error("Facebook page token debug failed", {
          workspaceId: payload.workspaceId,
          error: graphError,
        });
        throw new ValidationError(
          "Facebook page token validation failed. Ensure META_APP_ID/META_APP_SECRET are correct and the app can inspect this token.",
          graphError
        );
      });

    const tokenData = (debugTokenResponse.data?.data ?? {}) as {
      is_valid?: boolean;
      type?: string;
      profile_id?: string | number;
      user_id?: string | number;
      scopes?: unknown[];
      granular_scopes?: unknown[];
      error?: { message?: string };
      app_id?: string | number;
      expires_at?: number;
    };

    logger.info("Facebook page token debug response", {
      workspaceId: payload.workspaceId,
      isValid: !!tokenData.is_valid,
      tokenType: tokenData.type ?? null,
      profileId: tokenData.profile_id ? String(tokenData.profile_id) : null,
      appId: tokenData.app_id ? String(tokenData.app_id) : null,
      scopesCount: Array.isArray(tokenData.scopes) ? tokenData.scopes.length : 0,
      granularScopesCount: Array.isArray(tokenData.granular_scopes)
        ? tokenData.granular_scopes.length
        : 0,
      expiresAt: tokenData.expires_at ?? null,
    });

    if (!tokenData.is_valid) {
      throw new ValidationError(
        "Facebook page token is invalid or expired. Re-run Facebook OAuth and select a managed Page.",
        tokenData.error?.message || "debug_token returned is_valid=false"
      );
    }

    const resolvedPageId =
      trimString(tokenData.profile_id) || trimString(tokenData.user_id);
    if (!resolvedPageId) {
      throw new ValidationError(
        "Unable to resolve Facebook Page ID from token. Re-run OAuth and choose a Page from the list."
      );
    }

    const expectedPageId = trimString(payload.externalAccountId);
    if (expectedPageId && expectedPageId !== resolvedPageId) {
      throw new ValidationError(
        "Selected Facebook Page does not match the provided access token. Re-select the Page from OAuth and try again.",
        {
          expectedPageId,
          resolvedPageId,
        }
      );
    }

    const webhookUrl = this.buildWebhookUrl("facebook");
    const subscriptionResult = await this.ensureFacebookPageSubscription({
      pageId: resolvedPageId,
      pageAccessToken,
      workspaceId: payload.workspaceId,
    });

    const hasVerifiedWebhook =
      !!webhookUrl &&
      facebookAppConfig.isConfigured &&
      !!(await ChannelConnectionModel.exists({
        channel: "facebook",
        webhookVerified: true,
        webhookUrl,
      }));
    const pendingReason = !facebookAppConfig.isConfigured
      ? "Facebook Messenger app config is missing. Set META_APP_ID, META_APP_SECRET, and META_WEBHOOK_VERIFY_TOKEN on the server."
      : !webhookUrl
        ? "PUBLIC_WEBHOOK_BASE_URL is required before Facebook webhook verification can complete."
        : "Complete the Meta Messenger webhook challenge for this server URL before inbound messaging can be trusted.";

    logger.info("Facebook channel validation result", {
      workspaceId: payload.workspaceId,
      pageId: resolvedPageId,
      pageName: payload.displayName?.trim() || null,
      pageSubscriptionOk: subscriptionResult.success,
      pageSubscriptionError: subscriptionResult.error || null,
      webhookUrl: webhookUrl || null,
      webhookVerified: hasVerifiedWebhook,
      pendingReason: hasVerifiedWebhook ? null : pendingReason,
    });

    return {
      displayName:
        payload.displayName?.trim() ||
        (expectedPageId ? `Facebook page ${expectedPageId}` : "") ||
        "Facebook page",
      externalAccountId: resolvedPageId,
      credentials: {
        pageAccessToken,
      },
      webhookConfig: payload.webhookConfig,
      webhookUrl: webhookUrl || null,
      webhookVerified: hasVerifiedWebhook,
      verificationState: hasVerifiedWebhook ? "verified" : "pending",
      status: hasVerifiedWebhook ? "active" : "pending",
      lastError: hasVerifiedWebhook ? null : pendingReason,
      diagnostics: {
        provider: {
          id: resolvedPageId,
          name: payload.displayName?.trim() || null,
          tokenType: tokenData.type ?? null,
          appIdConfigured: !!facebookAppConfig.appId,
          appSecretConfigured: !!facebookAppConfig.appSecret,
        },
        webhook: {
          url: webhookUrl || null,
          verifyTokenConfigured: !!facebookAppConfig.webhookVerifyToken,
          verified: hasVerifiedWebhook,
          pageSubscriptionOk: subscriptionResult.success,
          pageSubscriptionError: subscriptionResult.error || null,
        },
      },
    };
  }

  private async ensureFacebookPageSubscription(params: {
    pageId: string;
    pageAccessToken: string;
    workspaceId: string;
  }) {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v19.0/${params.pageId}/subscribed_apps`,
        null,
        {
          params: {
            subscribed_fields: "messages,messaging_postbacks",
            access_token: params.pageAccessToken,
          },
        }
      );

      const success = response.data?.success === true;
      if (success) {
        logger.info("Facebook page subscribed_apps succeeded", {
          workspaceId: params.workspaceId,
          pageId: params.pageId,
        });
        return { success: true as const };
      }

      logger.warn("Facebook page subscribed_apps returned non-success", {
        workspaceId: params.workspaceId,
        pageId: params.pageId,
        response: response.data,
      });
      return {
        success: false as const,
        error: "subscribed_apps returned success=false",
      };
    } catch (error) {
      const message = formatFacebookGraphError(error);
      logger.warn("Facebook page subscribed_apps failed", {
        workspaceId: params.workspaceId,
        pageId: params.pageId,
        error: message,
      });
      return { success: false as const, error: message };
    }
  }

  private async validateInstagramConnection(
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    const instagramAccessToken = trimString(payload.credentials.instagramAccessToken);
    const facebookAppConfig = getFacebookAppConfig();

    if (!instagramAccessToken) {
      throw new ValidationError("Instagram access token is required");
    }

    if (!facebookAppConfig.appId || !facebookAppConfig.appSecret) {
      throw new ValidationError(
        "META_APP_ID and META_APP_SECRET are required to validate Instagram tokens"
      );
    }

    const appAccessToken = `${facebookAppConfig.appId}|${facebookAppConfig.appSecret}`;
    const debugTokenResponse = await axios
      .get("https://graph.facebook.com/v19.0/debug_token", {
        params: {
          input_token: instagramAccessToken,
          access_token: appAccessToken,
        },
      })
      .catch((error) => {
        throw new ValidationError(
          "Instagram token validation failed. Ensure META_APP_ID/META_APP_SECRET are correct and the app can inspect this token.",
          formatFacebookGraphError(error)
        );
      });

    const tokenData = (debugTokenResponse.data?.data ?? {}) as {
      is_valid?: boolean;
      profile_id?: string | number;
      user_id?: string | number;
      type?: string;
      error?: { message?: string };
    };

    if (!tokenData.is_valid) {
      throw new ValidationError(
        "Instagram token is invalid or expired.",
        tokenData.error?.message || "debug_token returned is_valid=false"
      );
    }

    const resolvedAccountId =
      trimString(tokenData.profile_id) || trimString(tokenData.user_id);
    if (!resolvedAccountId) {
      throw new ValidationError(
        "Unable to resolve Instagram account ID from token."
      );
    }

    const webhookUrl = this.buildWebhookUrl("instagram");
    const hasVerifiedWebhook =
      !!webhookUrl &&
      !!(await ChannelConnectionModel.exists({
        channel: "instagram",
        webhookVerified: true,
        webhookUrl,
      }));

    const pendingReason = !webhookUrl
      ? "PUBLIC_WEBHOOK_BASE_URL is required before Instagram webhook verification can complete."
      : "Complete the Meta Instagram webhook challenge for this server URL before inbound messaging can be trusted.";

    return {
      displayName:
        payload.displayName?.trim() || `Instagram account ${resolvedAccountId}`,
      externalAccountId: resolvedAccountId,
      credentials: {
        instagramAccessToken,
      },
      webhookConfig: payload.webhookConfig,
      webhookUrl: webhookUrl || null,
      webhookVerified: hasVerifiedWebhook,
      verificationState: hasVerifiedWebhook ? "verified" : "pending",
      status: hasVerifiedWebhook ? "active" : "pending",
      lastError: hasVerifiedWebhook ? null : pendingReason,
      diagnostics: {
        provider: {
          id: resolvedAccountId,
          tokenType: tokenData.type ?? null,
          appIdConfigured: !!facebookAppConfig.appId,
          appSecretConfigured: !!facebookAppConfig.appSecret,
        },
        webhook: {
          url: webhookUrl || null,
          verifyTokenConfigured: !!facebookAppConfig.webhookVerifyToken,
          verified: hasVerifiedWebhook,
        },
      },
    };
  }

  private async validateTikTokConnection(
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    const webhookUrl = this.buildWebhookUrl("tiktok");
    const validation = await tiktokBusinessMessagingService.validateConnection({
      displayName: payload.displayName,
      externalAccountId: payload.externalAccountId,
      credentials: payload.credentials,
      webhookUrl: webhookUrl || null,
    });

    return {
      displayName: validation.displayName,
      externalAccountId: validation.externalAccountId,
      credentials: validation.credentials,
      webhookConfig: payload.webhookConfig,
      webhookUrl: validation.webhookUrl,
      webhookVerified: validation.webhookVerified,
      verificationState: validation.verificationState,
      status: validation.status,
      lastError: validation.lastError,
      diagnostics: validation.diagnostics,
    };
  }

  private async validateLineConnection(
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    const channelId = trimString(payload.credentials.channelId);
    let channelAccessToken = trimString(payload.credentials.channelAccessToken);
    const channelSecret = trimString(payload.credentials.channelSecret);

    if (!channelSecret) {
      throw new ValidationError("LINE channel secret is required");
    }

    let tokenSource: "provided" | "issued_from_channel_credentials" = "provided";
    if (!channelAccessToken) {
      if (!channelId) {
        throw new ValidationError(
          "Provide LINE Channel ID to auto-issue token, or paste a Messaging API channel access token"
        );
      }

      channelAccessToken = await this.issueLineChannelAccessToken({
        channelId,
        channelSecret,
      });
      tokenSource = "issued_from_channel_credentials";
    }

    const botInfoResponse = await axios
      .get("https://api.line.me/v2/bot/info", {
        headers: {
          Authorization: `Bearer ${channelAccessToken}`,
        },
      })
      .catch((error) => {
        throw new ValidationError(
          "LINE token validation failed",
          error instanceof Error ? error.message : error
        );
      });

    const botInfo = botInfoResponse.data as {
      userId?: string;
      displayName?: string;
      basicId?: string;
      pictureUrl?: string;
      chatMode?: string;
      markAsReadMode?: string;
    };

    const botUserId = trimString(botInfo.userId);
    if (!botUserId) {
      throw new ValidationError(
        "LINE token validation succeeded but did not return bot userId"
      );
    }

    const webhookUrl = this.buildWebhookUrl("line");

    return {
      displayName: payload.displayName?.trim() || botInfo.displayName || "LINE bot",
      externalAccountId: botUserId,
      credentials: {
        channelId: channelId || undefined,
        channelAccessToken,
        channelSecret,
      },
      webhookConfig: payload.webhookConfig,
      webhookUrl: webhookUrl || null,
      webhookVerified: false,
      verificationState: "pending_provider_verification",
      status: "active",
      lastError: null,
      diagnostics: {
        provider: {
          userId: botUserId,
          displayName: botInfo.displayName || null,
          basicId: botInfo.basicId || null,
          pictureUrl: botInfo.pictureUrl || null,
          chatMode: botInfo.chatMode || null,
          markAsReadMode: botInfo.markAsReadMode || null,
          tokenSource,
        },
        webhook: {
          url: webhookUrl || null,
          note: webhookUrl
            ? "Set this URL in LINE Developers Messaging API webhook settings."
            : "PUBLIC_WEBHOOK_BASE_URL is required to generate the LINE webhook URL.",
        },
      },
    };
  }

  private async issueLineChannelAccessToken(params: {
    channelId: string;
    channelSecret: string;
  }) {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: params.channelId,
      client_secret: params.channelSecret,
    });

    const response = await axios
      .post("https://api.line.me/v2/oauth/accessToken", body.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      })
      .catch((error) => {
        throw new ValidationError(
          "Failed to issue LINE channel access token from Channel ID + Channel secret",
          error instanceof Error ? error.message : error
        );
      });

    const accessToken = trimString(response.data?.access_token);
    if (!accessToken) {
      throw new ValidationError(
        "LINE token issuance succeeded but no access_token was returned"
      );
    }

    return accessToken;
  }

  private async validateWebsiteConnection(
    payload: ConnectionPayload
  ): Promise<ConnectionValidationResult> {
    const connectionKey =
      trimString(payload.webhookConfig.connectionKey) || randomUUID();
    const webhookUrl = this.buildWebhookUrl("website", { connectionKey });
    const externalAccountId =
      trimString(payload.externalAccountId) ||
      trimString(payload.displayName) ||
      `website-${connectionKey.slice(0, 8)}`;

    if (!webhookUrl) {
      return {
        displayName: payload.displayName?.trim() || "Website chat",
        externalAccountId,
        credentials: payload.credentials,
        webhookConfig: {
          ...payload.webhookConfig,
          connectionKey,
        },
        webhookUrl: null,
        webhookVerified: true,
        verificationState: "verified",
        status: "active",
        lastError: null,
        diagnostics: {
          webhook: {
            connectionKey,
            url: null,
            note: "Workspace public website chat is ready. Add PUBLIC_WEBHOOK_BASE_URL later if you also want an external widget webhook URL.",
          },
        },
      };
    }

    return {
      displayName: payload.displayName?.trim() || "Website chat",
      externalAccountId,
      credentials: payload.credentials,
      webhookConfig: {
        ...payload.webhookConfig,
        connectionKey,
      },
      webhookUrl,
      webhookVerified: true,
      verificationState: "verified",
      status: "active",
      lastError: null,
      diagnostics: {
        webhook: {
          connectionKey,
          url: webhookUrl,
          note: "POST website chat events to this URL with ?connectionKey=...",
        },
      },
    };
  }

  private summarizeCredentials(
    channel: CanonicalChannel,
    credentials: Record<string, unknown>
  ) {
    if (channel === "telegram") {
      return {
        botTokenConfigured: !!trimString(credentials.botToken),
        webhookSecretConfigured: !!trimString(credentials.webhookSecret),
      };
    }

    if (channel === "viber") {
      return {
        authTokenConfigured: !!trimString(credentials.authToken),
      };
    }

    if (channel === "facebook") {
      const facebookAppConfig = getFacebookAppConfig();
      return {
        pageAccessTokenConfigured: !!trimString(credentials.pageAccessToken),
        appIdConfigured: !!facebookAppConfig.appId,
        appSecretConfigured: !!facebookAppConfig.appSecret,
        webhookVerifyTokenConfigured: !!facebookAppConfig.webhookVerifyToken,
      };
    }

    if (channel === "instagram") {
      const facebookAppConfig = getFacebookAppConfig();
      return {
        instagramAccessTokenConfigured: !!trimString(credentials.instagramAccessToken),
        appIdConfigured: !!facebookAppConfig.appId,
        appSecretConfigured: !!facebookAppConfig.appSecret,
        webhookVerifyTokenConfigured: !!facebookAppConfig.webhookVerifyToken,
      };
    }

    if (channel === "tiktok") {
      const scopes = Array.isArray(credentials.scopes)
        ? credentials.scopes.map((value) => String(value))
        : [];
      return {
        accessTokenConfigured: !!trimString(credentials.accessToken),
        refreshTokenConfigured: !!trimString(credentials.refreshToken),
        businessIdConfigured:
          !!trimString(credentials.businessId) || !!trimString(credentials.creatorId),
        scopes,
      };
    }

    if (channel === "line") {
      return {
        channelIdConfigured: !!trimString(credentials.channelId),
        channelAccessTokenConfigured: !!trimString(credentials.channelAccessToken),
        channelSecretConfigured: !!trimString(credentials.channelSecret),
      };
    }

    if (channel === "website") {
      return {
        configured: true,
      };
    }

    return {
      configured: Object.keys(credentials).length > 0,
    };
  }

  private summarizeWebhookConfig(
    channel: CanonicalChannel,
    webhookConfig: Record<string, unknown>
  ) {
    if (channel === "viber") {
      return {
        connectionKeyConfigured: !!trimString(webhookConfig.connectionKey),
        connectionKey: trimString(webhookConfig.connectionKey) || undefined,
      };
    }

    if (channel === "website") {
      return {
        connectionKeyConfigured: !!trimString(webhookConfig.connectionKey),
        connectionKey: trimString(webhookConfig.connectionKey) || undefined,
      };
    }

    return {};
  }
}

export const channelConnectionService = new ChannelConnectionService();
