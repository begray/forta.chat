import { describe, it, expect } from "vitest";
import { displayMediaName, isHumanReadableMediaName, videoBodyName } from "../media-name";
import { buildVideoSendPayload } from "../video-message";
import { withVideoThumbnail } from "@/shared/lib/local-db/video-content";
import { parseFileInfo, parseVideoThumbnail } from "@/entities/chat/lib/chat-helpers";

describe("media names", () => {
  it.each([
    "bb4dde02-5e74-4fbd-95c7-ef86c1a2b3c4.mp4", // the screenshot's caption
    "in-bb4dde02-5e74-4fbd-95c7-ef86c1a2b3c4.mp4",
    "1000012345.mp4",
    "PXL_20261016_053312345.mp4",
    "PXL_20261016_053312345.TS.mp4",
    "VID_20261016_123456.mp4",
    "VID-20261016-WA0003.mp4",
    "IMG_4521.MOV",
    "video.mp4",
    "3f2a9c1e8b7d6a5f4e3d2c1b.mp4",
    "",
  ])("hides %s", (name) => {
    expect(isHumanReadableMediaName(name)).toBe(false);
    expect(videoBodyName(name)).toBe("Video");
    expect(displayMediaName(name)).toBeNull();
  });

  it.each(["Beach day.mp4", "Пляж с детьми.mp4", "birthday 2026.mov", "Video message.mp4"])("keeps %s", (name) => {
    expect(isHumanReadableMediaName(name)).toBe(true);
    expect(videoBodyName(name)).toBe(name);
    expect(displayMediaName(name)).toBe(name);
  });

  it("does not show the generic name a 'Video' body comes back as", () => {
    expect(displayMediaName("Video.mp4")).toBeNull();
  });
});

describe("buildVideoSendPayload", () => {
  it("sends m.video with size, dimensions and duration, and a clean body", () => {
    const p = buildVideoSendPayload(
      { name: "bb4dde02-5e74-4fbd-95c7-ef86c1a2b3c4.mp4", size: 18_874_368.4 },
      "video/mp4",
      { w: 720, h: 1280, durationMs: 41_960.2 },
    );
    expect(p).toEqual({
      msgtype: "m.video",
      body: "Video",
      eventInfo: { mimetype: "video/mp4", size: 18_874_368, w: 720, h: 1280, duration: 41_960 },
    });
  });

  it("leaves unknown facts out instead of sending zeros", () => {
    const p = buildVideoSendPayload({ name: "Beach day.mp4", size: 5 }, "video/mp4", { w: 0, h: 1280, durationMs: NaN });
    expect(p.body).toBe("Beach day.mp4");
    expect(p.eventInfo).toEqual({ mimetype: "video/mp4", size: 5 });
  });
});

describe("m.video thumbnail fields", () => {
  const thumb = { url: "mxc://server/thumb", info: { w: 270, h: 480, mimetype: "image/jpeg", size: 31_000 } };
  const base = { mimetype: "video/mp4", size: 1, w: 720, h: 1280, duration: 42_000 };

  it("encrypted room: thumbnail_file with the Bastyon secrets, never a bare thumbnail_url", () => {
    const secrets = { keys: "k", block: 10, v: 2 };
    const info = withVideoThumbnail(base, { ...thumb, secrets });
    expect(info).toEqual({
      ...base,
      thumbnail_file: { url: "mxc://server/thumb", secrets, mimetype: "image/jpeg" },
      thumbnail_info: thumb.info,
    });
    expect(info).not.toHaveProperty("thumbnail_url");
  });

  it("plain room: thumbnail_url + thumbnail_info", () => {
    expect(withVideoThumbnail(base, thumb)).toEqual({ ...base, thumbnail_url: "mxc://server/thumb", thumbnail_info: thumb.info });
  });

  it("no thumbnail (its upload failed): info unchanged", () => {
    expect(withVideoThumbnail(base, null)).toEqual(base);
  });

  it("the receiver reads back what the sender wrote: poster, duration, size, caption", () => {
    const secrets = { keys: "k", block: 10, v: 2 };
    const content = {
      msgtype: "m.video",
      body: "Video",
      url: "mxc://server/video",
      info: { ...withVideoThumbnail(base, { ...thumb, secrets }), secrets, caption: "Beach!" },
    };
    const fi = parseFileInfo(content, "m.video")!;
    expect(fi).toMatchObject({
      name: "Video.mp4",
      url: "mxc://server/video",
      w: 720,
      h: 1280,
      duration: 42,
      caption: "Beach!",
      thumbnail: { url: "mxc://server/thumb", secrets: { keys: "k", block: 10, v: 2 }, w: 270, h: 480, mimetype: "image/jpeg" },
    });
    expect(fi.videoNote).toBeUndefined();
  });

  it("skips a Matrix AES thumbnail_file it cannot decrypt, keeps a plain thumbnail_url", () => {
    expect(parseVideoThumbnail({ thumbnail_file: { url: "mxc://x/t", key: { k: "jwk" }, iv: "iv", hashes: {} } })).toBeUndefined();
    expect(parseVideoThumbnail({ thumbnail_url: "mxc://x/t", thumbnail_info: { w: 10, h: 20 } })).toEqual({ url: "mxc://x/t", w: 10, h: 20, mimetype: undefined });
    expect(parseVideoThumbnail(undefined)).toBeUndefined();
  });
});
