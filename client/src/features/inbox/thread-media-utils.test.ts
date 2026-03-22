import { describe, expect, it, vi } from "vitest";
import { resolveRenderableMedia } from "./thread-media-utils";
import { Message } from "../../types/models";

const buildMessage = (media: NonNullable<Message["media"]>): Message => ({
  _id: "m1",
  conversationId: "c1",
  channel: "viber",
  direction: "inbound",
  senderType: "customer",
  kind: "image",
  media,
  status: "received",
  createdAt: new Date("2026-03-10T10:00:00.000Z").toISOString(),
});

describe("resolveRenderableMedia", () => {
  it("returns expired state when provider media is temporary and expired without stored asset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T12:00:00.000Z"));

    const result = resolveRenderableMedia(
      buildMessage([
        {
          url: "https://provider.example/temporary.jpg",
          isTemporary: true,
          expiresAt: "2026-03-18T11:59:00.000Z",
          expirySource: "provider_ttl",
        },
      ])
    );

    expect(result.isExpired).toBe(true);
    expect(result.preferredUrl).toBeNull();
    vi.useRealTimers();
  });

  it("prefers storedAssetUrl over expired provider url", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T12:00:00.000Z"));

    const result = resolveRenderableMedia(
      buildMessage([
        {
          url: "https://provider.example/temporary.jpg",
          storedAssetUrl: "https://our-assets.example/asset.jpg",
          storedAssetId: "asset-1",
          isTemporary: true,
          expiresAt: "2026-03-18T11:00:00.000Z",
          expirySource: "provider_ttl",
        },
      ])
    );

    expect(result.isExpired).toBe(true);
    expect(result.preferredUrl).toBe("https://our-assets.example/asset.jpg");
    vi.useRealTimers();
  });

  it("resolves relative API media urls for thread rendering", () => {
    const result = resolveRenderableMedia(
      buildMessage([
        {
          url: "/api/sticker-previews/test-token",
        },
      ])
    );

    expect(result.preferredUrl).toBe("http://localhost:4000/api/sticker-previews/test-token");
  });
});
