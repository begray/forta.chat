import { describe, expect, it } from "vitest";
import { BLANK_VIDEO_POSTER } from "./video-poster";

describe("BLANK_VIDEO_POSTER", () => {
  it("is a 1x1 GIF whose palette is black", () => {
    const [prefix, data] = BLANK_VIDEO_POSTER.split(",");
    expect(prefix).toBe("data:image/gif;base64");
    const bytes = Buffer.from(data, "base64");
    expect(bytes.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(bytes.readUInt16LE(6)).toBe(1);
    expect(bytes.readUInt16LE(8)).toBe(1);
    // Global color table: both entries #000000.
    expect([...bytes.subarray(13, 19)]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
