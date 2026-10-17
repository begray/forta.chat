// @vitest-environment happy-dom
/**
 * Native picks (picked-media.ts): the File objects the composer gets, how
 * their bytes are read, what is released (and nothing else), and how the
 * compressor uses their source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => ({}) }));

import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";
import { resetUploadLimitForTests } from "@/shared/lib/file-transfer/upload-limit";
import type { NativePickResult } from "@/shared/lib/media-picker/media-picker-plugin";
import type { CompressVideoOptions, CompressVideoResult } from "@/shared/lib/video-compress/video-compress-plugin";
import {
  fileSourceOf,
  pickMediaNatively,
  releaseFileSource,
  setPickedMediaDepsForTests,
  type PickedMediaDeps,
} from "../picked-media";
import { readPickedFile } from "../read-picked-file";
import { useMediaUpload } from "../use-media-upload";
import { prepareVideoForSend, setVideoCompressionDepsForTests, type VideoCompressionDeps } from "../video-compression";

const MiB = 1024 * 1024;

const PICK: NativePickResult = {
  cancelled: false,
  ms: 640,
  authority: "media",
  items: [
    { index: 0, name: "PXL_1.jpg", mime: "image/jpeg", size: 4_716_270, kind: "image", copied: true, uri: "file:///data/files/picked/b1/0-PXL_1.jpg", path: "/data/files/picked/b1/0-PXL_1.jpg" },
    { index: 1, name: "PXL_2.mp4", mime: "video/mp4", size: 92_782_267, kind: "video", copied: false, uri: "content://media/picker/0/v/2", durationMs: 37_098, width: 1080, height: 1920, thumbUri: "file:///cache/picked-thumbs/b1-1.jpg" },
    { index: 2, name: "PXL_3.mp4", mime: "video/mp4", size: 4_962_243, kind: "video", copied: true, uri: "file:///data/files/picked/b1/2-PXL_3.mp4", path: "/data/files/picked/b1/2-PXL_3.mp4", thumbUri: "file:///cache/picked-thumbs/b1-2.jpg" },
    { index: 3, name: "cloud.mp4", mime: "video/mp4", size: -1, kind: "video", copied: false, error: "FileNotFoundException: gone" },
  ],
};

function makeDeps(result: NativePickResult = PICK) {
  const released: { paths: string[]; uris: string[] }[] = [];
  const fetched: string[] = [];
  const deps: PickedMediaDeps = {
    available: () => true,
    pick: vi.fn(async () => result),
    release: vi.fn(async (paths, uris) => { released.push({ paths, uris }); }),
    sweep: vi.fn(async () => {}),
    onProgress: async () => () => {},
    webUrl: (uri) => `https://localhost/_capacitor_file_${uri.replace(/^\w+:\/\//, "/")}`,
    fetchBlob: async (url) => {
      fetched.push(url);
      return new Blob(["bytes"], { type: "application/octet-stream" });
    },
    now: () => 1_000,
  };
  return { deps, released, fetched };
}

/** Compressor platform calls; nothing reaches a device. */
function compressDeps(over: Partial<VideoCompressionDeps> = {}): VideoCompressionDeps {
  return {
    available: () => true,
    uploadLimit: async () => 50 * MiB,
    probe: async () => ({ durationMs: 60_000, width: 1080, height: 1920, rotation: 0, bitrate: 17_000_000 }),
    compress: async (o) => ({ path: `/cache/video-compress/out-${o.id}.mp4`, uri: `file:///cache/video-compress/out-${o.id}.mp4`, size: 20 * MiB, durationMs: 60_000, width: 720, height: 1280, videoBitrate: 2_500_000 }),
    cancel: async () => {},
    onProgress: async () => () => {},
    copyToCache: async (_f, p) => `file:///cache/${p}`,
    readOutput: async (_r, name) => new File(["out"], name, { type: "video/mp4" }),
    deleteCacheFile: async () => {},
    now: () => 0,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetUploadLogForTests();
  resetUploadLimitForTests();
});
afterEach(() => {
  setPickedMediaDepsForTests(null);
  setVideoCompressionDepsForTests(null);
});

describe("pickMediaNatively", () => {
  it("returns light Files with the picked name, type and size, plus the unreadable ones", async () => {
    const m = makeDeps();
    setPickedMediaDepsForTests(m.deps);
    const picked = (await pickMediaNatively(15 * MiB))!;
    expect(m.deps.pick).toHaveBeenCalledWith(15 * MiB);
    expect(picked.files.map((f) => [f.name, f.type, f.size])).toEqual([
      ["PXL_1.jpg", "image/jpeg", 4_716_270],
      ["PXL_2.mp4", "video/mp4", 92_782_267],
      ["PXL_3.mp4", "video/mp4", 4_962_243],
    ]);
    expect(fileSourceOf(picked.files[0])?.kind).toBe("copy");
    expect(fileSourceOf(picked.files[1])).toMatchObject({ kind: "uri", uri: "content://media/picker/0/v/2", durationMs: 37_098 });
    expect(fileSourceOf(picked.files[1])?.posterUrl).toContain("picked-thumbs/b1-1.jpg");
    expect(picked.unreadable).toEqual([{ name: "cloud.mp4", error: "FileNotFoundException: gone" }]);
    expect(getUploadLog().find((e) => e.e === "pick:native")?.d).toMatchObject({ n: 4, copied: 2, kept: 1, unreadable: 1, authority: "media" });
  });

  it("resolves null when the user backs out", async () => {
    setPickedMediaDepsForTests(makeDeps({ cancelled: true, items: [] }).deps);
    expect(await pickMediaNatively(15 * MiB)).toBeNull();
  });

  it("reads a sourced file from its copy, never from the File itself", async () => {
    const m = makeDeps();
    setPickedMediaDepsForTests(m.deps);
    const [photo] = (await pickMediaNatively(15 * MiB))!.files;
    const spy = vi.spyOn(photo, "arrayBuffer");
    const read = await readPickedFile(photo);
    expect(read.size).toBe(5);
    expect(read.name).toBe("PXL_1.jpg");
    expect(read.type).toBe("image/jpeg");
    expect(m.fetched).toEqual(["https://localhost/_capacitor_file_//data/files/picked/b1/0-PXL_1.jpg"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("releases only our copy, the thumbnail and the pinned grant, once", async () => {
    const m = makeDeps();
    setPickedMediaDepsForTests(m.deps);
    const [photo, bigVideo, smallVideo] = (await pickMediaNatively(15 * MiB))!.files;
    await releaseFileSource(photo);
    await releaseFileSource(photo);
    await releaseFileSource(bigVideo);
    await releaseFileSource(smallVideo);
    await releaseFileSource(new File(["x"], "plain.jpg"));
    expect(m.released).toEqual([
      { paths: ["/data/files/picked/b1/0-PXL_1.jpg"], uris: [] },
      { paths: [], uris: ["content://media/picker/0/v/2", "file:///cache/picked-thumbs/b1-1.jpg"] },
      { paths: ["/data/files/picked/b1/2-PXL_3.mp4"], uris: ["file:///cache/picked-thumbs/b1-2.jpg"] },
    ]);
    expect(fileSourceOf(photo)).toBeUndefined();
  });
});

describe("the composer and the compressor with native picks", () => {
  it("previews the copy and the poster; closing releases, sending keeps", async () => {
    const m = makeDeps();
    setPickedMediaDepsForTests(m.deps);
    setVideoCompressionDepsForTests(compressDeps());
    const files = (await pickMediaNatively(15 * MiB))!.files;
    const upload = useMediaUpload();
    upload.addFiles(files);
    expect(upload.files.value[0].previewUrl).toContain("picked/b1/0-PXL_1.jpg");
    expect(upload.files.value[1].posterUrl).toContain("picked-thumbs/b1-1.jpg");
    upload.removeFile(2);
    await vi.waitFor(() => expect(m.released).toHaveLength(1));
    upload.clear({ keepSources: true });
    expect(m.released).toHaveLength(1);
    expect(fileSourceOf(files[0])).toBeDefined();
    upload.addFiles([files[0]]);
    upload.clear();
    await vi.waitFor(() => expect(m.released).toHaveLength(2));
  });

  it("compresses a big native video straight from its URI and deletes only its own output", async () => {
    setPickedMediaDepsForTests(makeDeps().deps);
    const [, bigVideo] = (await pickMediaNatively(15 * MiB))!.files;
    const deleted: string[] = [];
    const calls: CompressVideoOptions[] = [];
    const deps: VideoCompressionDeps = {
      available: () => true,
      uploadLimit: async () => 50 * MiB,
      probe: vi.fn(async () => ({ durationMs: 37_098, width: 1080, height: 1920, rotation: 90, bitrate: 20_000_000 })),
      compress: async (o): Promise<CompressVideoResult> => {
        calls.push(o);
        return { path: `/cache/video-compress/out-${o.id}.mp4`, uri: `file:///cache/video-compress/out-${o.id}.mp4`, size: 20 * MiB, durationMs: 37_098, width: 720, height: 1280, videoBitrate: 2_500_000 };
      },
      cancel: async () => {},
      onProgress: async () => () => {},
      copyToCache: vi.fn(async () => "file:///never"),
      readOutput: async (r, name) => new File(["out"], name, { type: "video/mp4" }),
      deleteCacheFile: async (p) => { deleted.push(p); },
      now: () => 0,
    };
    setVideoCompressionDepsForTests(deps);
    const prepared = await prepareVideoForSend(bigVideo, "c-native-1");
    expect(prepared?.compressed).toBe(true);
    expect(deps.copyToCache).not.toHaveBeenCalled();
    expect(deps.probe).toHaveBeenCalledWith("content://media/picker/0/v/2");
    expect(calls[0].path).toBe("content://media/picker/0/v/2");
    await prepared!.cleanup();
    expect(deleted).toEqual(["/cache/video-compress/out-c-native-1.mp4"]);
    expect(getUploadLog().find((e) => e.e === "compress:start")?.d).toMatchObject({ src: "uri" });
  });

  it("a small video does not wait behind a running compression", async () => {
    let release!: () => void;
    const deps: VideoCompressionDeps = {
      available: () => true,
      uploadLimit: async () => 50 * MiB,
      probe: async () => ({ durationMs: 60_000, width: 1080, height: 1920, rotation: 0, bitrate: 17_000_000 }),
      compress: async (o) => {
        await new Promise<void>((r) => { release = r; });
        return { path: `/cache/video-compress/out-${o.id}.mp4`, uri: "file:///o", size: 20 * MiB, durationMs: 60_000, width: 720, height: 1280, videoBitrate: 2_500_000 };
      },
      cancel: async () => {},
      onProgress: async () => () => {},
      copyToCache: async (_f, p) => `file:///cache/${p}`,
      readOutput: async (_r, name) => new File(["out"], name, { type: "video/mp4" }),
      deleteCacheFile: async () => {},
      now: () => 0,
    };
    setVideoCompressionDepsForTests(deps);
    const big = new File(["x"], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 90 * MiB });
    const small = new File(["x"], "small.mp4", { type: "video/mp4" });
    Object.defineProperty(small, "size", { value: 9 * MiB });
    const bigRun = prepareVideoForSend(big, "c-big");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const smallPrepared = await prepareVideoForSend(small, "c-small");
    expect(smallPrepared).toMatchObject({ file: small, compressed: false });
    release();
    expect((await bigRun)?.compressed).toBe(true);
  });
});
