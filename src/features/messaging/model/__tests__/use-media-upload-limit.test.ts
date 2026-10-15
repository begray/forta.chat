// @vitest-environment happy-dom
/** A video over the server limit never gets into the composer: the user sees
 *  why at pick time instead of after a full upload that the server drops. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetUploadLimitForTests } from "@/shared/lib/file-transfer/upload-limit";

const h = vi.hoisted(() => ({ reportSendError: vi.fn() }));

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({ getMediaUploadLimit: async () => undefined }),
}));
vi.mock("../send-error-bus", () => ({ reportSendError: h.reportSendError }));

import { useMediaUpload } from "../use-media-upload";

function sized(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeEach(() => {
  localStorage.clear();
  resetUploadLimitForTests();
  h.reportSendError.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:stub");
  URL.revokeObjectURL = vi.fn();
});

describe("useMediaUpload pick-time size check", () => {
  it("drops a video over the limit with a sized error and keeps the rest", () => {
    const media = useMediaUpload();
    media.addFiles([
      sized("a.mp4", "video/mp4", 92_782_267),
      sized("b.mp4", "video/mp4", 39_897_048),
      sized("c.jpg", "image/jpeg", 60_000_000), // shrinks when optimized: checked at send
    ]);

    expect(media.files.value.map((f) => f.file.name)).toEqual(["b.mp4", "c.jpg"]);
    expect(h.reportSendError).toHaveBeenCalledTimes(1);
    expect(h.reportSendError.mock.calls[0][0].context).toMatchObject({ kind: "video", sizeBytes: 92_782_267 });
  });
});
