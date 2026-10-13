import { describe, it, expect } from "vitest";
import { videoFrame, videoOrientation } from "./video-frame";

describe("videoOrientation", () => {
  it("a ratio below 0.9 is vertical", () => {
    expect(videoOrientation(0.75)).toBe("vertical");
    expect(videoOrientation(9 / 16)).toBe("vertical");
  });

  it("0.9 and wider is horizontal", () => {
    expect(videoOrientation(0.9)).toBe("horizontal");
    expect(videoOrientation(1)).toBe("horizontal");
    expect(videoOrientation(16 / 9)).toBe("horizontal");
  });

  it("an unknown ratio counts as horizontal", () => {
    expect(videoOrientation(null)).toBe("horizontal");
    expect(videoOrientation(0)).toBe("horizontal");
    expect(videoOrientation(Number.NaN)).toBe("horizontal");
  });
});

describe("videoFrame", () => {
  it("uses the video's own ratio for the container", () => {
    expect(videoFrame(0.7497).style.aspectRatio).toBe("0.7497");
    expect(videoFrame(16 / 9).style.aspectRatio).toBe("1.7778");
  });

  it("caps a vertical container's height so it stays inside the window", () => {
    const frame = videoFrame(9 / 16);
    expect(frame.orientation).toBe("vertical");
    expect(frame.class).toContain("max-h-[70vh]");
  });

  it("a horizontal container just takes the width", () => {
    const frame = videoFrame(16 / 9);
    expect(frame.orientation).toBe("horizontal");
    expect(frame.class).not.toContain("max-h");
  });

  it("clamps extreme ratios — the rest is black bars", () => {
    expect(Number(videoFrame(5).style.aspectRatio)).toBeCloseTo(21 / 9, 3);
    expect(Number(videoFrame(0.1).style.aspectRatio)).toBeCloseTo(9 / 21, 3);
  });

  it("falls back to 16:9 when the ratio is unknown", () => {
    expect(videoFrame(null).style.aspectRatio).toBe("1.7778");
  });
});
