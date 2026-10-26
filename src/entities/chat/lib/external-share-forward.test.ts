import { describe, it, expect } from "vitest";
import { buildExternalShareForward } from "./external-share-forward";
import { MessageType } from "../model/types";

const png = (name: string) => ({ uri: `/c/${name}`, name, mimeType: "image/png" });

describe("buildExternalShareForward", () => {
  it("builds a text forward for a text-only share", () => {
    const fwd = buildExternalShareForward({ text: "https://example.com" }, 1);

    expect(fwd).toMatchObject({
      id: "__external_share_1",
      roomId: "__external_share__",
      content: "https://example.com",
      type: MessageType.text,
      isExternalShare: true,
      withSenderInfo: false,
    });
    expect(fwd.fileInfo).toBeUndefined();
    expect(fwd.externalFiles).toBeUndefined();
  });

  it("maps a single screenshot to an image forward", () => {
    const fwd = buildExternalShareForward({ files: [png("Screenshot.png")] });

    expect(fwd.type).toBe(MessageType.image);
    expect(fwd.content).toBe("Screenshot.png");
    expect(fwd.fileInfo).toEqual({ url: "/c/Screenshot.png", name: "Screenshot.png", type: "image/png", size: 0 });
    expect(fwd.externalFiles).toHaveLength(1);
  });

  it("maps a single video to a video forward", () => {
    const fwd = buildExternalShareForward({ files: [{ uri: "/c/v.mp4", name: "v.mp4", mimeType: "video/mp4" }] });
    expect(fwd.type).toBe(MessageType.video);
  });

  it("keeps every file of a multi-image share", () => {
    const fwd = buildExternalShareForward({ files: [png("a.png"), png("b.png"), png("c.png")] });

    expect(fwd.type).toBe(MessageType.image);
    expect(fwd.externalFiles?.map((f) => f.name)).toEqual(["a.png", "b.png", "c.png"]);
    expect(fwd.fileInfo?.name).toBe("a.png");
  });

  it("treats a mixed multi-file share as files", () => {
    const fwd = buildExternalShareForward({
      files: [png("a.png"), { uri: "/c/doc.pdf", name: "doc.pdf", mimeType: "application/pdf" }],
    });
    expect(fwd.type).toBe(MessageType.file);
  });

  it("carries the share's key, so one share is sent once", () => {
    const fwd = buildExternalShareForward({ files: [png("a.png")], key: "k1" });
    expect(fwd.shareKey).toBe("k1");
    expect(buildExternalShareForward({ files: [png("a.png")] }).shareKey).toBeUndefined();
  });

  it("fills defaults for a nameless / typeless file", () => {
    const fwd = buildExternalShareForward({ files: [{ uri: "/c/x", name: "", mimeType: "" }] });
    expect(fwd.fileInfo).toMatchObject({ name: "shared_file", type: "application/octet-stream" });
    expect(fwd.type).toBe(MessageType.file);
  });
});
