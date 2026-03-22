import { describe, expect, it } from "vitest";
import {
  shouldPlayInboundNotification,
  type MessageReceivedRealtimePayload,
} from "./inbound-notification";

describe("shouldPlayInboundNotification", () => {
  it("plays exactly once for a new inbound customer message", () => {
    const seen = new Set<string>();
    const payload: MessageReceivedRealtimePayload = {
      messageId: "msg-1",
      direction: "inbound",
      senderType: "customer",
    };

    expect(shouldPlayInboundNotification(payload, seen)).toBe(true);
    seen.add("msg-1");
    expect(shouldPlayInboundNotification(payload, seen)).toBe(false);
  });

  it("does not play for outbound agent messages", () => {
    const seen = new Set<string>();
    const payload: MessageReceivedRealtimePayload = {
      messageId: "msg-2",
      direction: "outbound",
      senderType: "agent",
    };

    expect(shouldPlayInboundNotification(payload, seen)).toBe(false);
  });

  it("does not play for automation or ai sender types", () => {
    const seen = new Set<string>();

    expect(
      shouldPlayInboundNotification(
        {
          messageId: "msg-3",
          direction: "inbound",
          senderType: "automation",
        },
        seen
      )
    ).toBe(false);

    expect(
      shouldPlayInboundNotification(
        {
          messageId: "msg-4",
          direction: "inbound",
          senderType: "ai",
        },
        seen
      )
    ).toBe(false);
  });

  it("does not play when messageId is missing", () => {
    const seen = new Set<string>();
    expect(
      shouldPlayInboundNotification(
        {
          direction: "inbound",
          senderType: "customer",
        },
        seen
      )
    ).toBe(false);
  });
});
