import { createHmac, timingSafeEqual } from "crypto";
import { promises as fs } from "fs";
import axios, { AxiosResponse } from "axios";
import { Response } from "express";
import { CanonicalMedia, CanonicalMessage, ChannelConnectionStatus, ChannelConnectionVerificationState, SendOutboundResult } from "../channels/types";
import { env } from "../config/env";
import { ValidationError } from "../lib/errors";
import { ChannelConnectionModel, ConversationModel, MediaAssetModel, MessageModel } from "../models";
import { tiktokMediaTokenService } from "./tiktok-media-token.service";

type TikTokApiEnvelope<T> = {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
};

export type TikTokMessageMediaType = "IMAGE" | "VIDEO";

export type NormalizedTikTokConnectionCredentials = {
  accessToken: string;
  refreshToken: string | null;
  businessId: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
};

type TikTokTokenInfo = {
  creator_id?: string;
  scope?: string;
};

type TikTokRefreshTokenData = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  open_id?: string;
  scope?: string;
};

type TikTokSendMessageData = {
  message?: {
    message_id?: string;
  };
};

type TikTokWebhookUpdateData = {
  app_id?: string;
  callback_url?: string;
  event_type?: string;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const toDateOrNull = (value: unknown) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const normalizeScopes = (value: unknown) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const toStoredCredentials = (
  credentials: NormalizedTikTokConnectionCredentials
): Record<string, unknown> => ({
  accessToken: credentials.accessToken,
  ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
  ...(credentials.businessId ? { businessId: credentials.businessId } : {}),
  accessTokenExpiresAt: credentials.accessTokenExpiresAt,
  refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
  scopes: credentials.scopes,
});

const isNearExpiry = (date: Date | null, skewSeconds = 60) => {
  if (!date) {
    return false;
  }

  return date.getTime() <= Date.now() + skewSeconds * 1000;
};

const inferImageMimeType = (filename: string, fallbackMimeType?: string) => {
  const normalizedFilename = filename.toLowerCase();
  const normalizedMimeType = String(fallbackMimeType ?? "").toLowerCase();

  if (normalizedFilename.endsWith(".png") || normalizedMimeType === "image/png") {
    return "image/png";
  }

  return "image/jpeg";
};

const extractTikTokApiMessage = (value: unknown, fallback: string) => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    if ("message" in value && typeof value.message === "string" && value.message.trim()) {
      return value.message;
    }
    if ("msg" in value && typeof value.msg === "string" && value.msg.trim()) {
      return value.msg;
    }
  }

  return fallback;
};

class TikTokBusinessMessagingService {
  readonly channel = "tiktok" as const;

  normalizeConnectionCredentials(
    credentials: Record<string, unknown>,
    fallbackBusinessId?: string | null
  ): NormalizedTikTokConnectionCredentials {
    return {
      accessToken: trimString(credentials.accessToken),
      refreshToken: trimString(credentials.refreshToken) || null,
      businessId:
        trimString(credentials.businessId) || trimString(fallbackBusinessId) || null,
      accessTokenExpiresAt: toDateOrNull(credentials.accessTokenExpiresAt),
      refreshTokenExpiresAt: toDateOrNull(credentials.refreshTokenExpiresAt),
      scopes: Array.isArray(credentials.scopes)
        ? credentials.scopes.map((value) => String(value).trim()).filter(Boolean)
        : normalizeScopes(credentials.scope),
    };
  }

  serializeCredentials(credentials: NormalizedTikTokConnectionCredentials) {
    return toStoredCredentials(credentials);
  }

  async validateConnection(params: {
    displayName?: string;
    externalAccountId?: string;
    credentials: Record<string, unknown>;
    webhookUrl: string | null;
  }): Promise<{
    displayName: string;
    externalAccountId: string;
    credentials: Record<string, unknown>;
    webhookUrl: string | null;
    webhookVerified: boolean;
    verificationState: ChannelConnectionVerificationState;
    status: ChannelConnectionStatus;
    lastError: string | null;
    diagnostics: Record<string, unknown>;
  }> {
    this.getAppConfigOrThrow();

    let resolvedCredentials = this.normalizeConnectionCredentials(
      params.credentials,
      params.externalAccountId
    );
    if (!resolvedCredentials.accessToken && !resolvedCredentials.refreshToken) {
      throw new ValidationError(
        "TikTok business access token is required. Provide accessToken and preferably refreshToken."
      );
    }

    resolvedCredentials = await this.ensureValidConnectionCredentials(
      resolvedCredentials
    );

    const businessId =
      resolvedCredentials.businessId || trimString(params.externalAccountId);
    if (!businessId) {
      throw new ValidationError(
        "TikTok business account identifier is missing. Provide credentials.businessId or a token that resolves to a creator_id."
      );
    }

    const hasSendScope = resolvedCredentials.scopes.includes("message.list.send");
    const hasReadScope =
      resolvedCredentials.scopes.includes("message.list.read") ||
      resolvedCredentials.scopes.includes("message.list.manage");

    if (!hasSendScope || !hasReadScope) {
      throw new ValidationError(
        "TikTok access token is missing required Business Messaging scopes. Expected message.list.send plus message.list.read or message.list.manage."
      );
    }

    if (!params.webhookUrl) {
      return {
        displayName: params.displayName?.trim() || "TikTok Business Account",
        externalAccountId: businessId,
        credentials: toStoredCredentials({
          ...resolvedCredentials,
          businessId,
        }),
        webhookUrl: null,
        webhookVerified: false,
        verificationState: "pending",
        status: "pending",
        lastError:
          "PUBLIC_WEBHOOK_BASE_URL is required before TikTok webhook registration can complete.",
        diagnostics: {
          provider: {
            businessId,
            scopes: resolvedCredentials.scopes,
          },
        },
      };
    }

    try {
      const webhook = await this.registerWebhook(params.webhookUrl);
      return {
        displayName: params.displayName?.trim() || "TikTok Business Account",
        externalAccountId: businessId,
        credentials: toStoredCredentials({
          ...resolvedCredentials,
          businessId,
        }),
        webhookUrl: webhook.callbackUrl ?? params.webhookUrl,
        webhookVerified: true,
        verificationState: "verified",
        status: "active",
        lastError: null,
        diagnostics: {
          provider: {
            businessId,
            scopes: resolvedCredentials.scopes,
          },
          webhook,
        },
      };
    } catch (error) {
      return {
        displayName: params.displayName?.trim() || "TikTok Business Account",
        externalAccountId: businessId,
        credentials: toStoredCredentials({
          ...resolvedCredentials,
          businessId,
        }),
        webhookUrl: params.webhookUrl,
        webhookVerified: false,
        verificationState: "failed",
        status: "error",
        lastError:
          error instanceof Error
            ? error.message
            : "TikTok webhook registration failed",
        diagnostics: {
          provider: {
            businessId,
            scopes: resolvedCredentials.scopes,
          },
        },
      };
    }
  }

  verifyWebhookSignature(params: {
    rawBody?: string;
    signatureHeader?: string;
  }) {
    const rawBody = params.rawBody;
    const signatureHeader = trimString(params.signatureHeader);
    const appSecret = this.getAppSecret();

    if (!rawBody || !signatureHeader || !appSecret) {
      return false;
    }

    const parts = signatureHeader
      .split(",")
      .map((item) => item.trim())
      .reduce<Record<string, string>>((acc, item) => {
        const [key, ...valueParts] = item.split("=");
        if (key && valueParts.length > 0) {
          acc[key.trim().toLowerCase()] = valueParts.join("=").trim();
        }
        return acc;
      }, {});

    const timestamp = parts.t;
    const providedSignature = parts.s;
    if (!timestamp || !providedSignature) {
      return false;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const receivedSeconds = Number(timestamp);
    if (!Number.isFinite(receivedSeconds)) {
      return false;
    }

    if (Math.abs(nowSeconds - receivedSeconds) > env.TIKTOK_WEBHOOK_MAX_AGE_SECONDS) {
      return false;
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const computedSignature = createHmac("sha256", appSecret)
      .update(signedPayload)
      .digest("hex");

    const computedBuffer = Buffer.from(computedSignature);
    const providedBuffer = Buffer.from(providedSignature);
    if (computedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(computedBuffer, providedBuffer);
  }

  async ensureValidConnectionCredentials(
    credentials: NormalizedTikTokConnectionCredentials
  ) {
    this.getAppConfigOrThrow();

    let current = { ...credentials };
    if (!current.accessToken && !current.refreshToken) {
      throw new ValidationError("TikTok accessToken or refreshToken is required");
    }

    if (!current.accessToken || (current.refreshToken && isNearExpiry(current.accessTokenExpiresAt))) {
      current = await this.refreshConnectionCredentials(current);
    }

    try {
      const tokenInfo = await this.getTokenInfo(current.accessToken);
      return {
        ...current,
        businessId: current.businessId || trimString(tokenInfo.creator_id) || null,
        scopes:
          current.scopes.length > 0 ? current.scopes : normalizeScopes(tokenInfo.scope),
      };
    } catch (error) {
      if (!current.refreshToken) {
        throw new ValidationError(
          error instanceof Error
            ? `TikTok access token validation failed: ${error.message}`
            : "TikTok access token validation failed"
        );
      }

      const refreshed = await this.refreshConnectionCredentials(current);
      const tokenInfo = await this.getTokenInfo(refreshed.accessToken);
      return {
        ...refreshed,
        businessId: refreshed.businessId || trimString(tokenInfo.creator_id) || null,
        scopes:
          refreshed.scopes.length > 0
            ? refreshed.scopes
            : normalizeScopes(tokenInfo.scope),
      };
    }
  }

  async sendOutbound(params: {
    externalChatId: string;
    message: CanonicalMessage;
    credentials: Record<string, unknown>;
  }): Promise<SendOutboundResult> {
    const connectionCredentials = this.normalizeConnectionCredentials(params.credentials);
    if (!connectionCredentials.accessToken) {
      return {
        status: "failed",
        error: "TikTok business access token is missing",
      };
    }

    const businessId = connectionCredentials.businessId;
    if (!businessId) {
      return {
        status: "failed",
        error: "TikTok business account identifier is missing",
      };
    }

    let request: Record<string, unknown>;
    if (params.message.kind === "text") {
      request = {
        business_id: businessId,
        recipient_type: "CONVERSATION",
        recipient: params.externalChatId,
        message_type: "TEXT",
        text: {
          body: params.message.text?.body ?? "",
        },
      };
    } else if (params.message.kind === "image") {
      if (params.message.text?.body?.trim()) {
        return {
          status: "failed",
          error:
            "TikTok Business Messaging does not support text and image in the same message. Send them as separate messages.",
        };
      }

      const mediaId = await this.uploadImageForMessage({
        businessId,
        accessToken: connectionCredentials.accessToken,
        media: params.message.media?.[0],
      });

      request = {
        business_id: businessId,
        recipient_type: "CONVERSATION",
        recipient: params.externalChatId,
        message_type: "IMAGE",
        image: {
          media_id: mediaId,
        },
      };
    } else {
      return {
        status: "failed",
        error: `TikTok Business Messaging does not support outbound kind ${params.message.kind}`,
      };
    }

    try {
      const response = await this.postJson<TikTokSendMessageData>(
        "/open_api/v1.3/business/message/send/",
        request,
        {
          headers: {
            "Access-Token": connectionCredentials.accessToken,
          },
        }
      );

      return {
        externalMessageId: trimString(response.message?.message_id) || undefined,
        status: "sent",
        raw: response,
        request,
      };
    } catch (error) {
      return this.buildFailedSendResult(error, request);
    }
  }

  createSignedMediaUrl(params: {
    conversationId: string;
    messageId: string;
    mediaId: string;
    mediaType: TikTokMessageMediaType;
  }) {
    const token = tiktokMediaTokenService.sign(params);
    return `/api/tiktok-media/${encodeURIComponent(token)}`;
  }

  async streamMediaFromToken(token: string, res: Response) {
    const payload = tiktokMediaTokenService.verify(token);
    if (!payload) {
      return false;
    }

    const [conversation, message] = await Promise.all([
      ConversationModel.findById(payload.conversationId).lean(),
      MessageModel.findById(payload.messageId).lean(),
    ]);

    if (
      !conversation ||
      conversation.channel !== "tiktok" ||
      !message ||
      String(message.conversationId) !== payload.conversationId
    ) {
      return false;
    }

    const providerFileId = Array.isArray(message.media)
      ? message.media.find((item) => item?.providerFileId === payload.mediaId)?.providerFileId
      : null;
    if (!providerFileId) {
      return false;
    }

    const connection = await ChannelConnectionModel.findOne({
      workspaceId: conversation.workspaceId,
      channel: "tiktok",
      externalAccountId: conversation.channelAccountId,
    });
    if (!connection) {
      return false;
    }

    const credentials = await this.ensureValidConnectionCredentials(
      this.normalizeConnectionCredentials(
        (connection.credentials ?? {}) as Record<string, unknown>,
        conversation.channelAccountId
      )
    );

    connection.credentials = toStoredCredentials(credentials);
    await connection.save();

    const businessId = credentials.businessId || conversation.channelAccountId;
    const download = await this.postJson<{ download_url?: string }>(
      "/open_api/v1.3/business/message/media/download/",
      {
        business_id: businessId,
        conversation_id: conversation.externalChatId,
        message_id: payload.messageId === String(message.externalMessageId)
          ? payload.messageId
          : String(message.externalMessageId ?? payload.messageId),
        media_id: payload.mediaId,
        media_type: payload.mediaType,
      },
      {
        headers: {
          "Access-Token": credentials.accessToken,
        },
      }
    );

    const downloadUrl = trimString(download.download_url);
    if (!downloadUrl) {
      return false;
    }

    const upstream = await axios.get(downloadUrl, {
      responseType: "stream",
      timeout: 15000,
      headers: {
        "x-user": credentials.accessToken,
      },
    });

    res.setHeader(
      "Content-Type",
      upstream.headers["content-type"] ??
        (payload.mediaType === "VIDEO" ? "video/mp4" : "image/jpeg")
    );
    res.setHeader("Cache-Control", "private, max-age=300");

    await new Promise<void>((resolve, reject) => {
      upstream.data.on("error", reject);
      res.on("finish", resolve);
      res.on("close", resolve);
      upstream.data.pipe(res);
    });

    return true;
  }

  private async uploadImageForMessage(params: {
    businessId: string;
    accessToken: string;
    media?: CanonicalMedia;
  }) {
    const media = params.media;
    if (!media) {
      throw new ValidationError("TikTok image outbound requires media[0]");
    }

    const fileBuffer = await this.resolveUploadBuffer(media);
    const fileName = trimString(media.filename) || "image.jpg";
    const mimeType = inferImageMimeType(fileName, media.mimeType);
    const size = fileBuffer.byteLength;

    if (size > 3 * 1024 * 1024) {
      throw new ValidationError("TikTok image outbound exceeds the 3 MB limit");
    }

    if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
      throw new ValidationError("TikTok image outbound only supports JPG and PNG files");
    }

    const form = new FormData();
    form.set("business_id", params.businessId);
    form.set("media_type", "IMAGE");
    form.set("file", new Blob([fileBuffer], { type: mimeType }), fileName);

    const response = await fetch(
      `${this.getApiBaseUrl()}/open_api/v1.3/business/message/media/upload/`,
      {
        method: "POST",
        headers: {
          "Access-Token": params.accessToken,
        },
        body: form,
      }
    );

    const data = (await response.json()) as TikTokApiEnvelope<{ media_id?: string }>;
    if (!response.ok || data.code !== 0 || !trimString(data.data?.media_id)) {
      throw new ValidationError(
        extractTikTokApiMessage(data, "TikTok media upload failed")
      );
    }

    return trimString(data.data?.media_id);
  }

  private async resolveUploadBuffer(media: CanonicalMedia) {
    const storedAssetId = trimString(media.storedAssetId);
    if (storedAssetId) {
      const asset = await MediaAssetModel.findById(storedAssetId).lean();
      if (asset?.storagePath) {
        return fs.readFile(asset.storagePath);
      }
    }

    const sourceUrl = trimString(media.storedAssetUrl) || trimString(media.url);
    if (!sourceUrl) {
      throw new ValidationError(
        "TikTok image outbound requires media[0].storedAssetId, media[0].storedAssetUrl, or media[0].url"
      );
    }

    const response = await axios.get<ArrayBuffer>(sourceUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    return Buffer.from(response.data);
  }

  private async refreshConnectionCredentials(
    credentials: NormalizedTikTokConnectionCredentials
  ) {
    if (!credentials.refreshToken) {
      throw new ValidationError("TikTok refresh token is required to renew the access token");
    }

    const config = this.getAppConfigOrThrow();
    const data = await this.postJson<TikTokRefreshTokenData>(
      "/open_api/v1.3/tt_user/oauth2/refresh_token/",
      {
        client_id: config.appId,
        client_secret: config.appSecret,
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
      }
    );

    const accessToken = trimString(data.access_token);
    if (!accessToken) {
      throw new ValidationError("TikTok refresh_token response did not return access_token");
    }

    return {
      accessToken,
      refreshToken: trimString(data.refresh_token) || credentials.refreshToken,
      businessId: trimString(data.open_id) || credentials.businessId,
      accessTokenExpiresAt:
        typeof data.expires_in === "number"
          ? new Date(Date.now() + data.expires_in * 1000)
          : credentials.accessTokenExpiresAt,
      refreshTokenExpiresAt:
        typeof data.refresh_token_expires_in === "number"
          ? new Date(Date.now() + data.refresh_token_expires_in * 1000)
          : credentials.refreshTokenExpiresAt,
      scopes: normalizeScopes(data.scope),
    } satisfies NormalizedTikTokConnectionCredentials;
  }

  private async getTokenInfo(accessToken: string) {
    const config = this.getAppConfigOrThrow();
    return this.postJson<TikTokTokenInfo>("/open_api/v1.3/tt_user/token_info/get/", {
      app_id: config.appId,
      access_token: accessToken,
    });
  }

  private async registerWebhook(callbackUrl: string) {
    const config = this.getAppConfigOrThrow();
    const data = await this.postJson<TikTokWebhookUpdateData>(
      "/open_api/v1.3/business/webhook/update/",
      {
        app_id: config.appId,
        secret: config.appSecret,
        event_type: "DIRECT_MESSAGE",
        callback_url: callbackUrl,
      }
    );

    return {
      callbackUrl: trimString(data.callback_url) || callbackUrl,
      eventType: trimString(data.event_type) || "DIRECT_MESSAGE",
      appId: trimString(data.app_id) || config.appId,
    };
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    options?: {
      headers?: Record<string, string>;
    }
  ) {
    const response = await axios.post<
      TikTokApiEnvelope<T>,
      AxiosResponse<TikTokApiEnvelope<T>>
    >(`${this.getApiBaseUrl()}${path}`, body, {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
    });

    if (response.data?.code !== 0) {
      throw new ValidationError(
        extractTikTokApiMessage(response.data, "TikTok API request failed")
      );
    }

    return (response.data?.data ?? {}) as T;
  }

  private getApiBaseUrl() {
    return env.TIKTOK_BUSINESS_API_BASE_URL.trim().replace(/\/+$/, "");
  }

  private getAppConfigOrThrow() {
    const appId = trimString(env.TIKTOK_APP_ID);
    const appSecret = trimString(env.TIKTOK_APP_SECRET);
    if (!appId || !appSecret) {
      throw new ValidationError(
        "TikTok Business Messaging is not configured on the server. Set TIKTOK_APP_ID and TIKTOK_APP_SECRET."
      );
    }

    return {
      appId,
      appSecret,
    };
  }

  private getAppSecret() {
    return trimString(env.TIKTOK_APP_SECRET);
  }

  private buildFailedSendResult(error: unknown, request: unknown): SendOutboundResult {
    if (axios.isAxiosError(error)) {
      return {
        status: "failed",
        error: extractTikTokApiMessage(
          error.response?.data,
          error.message || "TikTok API request failed"
        ),
        raw: error.response?.data ?? null,
        request,
      };
    }

    return {
      status: "failed",
      error: error instanceof Error ? error.message : "TikTok API request failed",
      request,
    };
  }
}

export const tiktokBusinessMessagingService = new TikTokBusinessMessagingService();
