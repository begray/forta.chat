// @vitest-environment happy-dom
/**
 * Retry on a failed media bubble after the app was backgrounded.
 *
 * Root cause (pre-fix): retryMediaUpload ran its own upload pipeline and
 * re-read the file from the message's blob: URL. Android reloads the WebView
 * of a backgrounded app, which kills every blob: URL — the fetch failed and
 * Retry silently returned, although the bytes were persisted in
 * `attachments` and the send_file op was still in the queue.
 *
 * Fix: Retry re-arms the queued send_file op (SyncEngine uploads from the
 * persisted blob); without an op it rebuilds the send from the persisted
 * blob; with no local copy at all it reports an error instead of doing
 * nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { MessageStatus, MessageType } from "@/entities/chat";
import type { Message } from "@/entities/chat";
import { useSendErrorBus, __resetSendErrorBusForTests } from "../send-error-bus";

const mocks = vi.hoisted(() => ({
  retryMediaOperation: vi.fn<(clientId: string) => Promise<boolean>>(),
  getByClientId: vi.fn(),
  restoreLocalBlobUrl: vi.fn(async () => "blob:fresh"),
  getLocalAttachmentBlob: vi.fn<(localId: number) => Promise<Blob | undefined>>(),
  confirmMediaSent: vi.fn(async () => undefined),
  uploadContent: vi.fn(async () => "mxc://server/ok"),
  sendEncryptedText: vi.fn(async () => "$event"),
}));

vi.mock("@/shared/lib/local-db", () => ({
  isChatDbReady: vi.fn(() => true),
  getChatDb: vi.fn(() => ({
    messages: {
      getByClientId: mocks.getByClientId,
      restoreLocalBlobUrl: mocks.restoreLocalBlobUrl,
      getLocalAttachmentBlob: mocks.getLocalAttachmentBlob,
      updateUploadProgress: vi.fn(),
      confirmMediaSent: mocks.confirmMediaSent,
    },
    rooms: { syncLastMessageLocalStatus: vi.fn(async () => undefined) },
    syncEngine: { retryMediaOperation: mocks.retryMediaOperation },
    db: {
      messages: {
        update: vi.fn(async () => 1),
        where: vi.fn(() => ({ equals: vi.fn(() => ({ modify: vi.fn(async () => 1) })) })),
      },
    },
    eventWriter: {},
  })),
}));

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => true,
    uploadContent: mocks.uploadContent,
    sendEncryptedText: mocks.sendEncryptedText,
    setTyping: vi.fn(),
  })),
}));

vi.mock("@/entities/matrix/model/matrix-crypto", () => ({
  ENCRYPTION_REQUIRED_NO_KEYS: "ENCRYPTION_REQUIRED_NO_KEYS",
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "0xme", pcrypto: { rooms: {} } }),
}));

vi.mock("@/entities/chat", async () => {
  const actual = await vi.importActual<typeof import("@/entities/chat")>("@/entities/chat");
  return {
    ...actual,
    useChatStore: () => ({ activeRoomId: "!room:server", messages: {} }),
  };
});

vi.mock("../use-file-download", () => ({
  getDecryptedBlobForMessage: vi.fn(),
  invalidateDownloadCache: vi.fn(),
}));
vi.mock("@/features/bug-report", () => ({ useBugReport: () => ({ open: vi.fn() }) }));
vi.mock("@/shared/lib/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/shared/lib/i18n", () => ({ tRaw: (k: string) => k }));
vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: () => ({ isOnline: { value: true } }),
}));
vi.mock("@/shared/lib/offline-queue", () => ({
  enqueue: vi.fn(),
  dequeue: vi.fn(),
  getQueue: vi.fn(() => []),
}));

import { useMessages } from "../use-messages";

const CLIENT_ID = "cli_photo";

function failedPhoto(): Message {
  return {
    id: CLIENT_ID,
    _key: CLIENT_ID,
    roomId: "!room:server",
    senderId: "0xme",
    content: "photo.jpg",
    timestamp: Date.now(),
    status: MessageStatus.failed,
    type: MessageType.image,
    fileInfo: { name: "photo.jpg", type: "image/jpeg", size: 5, url: "blob:dead" },
  } as Message;
}

function localRow() {
  return {
    localId: 7,
    clientId: CLIENT_ID,
    roomId: "!room:server",
    timestamp: Date.now(),
    type: MessageType.image,
    status: "failed",
    localBlobUrl: "blob:dead",
    fileInfo: { name: "photo.jpg", type: "image/jpeg", size: 5, url: "blob:dead" },
  };
}

describe("retryMediaUpload", () => {
  const fetchSpy = vi.fn(async () => { throw new TypeError("Failed to fetch"); });

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    __resetSendErrorBusForTests();
    vi.stubGlobal("fetch", fetchSpy);
    mocks.getByClientId.mockResolvedValue(localRow());
  });

  it("re-arms the queued send_file op instead of re-reading the blob: URL", async () => {
    mocks.retryMediaOperation.mockResolvedValue(true);

    await useMessages().retryMediaUpload(failedPhoto());

    expect(mocks.retryMediaOperation).toHaveBeenCalledWith(CLIENT_ID);
    expect(mocks.restoreLocalBlobUrl).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.uploadContent).not.toHaveBeenCalled();
  });

  it("without a queued op, re-uploads from the persisted blob when the blob: URL is dead", async () => {
    mocks.retryMediaOperation.mockResolvedValue(false);
    mocks.getLocalAttachmentBlob.mockResolvedValue(new Blob(["PHOTO"], { type: "image/jpeg" }));

    await useMessages().retryMediaUpload(failedPhoto());

    expect(mocks.getLocalAttachmentBlob).toHaveBeenCalledWith(7);
    expect(mocks.uploadContent).toHaveBeenCalledTimes(1);
    const uploaded = (mocks.uploadContent.mock.calls[0] as unknown[])[0] as Blob;
    expect(await uploaded.text()).toBe("PHOTO");
    expect(mocks.confirmMediaSent).toHaveBeenCalledWith(
      CLIENT_ID, "$event", expect.objectContaining({ url: "mxc://server/ok" }), "!room:server",
    );
  });

  it("reports an error instead of silently doing nothing when no local copy is left", async () => {
    mocks.retryMediaOperation.mockResolvedValue(false);
    mocks.getLocalAttachmentBlob.mockResolvedValue(undefined);

    await useMessages().retryMediaUpload(failedPhoto());

    expect(mocks.uploadContent).not.toHaveBeenCalled();
    expect(useSendErrorBus().error.value?.kind).toBe("uploadFailed");
  });
});
