import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  APP_MAX_UPLOAD_BYTES,
  FALLBACK_UPLOAD_LIMIT_BYTES,
  exceedsUploadLimit,
  formatFileMegabytes,
  formatLimitMegabytes,
  getUploadLimitBytes,
  noteUploadTooLarge,
  refreshUploadLimit,
  resetUploadLimitForTests,
} from "./upload-limit";

const MiB = 1024 * 1024;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("upload limit", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    resetUploadLimitForTests();
  });

  it("assumes 50 MiB until the server answers", () => {
    expect(getUploadLimitBytes()).toBe(FALLBACK_UPLOAD_LIMIT_BYTES);
    expect(exceedsUploadLimit(52_806_184)).toBe(true); // the 52.8 MB video from the field log
    expect(exceedsUploadLimit(39_897_048)).toBe(false); // the 40 MB one that went through
  });

  it("uses m.upload.size, capped by the app limit, and caches it", async () => {
    const fetchLimit = vi.fn(async () => 30 * MiB);
    expect(await refreshUploadLimit(fetchLimit)).toBe(30 * MiB);
    expect(await refreshUploadLimit(fetchLimit)).toBe(30 * MiB);
    expect(fetchLimit).toHaveBeenCalledTimes(1);

    resetUploadLimitForTests(); // a new launch reads it back from storage
    expect(getUploadLimitBytes()).toBe(30 * MiB);

    localStorage.clear();
    resetUploadLimitForTests();
    expect(await refreshUploadLimit(async () => 500 * MiB)).toBe(APP_MAX_UPLOAD_BYTES);
  });

  it("never rejects: a failing or silent endpoint keeps the fallback", async () => {
    expect(await refreshUploadLimit(async () => { throw new Error("401"); })).toBe(FALLBACK_UPLOAD_LIMIT_BYTES);
    expect(await refreshUploadLimit(async () => undefined)).toBe(FALLBACK_UPLOAD_LIMIT_BYTES);
  });

  it("learns a lower limit only when the server claimed more than the fallback", async () => {
    noteUploadTooLarge(47 * MiB); // under the fallback: may just be a dropped link
    expect(getUploadLimitBytes()).toBe(FALLBACK_UPLOAD_LIMIT_BYTES);

    await refreshUploadLimit(async () => 100 * MiB);
    noteUploadTooLarge(60 * MiB);
    expect(getUploadLimitBytes()).toBe(60 * MiB - 1);
    expect(exceedsUploadLimit(60 * MiB)).toBe(true);
  });

  it("formats sizes the way the gallery shows them", () => {
    expect(formatFileMegabytes(92_782_267)).toBe("92.8");
    expect(formatLimitMegabytes(FALLBACK_UPLOAD_LIMIT_BYTES)).toBe("52");
  });
});
