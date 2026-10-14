// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const fs = vi.hoisted(() => ({
  writeFile: vi.fn(async (_opts: { path: string; recursive?: boolean }) => ({ uri: "" })),
  appendFile: vi.fn(async () => undefined),
  getUri: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` })),
  readdir: vi.fn(async (): Promise<{ files: { name: string }[] }> => ({ files: [] })),
  rmdir: vi.fn(async (_opts: { path: string; recursive?: boolean }) => undefined),
}));

vi.mock("@capacitor/filesystem", () => ({
  Filesystem: fs,
  Directory: { Cache: "CACHE" },
}));

import {
  SHARE_CHUNK_BYTES,
  SHARE_FILE_TTL_MS,
  purgeOldShareFiles,
  shareFileName,
  writeShareFiles,
} from "./share-files";

beforeEach(() => {
  vi.clearAllMocks();
  fs.readdir.mockResolvedValue({ files: [] });
});

describe("shareFileName", () => {
  it("keeps a safe name with an extension", () => {
    expect(shareFileName("photo.jpg", "image/jpeg", 0)).toBe("photo.jpg");
  });

  it("adds the extension from the MIME type", () => {
    expect(shareFileName("voice", "audio/ogg; codecs=opus", 0)).toBe("voice.ogg");
  });

  it("strips path traversal from a sender-supplied name", () => {
    expect(shareFileName("../../etc/passwd.png", "image/png", 0)).not.toContain("/");
  });

  it("falls back to a numbered name", () => {
    expect(shareFileName(undefined, "video/mp4", 2)).toBe("file-3.mp4");
  });
});

describe("writeShareFiles", () => {
  it("writes a large file in chunks instead of one base64 string", async () => {
    const blob = new Blob([new Uint8Array(SHARE_CHUNK_BYTES * 2 + 10)]);
    const uris = await writeShareFiles([{ blob, name: "v.mp4", mimeType: "video/mp4" }], 1000);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.appendFile).toHaveBeenCalledTimes(2);
    expect(fs.writeFile.mock.calls[0][0]).toMatchObject({ path: "share-out/1000/v.mp4", recursive: true });
    expect(uris).toEqual(["file:///cache/share-out/1000/v.mp4"]);
  });

  it("writes an empty file once", async () => {
    await writeShareFiles([{ blob: new Blob([]), name: "e.txt", mimeType: "text/plain" }], 1);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.appendFile).not.toHaveBeenCalled();
  });

  it("keeps same-named files of one batch apart", async () => {
    const blob = new Blob(["x"]);
    const uris = await writeShareFiles([
      { blob, name: "image.jpg", mimeType: "image/jpeg" },
      { blob, name: "image.jpg", mimeType: "image/jpeg" },
    ], 7);
    expect(uris).toEqual(["file:///cache/share-out/7/image.jpg", "file:///cache/share-out/7/2-image.jpg"]);
  });
});

describe("purgeOldShareFiles", () => {
  it("deletes only batches past the TTL", async () => {
    const now = 10 * SHARE_FILE_TTL_MS;
    fs.readdir.mockResolvedValue({ files: [{ name: String(now - SHARE_FILE_TTL_MS - 1) }, { name: String(now - 5) }] });
    await purgeOldShareFiles(now);
    expect(fs.rmdir).toHaveBeenCalledTimes(1);
    expect(fs.rmdir.mock.calls[0][0]).toMatchObject({ path: `share-out/${now - SHARE_FILE_TTL_MS - 1}`, recursive: true });
  });

  it("tolerates a missing directory", async () => {
    fs.readdir.mockRejectedValue(new Error("does not exist"));
    await expect(purgeOldShareFiles()).resolves.toBeUndefined();
  });
});
