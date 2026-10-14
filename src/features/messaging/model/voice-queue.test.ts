import { describe, it, expect, beforeEach, vi } from "vitest";

const mockGetNextAudioAfter = vi.fn();
vi.mock("@/shared/lib/local-db", () => ({
  isChatDbReady: () => true,
  getChatDb: () => ({
    messages: { getNextAudioAfter: mockGetNextAudioAfter },
    eventWriter: { getClearedAtTs: () => 50 },
  }),
  localToMessage: (l: { eventId: string; clientId: string; roomId: string }) => ({
    id: l.eventId,
    _key: l.clientId,
    roomId: l.roomId,
  }),
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "me" }),
}));

const mockDownload = vi.fn();
const downloaderStates = { value: {} as Record<string, unknown> };
const mockPin = vi.fn();
const mockUnpin = vi.fn();
vi.mock("./use-file-download", () => ({
  useFileDownload: () => ({ download: mockDownload, states: downloaderStates }),
  pinFileUrl: (k: string) => mockPin(k),
  unpinFileUrl: (k: string) => mockUnpin(k),
}));

const { findNextVoice, prefetchNextVoice, cancelPrefetch, fetchVoiceUrl } = await import("./voice-queue");

const cursor = { roomId: "!r:s", timestamp: 100, id: "$cur" };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("voice-queue", () => {
  beforeEach(() => {
    cancelPrefetch();
    vi.clearAllMocks();
  });

  it("asks Dexie for the next voice after the cursor, skipping own and cleared history", async () => {
    mockGetNextAudioAfter.mockResolvedValue({ eventId: "$n", clientId: "cli_n", roomId: "!r:s" });
    const next = await findNextVoice(cursor);
    expect(mockGetNextAudioAfter).toHaveBeenCalledWith("!r:s", cursor, { excludeSenderId: "me", clearedAtTs: 50 });
    expect(next).toEqual({ id: "$n", _key: "cli_n", roomId: "!r:s" });
  });

  it("returns null at the end of the chain", async () => {
    mockGetNextAudioAfter.mockResolvedValue(undefined);
    expect(await findNextVoice(cursor)).toBeNull();
  });

  it("fetchVoiceUrl downloads through the shared file cache", async () => {
    mockDownload.mockResolvedValue("blob:x");
    const msg = { id: "$n", _key: "cli_n" } as never;
    expect(await fetchVoiceUrl(msg)).toBe("blob:x");
    mockDownload.mockResolvedValue(undefined);
    expect(await fetchVoiceUrl(msg)).toBeNull();
  });

  it("downloads silently and drops the downloader's state so it holds no Blob", async () => {
    mockDownload.mockImplementation(async (m: { _key: string }) => {
      downloaderStates.value[m._key] = { blob: "decrypted" };
      return "blob:x";
    });
    await fetchVoiceUrl({ id: "$s", _key: "cli_s" } as never);
    expect(mockDownload.mock.calls[0][2]).toEqual({ silent: true });
    expect(downloaderStates.value).not.toHaveProperty("cli_s");
  });

  it("the advance joins the prefetch of the same voice instead of getting no URL", async () => {
    let finish: (url: string) => void = () => {};
    mockDownload.mockReturnValue(new Promise((r) => { finish = r; }));
    mockGetNextAudioAfter.mockResolvedValue({ eventId: "$n", clientId: "cli_n", roomId: "!r:s" });
    prefetchNextVoice(cursor);
    await flush();

    const advance = fetchVoiceUrl({ id: "$n", _key: "cli_n" } as never);
    finish("blob:n");
    expect(await advance).toBe("blob:n");
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it("prefetch downloads and pins the next voice; cancel aborts and unpins it", async () => {
    mockGetNextAudioAfter.mockResolvedValue({ eventId: "$n", clientId: "cli_n", roomId: "!r:s" });
    mockDownload.mockResolvedValue("blob:n");
    prefetchNextVoice(cursor);
    await flush();

    expect(mockPin).toHaveBeenCalledWith("cli_n");
    const signal = mockDownload.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    cancelPrefetch();
    expect(signal.aborted).toBe(true);
    expect(mockUnpin).toHaveBeenCalledWith("cli_n");
  });

  it("a new prefetch replaces the old one", async () => {
    mockGetNextAudioAfter.mockResolvedValue({ eventId: "$n", clientId: "cli_n", roomId: "!r:s" });
    mockDownload.mockResolvedValue("blob:n");
    prefetchNextVoice(cursor);
    await flush();
    prefetchNextVoice({ ...cursor, id: "$n" });
    expect(mockUnpin).toHaveBeenCalledWith("cli_n");
  });

  it("does not pin when cancelled before the next voice is found", async () => {
    mockGetNextAudioAfter.mockResolvedValue({ eventId: "$n", clientId: "cli_n", roomId: "!r:s" });
    prefetchNextVoice(cursor);
    cancelPrefetch();
    await flush();
    expect(mockPin).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});
