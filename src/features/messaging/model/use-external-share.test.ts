// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileInfo } from "@/entities/chat/model/types";

const mocks = vi.hoisted(() => ({
  share: vi.fn(async () => ({})),
  writeShareFiles: vi.fn(async (inputs: unknown[]) => inputs.map((_, i) => `file:///cache/${i}`)),
  getDecryptedBlobForMessage: vi.fn(async () => new Blob(["bytes"], { type: "image/jpeg" })),
  toast: vi.fn(),
}));

vi.mock("@/shared/lib/platform", () => ({ isNative: true }));
vi.mock("@/shared/lib/i18n", () => ({ tRaw: (k: string) => k }));
vi.mock("@/shared/lib/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@capacitor/share", () => ({ Share: { share: mocks.share } }));
vi.mock("@/shared/lib/share-files", () => ({ writeShareFiles: mocks.writeShareFiles }));
vi.mock("./use-file-download", () => ({ getDecryptedBlobForMessage: mocks.getDecryptedBlobForMessage }));

import { useExternalShare } from "./use-external-share";

const fileInfo: FileInfo = { name: "photo.jpg", type: "image/jpeg", size: 5, url: "mxc://s/a" };
const fileSrc = { fileInfo, roomId: "!r:s", senderId: "P", timestamp: 1 };

beforeEach(() => vi.clearAllMocks());

describe("useExternalShare", () => {
  it("shares a link without touching the file system", async () => {
    const { share } = useExternalShare();
    expect(await share({ url: "https://bastyon.com/post?s=x", files: [] })).toBe("shared");
    expect(mocks.writeShareFiles).not.toHaveBeenCalled();
    expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ url: "https://bastyon.com/post?s=x", files: undefined }));
  });

  it("decrypts media and passes the written file URIs with the text", async () => {
    const { share } = useExternalShare();
    expect(await share({ text: "caption", files: [fileSrc] })).toBe("shared");
    expect(mocks.getDecryptedBlobForMessage).toHaveBeenCalledWith(fileSrc);
    expect(mocks.writeShareFiles).toHaveBeenCalledWith([expect.objectContaining({ name: "photo.jpg", mimeType: "image/jpeg" })]);
    expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ text: "caption", files: ["file:///cache/0"] }));
  });

  it("uses the on-screen object URL when it is still alive", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["x"])));
    const { share } = useExternalShare();
    await share({ files: [{ ...fileSrc, objectUrl: "blob:live" }] });
    expect(fetchSpy).toHaveBeenCalledWith("blob:live");
    expect(mocks.getDecryptedBlobForMessage).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reports a dismissed share sheet as cancelled, without a toast", async () => {
    mocks.share.mockRejectedValueOnce(new Error("Share canceled"));
    const { share } = useExternalShare();
    expect(await share({ text: "hi", files: [] })).toBe("cancelled");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("toasts when the media can't be decrypted", async () => {
    mocks.getDecryptedBlobForMessage.mockResolvedValueOnce(null as unknown as Blob);
    const { share } = useExternalShare();
    expect(await share({ files: [fileSrc] })).toBe("failed");
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("share.failed", "error");
  });

  it("ignores a second tap while a share is in progress", async () => {
    const { share, isSharing } = useExternalShare();
    const first = share({ text: "a", files: [] });
    expect(isSharing.value).toBe(true);
    expect(await share({ text: "b", files: [] })).toBe("failed");
    await first;
    expect(mocks.share).toHaveBeenCalledTimes(1);
    expect(isSharing.value).toBe(false);
  });

  it("does nothing for an empty plan", async () => {
    const { share } = useExternalShare();
    expect(await share({ files: [] })).toBe("failed");
    expect(mocks.share).not.toHaveBeenCalled();
  });
});
