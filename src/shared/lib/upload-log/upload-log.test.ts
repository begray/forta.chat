// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  logUpload,
  logUploadError,
  getUploadLog,
  clearUploadLog,
  flushUploadLog,
  formatUploadLog,
  fileLabel,
  redact,
  resetUploadLogForTests,
  UPLOAD_LOG_MAX_ENTRIES,
} from "./upload-log";

const KEY = "forta.upload-log.v1";

describe("upload log", () => {
  beforeEach(() => {
    localStorage.clear();
    resetUploadLogForTests();
  });

  it("records events with a short clientId and drops empty details", () => {
    logUpload("upload:start", "12345678-aaaa-bbbb-cccc-dddddddddddd", { size: 1024, transport: undefined });
    const [entry] = getUploadLog();
    expect(entry.e).toBe("upload:start");
    expect(entry.c).toBe("12345678");
    expect(entry.d).toEqual({ size: 1024 });
  });

  it("is bounded to the newest entries", () => {
    for (let i = 0; i < UPLOAD_LOG_MAX_ENTRIES + 25; i++) logUpload("tick", null, { i });
    const log = getUploadLog();
    expect(log).toHaveLength(UPLOAD_LOG_MAX_ENTRIES);
    expect(log[0].d?.i).toBe(25);
  });

  it("persists to localStorage and survives a reload", () => {
    logUpload("echo:ok", "abcdef0123", { attachmentId: 7 });
    flushUploadLog();
    resetUploadLogForTests();
    expect(getUploadLog().map((x) => x.e)).toEqual(["echo:ok"]);
  });

  it("persists on its own after a short delay", () => {
    vi.useFakeTimers();
    try {
      logUpload("pick", null, { n: 3 });
      expect(localStorage.getItem(KEY)).toBeNull();
      vi.advanceTimersByTime(1500);
      expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a corrupt stored log", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getUploadLog()).toEqual([]);
    logUpload("pick");
    expect(getUploadLog()).toHaveLength(1);
  });

  it("redacts tokens and URL paths from error messages", () => {
    logUploadError("upload:fail", "c1", new Error(
      "POST https://matrix.example.org/_matrix/media/v3/upload?access_token=SECRET failed, Bearer abc.def",
    ));
    const err = String(getUploadLog()[0].d?.err);
    expect(err).not.toContain("SECRET");
    expect(err).not.toContain("abc.def");
    expect(err).not.toContain("/_matrix/media");
    expect(err).toContain("matrix.example.org");
    expect(redact("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it("keeps the DOMException name in error descriptions", () => {
    logUploadError("echo:fail", "c1", new DOMException("Failed to read blob", "NotReadableError"));
    expect(getUploadLog()[0].d?.err).toBe("NotReadableError: Failed to read blob");
  });

  it("reduces file names to their shape", () => {
    expect(fileLabel("bb4dde02-1234-4abc-9def-0123456789ab.jpg")).toBe("uuid.jpg");
    expect(fileLabel("PXL_20261014_123456.jpg")).toBe("name(19).jpg");
    expect(fileLabel("noext")).toBe("name(5)");
    expect(fileLabel("")).toBe("(none)");
  });

  it("formats a readable export with a header", () => {
    logUpload("upload:abort", "abcdef0123", { reason: "deadline passed" });
    const text = formatUploadLog(undefined, { app: "1.13.5" });
    expect(text).toContain("Forta Chat upload log");
    expect(text).toContain("app: 1.13.5");
    expect(text).toContain("events: 1");
    expect(text).toMatch(/\[abcdef01\] upload:abort reason="deadline passed"/);
  });

  it("clear empties memory and storage", () => {
    logUpload("pick");
    clearUploadLog();
    expect(getUploadLog()).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
  });
});
