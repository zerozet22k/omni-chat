import { describe, expect, it } from "vitest";
import { normalizeBullMqJobId, normalizeBullMqJobOptions } from "../lib/bullmq-job-id";

describe("BullMQ job ID normalization", () => {
  it("keeps safe IDs readable", () => {
    expect(normalizeBullMqJobId("65ff10f0a7b4f2b62df1f111")).toBe("65ff10f0a7b4f2b62df1f111");
  });

  it("encodes provider-style IDs that contain colons", () => {
    expect(normalizeBullMqJobId("telegram:237740550")).toBe("telegram%3A237740550");
    expect(normalizeBullMqJobId("line:webhook:message:123")).toBe(
      "line%3Awebhook%3Amessage%3A123"
    );
  });

  it("normalizes job options without dropping other BullMQ fields", () => {
    expect(
      normalizeBullMqJobOptions({
        jobId: "stripe:evt_123",
        attempts: 5,
      })
    ).toEqual({
      jobId: "stripe%3Aevt_123",
      attempts: 5,
    });
  });

  it("leaves options untouched when no custom job ID is present", () => {
    expect(normalizeBullMqJobOptions({ attempts: 2 })).toEqual({ attempts: 2 });
    expect(normalizeBullMqJobOptions()).toBeUndefined();
  });
});
