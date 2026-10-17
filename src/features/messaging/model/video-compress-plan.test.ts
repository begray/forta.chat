import { describe, it, expect } from "vitest";
import {
  AUDIO_BITRATE,
  COMPRESS_THRESHOLD_BYTES,
  SIZE_MARGIN,
  budgetVideoBitrate,
  maxDurationMs,
  planVideoCompression,
  retryBitrate,
  shouldCompressVideo,
} from "./video-compress-plan";

const MiB = 1024 * 1024;
const LIMIT = 50 * MiB;

/** Bytes a plan produces for `durationMs`, before the container. */
const outputBytes = (videoBitrate: number, durationMs: number) =>
  ((videoBitrate + AUDIO_BITRATE) / 8) * (durationMs / 1000);

describe("shouldCompressVideo", () => {
  it("leaves small videos and non-videos alone", () => {
    expect(shouldCompressVideo({ size: 10 * MiB, type: "video/mp4" }, LIMIT)).toBe(false);
    expect(shouldCompressVideo({ size: 80 * MiB, type: "image/jpeg" }, LIMIT)).toBe(false);
    expect(shouldCompressVideo({ size: 80 * MiB }, LIMIT)).toBe(false);
  });

  it("compresses videos over the data-saving threshold even when they fit", () => {
    expect(shouldCompressVideo({ size: COMPRESS_THRESHOLD_BYTES + 1, type: "video/mp4" }, LIMIT)).toBe(true);
  });

  it("compresses anything over a limit lower than the threshold", () => {
    expect(shouldCompressVideo({ size: 12 * MiB, type: "video/quicktime" }, 10 * MiB)).toBe(true);
  });
});

describe("planVideoCompression", () => {
  it("gives a 30 s clip 720p at the quality ceiling", () => {
    const r = planVideoCompression(30_000, LIMIT);
    expect(r).toEqual({ ok: true, plan: { shortSide: 720, videoBitrate: 2_500_000, audioBitrate: AUDIO_BITRATE } });
  });

  it("sizes a 3 min clip to fit the limit with the margin", () => {
    const r = planVideoCompression(180_000, LIMIT);
    if (!r.ok) throw new Error("expected a plan");
    expect(r.plan.shortSide).toBe(720);
    expect(r.plan.videoBitrate).toBeLessThan(2_500_000);
    expect(outputBytes(r.plan.videoBitrate, 180_000)).toBeLessThanOrEqual(LIMIT * (1 - SIZE_MARGIN) + 1);
  });

  it("drops to 480p when 720p would be starved", () => {
    const r = planVideoCompression(7 * 60_000, LIMIT);
    if (!r.ok) throw new Error("expected a plan");
    expect(r.plan.shortSide).toBe(480);
    expect(outputBytes(r.plan.videoBitrate, 7 * 60_000)).toBeLessThanOrEqual(LIMIT * (1 - SIZE_MARGIN) + 1);
  });

  it("refuses a video that cannot fit, with the longest one that can", () => {
    const r = planVideoCompression(20 * 60_000, LIMIT);
    expect(r).toEqual({ ok: false, reason: "too_long", maxDurationMs: maxDurationMs(LIMIT) });
    if (r.ok) return;
    expect(r.reason === "too_long" && r.maxDurationMs).toBeGreaterThan(9 * 60_000);
    expect(planVideoCompression(maxDurationMs(LIMIT) - 1000, LIMIT).ok).toBe(true);
  });

  it("refuses an unknown duration", () => {
    expect(planVideoCompression(0, LIMIT)).toEqual({ ok: false, reason: "unknown_duration" });
    expect(planVideoCompression(Number.NaN, LIMIT)).toEqual({ ok: false, reason: "unknown_duration" });
  });

  it("never asks for more than the source bitrate (but not below the step minimum)", () => {
    const low = planVideoCompression(30_000, LIMIT, 1_600_000);
    expect(low.ok && low.plan.videoBitrate).toBe(1_600_000 - AUDIO_BITRATE);
    const tiny = planVideoCompression(30_000, LIMIT, 500_000);
    expect(tiny.ok && tiny.plan.videoBitrate).toBe(1_000_000);
  });

  it("matches the budget formula", () => {
    expect(budgetVideoBitrate(100_000, LIMIT)).toBeCloseTo((LIMIT * 8 * 0.9) / 100 - AUDIO_BITRATE);
  });
});

describe("retryBitrate", () => {
  it("scales down by the overshoot and 10 % more", () => {
    expect(retryBitrate(2_000_000, 60 * MiB, LIMIT)).toBe(Math.floor(2_000_000 * (50 / 60) * 0.9));
  });

  it("gives up below the lowest step's minimum", () => {
    expect(retryBitrate(500_000, 100 * MiB, LIMIT)).toBeNull();
  });
});
