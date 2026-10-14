// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, ref, defineComponent, h } from "vue";
import { MessageStatus, MessageType, POST_SHARE_ROOM_ID } from "@/entities/chat/model/types";

// "Share to other apps" in the forward picker: hands the forwarded content to
// the system share sheet — a feed post as its https://bastyon.com link only,
// several selected messages as several items. Native only.

const TXID = "c".repeat(64);

const mocks = vi.hoisted(() => ({
  share: vi.fn(async (_plan: unknown): Promise<"shared" | "cancelled" | "failed"> => "shared"),
  canShare: { value: true },
}));

vi.mock("../../model/use-external-share", async () => {
  const { ref: vueRef } = await import("vue");
  return {
    get canShareExternally() { return mocks.canShare.value; },
    useExternalShare: () => ({ share: mocks.share, isSharing: vueRef(false) }),
  };
});

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
  tRaw: (k: string) => k,
}));
vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({ useAndroidBackHandler: vi.fn() }));
vi.mock("@/shared/lib/composables/use-media-query", () => ({ useMobile: () => ref(false) }));

interface MockStore {
  sortedRooms: unknown[];
  forwardingMessage: unknown;
  forwardingMessages: unknown[];
  getRoomMemberCount: () => number;
  getLocalAlias: (id: string) => string | null;
  saveForwardDraft: ReturnType<typeof vi.fn>;
  saveBulkForwardDraft: ReturnType<typeof vi.fn>;
  setActiveRoom: ReturnType<typeof vi.fn>;
  exitSelectionMode: ReturnType<typeof vi.fn>;
  cancelForward: ReturnType<typeof vi.fn>;
}

const store: MockStore = {
  sortedRooms: [],
  forwardingMessage: null,
  forwardingMessages: [],
  getRoomMemberCount: () => 0,
  getLocalAlias: () => null,
  saveForwardDraft: vi.fn(),
  saveBulkForwardDraft: vi.fn(),
  setActiveRoom: vi.fn(),
  exitSelectionMode: vi.fn(),
  cancelForward: vi.fn(),
};

vi.mock("@/entities/chat", () => ({ useChatStore: () => store }));
vi.mock("@/entities/chat/lib/use-resolved-room-name", () => ({
  useResolvedRoomName: () => ({ resolve: (r: { name: string }) => r.name }),
}));
vi.mock("@/entities/chat/lib/chat-helpers", () => ({ isUnresolvedName: () => false }));
vi.mock("@/entities/user", () => ({ UserAvatar: defineComponent({ render: () => h("div") }) }));
vi.mock("vue-virtual-scroller", () => ({ RecycleScroller: defineComponent({ render: () => h("div") }) }));
vi.mock("vue-virtual-scroller/dist/vue-virtual-scroller.css", () => ({}));

import ForwardPicker from "../ForwardPicker.vue";

let wrapper: VueWrapper | undefined;

const mountPicker = async () => {
  wrapper = mount(ForwardPicker, { props: { show: true }, attachTo: document.body });
  await nextTick();
};
const shareButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="forward-share-external"]');
const flush = () => new Promise((r) => setTimeout(r, 0));

const message = (over: Record<string, unknown>) => ({
  id: "$e", roomId: "!r:s", senderId: "P", content: "", timestamp: 1,
  status: MessageStatus.sent, type: MessageType.text, ...over,
});

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  mocks.canShare.value = true;
  mocks.share.mockReset().mockResolvedValue("shared");
  store.forwardingMessage = null;
  store.forwardingMessages = [];
  store.cancelForward.mockClear();
  store.exitSelectionMode.mockClear();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ForwardPicker — share to other apps", () => {
  it("shares a feed post as its https link only and closes", async () => {
    store.forwardingMessage = {
      id: "p", roomId: POST_SHARE_ROOM_ID, senderId: "", senderName: "Author",
      content: `https://bastyon.com/post?s=${TXID}`, type: MessageType.text, withSenderInfo: false,
    };
    await mountPicker();
    shareButton()!.click();
    await flush();
    expect(mocks.share).toHaveBeenCalledWith({ url: `https://bastyon.com/post?s=${TXID}`, files: [] });
    expect(store.cancelForward).toHaveBeenCalled();
    expect(wrapper!.emitted("close")).toBeTruthy();
  });

  it("shares several selected messages as several items", async () => {
    const fileInfo = { name: "a.jpg", type: "image/jpeg", size: 1, url: "mxc://s/a" };
    store.forwardingMessages = [
      message({ id: "1", content: `bastyon://post?s=${TXID}`, timestamp: 1 }),
      message({ id: "2", type: MessageType.image, fileInfo, timestamp: 2 }),
    ];
    await mountPicker();
    shareButton()!.click();
    await flush();
    const plan = mocks.share.mock.calls[0][0] as { text: string; files: { fileInfo: unknown }[] };
    expect(plan.text).toBe(`https://bastyon.com/post?s=${TXID}`);
    expect(plan.files).toHaveLength(1);
    expect(store.exitSelectionMode).toHaveBeenCalled();
  });

  it("keeps the picker open when the share sheet is dismissed", async () => {
    mocks.share.mockResolvedValue("cancelled");
    store.forwardingMessage = { id: "$e", roomId: "!r:s", senderId: "P", content: "hi", type: MessageType.text, withSenderInfo: true };
    await mountPicker();
    shareButton()!.click();
    await flush();
    expect(mocks.share).toHaveBeenCalledWith({ text: "hi", files: [] });
    expect(store.cancelForward).not.toHaveBeenCalled();
    expect(wrapper!.emitted("close")).toBeFalsy();
  });

  it("is hidden for content that came from another app", async () => {
    store.forwardingMessage = { id: "x", roomId: "", senderId: "", content: "hi", type: MessageType.text, withSenderInfo: false, isExternalShare: true };
    await mountPicker();
    expect(shareButton()).toBeNull();
  });

  it("is hidden on desktop", async () => {
    mocks.canShare.value = false;
    store.forwardingMessage = { id: "$e", roomId: "!r:s", senderId: "P", content: "hi", type: MessageType.text, withSenderInfo: true };
    await mountPicker();
    expect(shareButton()).toBeNull();
  });
});
