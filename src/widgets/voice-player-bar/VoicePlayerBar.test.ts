// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { ref, shallowRef } from "vue";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

const routeName = ref<string>("ChatPage");
const routerPush = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ currentRoute: { get value() { return { name: routeName.value }; } }, push: routerPush }),
}));

const setActiveRoom = vi.fn();
vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({
    rooms: [{ id: "!r:s", name: "Team" }],
    getDisplayName: (addr: string) => `name:${addr}`,
    setActiveRoom,
  }),
}));
vi.mock("@/entities/chat/lib/use-resolved-room-name", () => ({
  useResolvedRoomName: () => ({ resolve: (room?: { name: string }) => room?.name ?? "" }),
}));

const clearActiveChannel = vi.fn();
vi.mock("@/entities/channel", () => ({ useChannelStore: () => ({ clearActiveChannel }) }));
const selectChat = vi.fn();
vi.mock("@/entities/ai-chat", () => ({ useAiChatStore: () => ({ selectChat }) }));

const closeSettingsContent = vi.fn();
const setTab = vi.fn();
vi.mock("@/widgets/sidebar/model/use-sidebar-tab", () => ({
  useSidebarTab: () => ({ closeSettingsContent, setTab }),
}));

const state = ref("idle");
const current = shallowRef<Record<string, unknown> | null>(null);
const playback = {
  state,
  current,
  progress: ref(0.25),
  playbackRate: ref(1),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  cycleSpeed: vi.fn(),
};
vi.mock("@/features/messaging/model/use-audio-playback", () => ({
  useAudioPlayback: () => playback,
}));

const { pendingScroll, takePendingScroll } = await import("@/features/messaging/model/pending-scroll");
const { default: VoicePlayerBar } = await import("./VoicePlayerBar.vue");

const META = { messageId: "cli_1", roomId: "!r:s", listenedId: "$ev1", timestamp: 1, senderId: "peer" };

describe("VoicePlayerBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.value = "idle";
    current.value = null;
    routeName.value = "ChatPage";
    takePendingScroll("!r:s");
  });

  it.each(["idle", "failed"])("is hidden in state %s", (s) => {
    state.value = s;
    current.value = META;
    const w = mount(VoicePlayerBar);
    expect(w.find('[data-testid="voice-player-bar"]').exists()).toBe(false);
  });

  // "ended" = the auto-advance gap: hiding the in-flow bar would jump the screen.
  it.each(["loading", "playing", "paused", "ended"])("is shown in state %s with sender and chat", (s) => {
    state.value = s;
    current.value = META;
    const w = mount(VoicePlayerBar);
    expect(w.find('[data-testid="voice-player-bar"]').exists()).toBe(true);
    expect(w.text()).toContain("name:peer");
    expect(w.text()).toContain("Team");
  });

  it("pauses while playing and resumes while paused", async () => {
    state.value = "playing";
    current.value = META;
    const w = mount(VoicePlayerBar);
    await w.find('[data-testid="voice-player-toggle"]').trigger("click");
    expect(playback.pause).toHaveBeenCalled();

    state.value = "paused";
    await w.vm.$nextTick();
    await w.find('[data-testid="voice-player-toggle"]').trigger("click");
    expect(playback.resume).toHaveBeenCalled();
  });

  it("speed and close call the player", async () => {
    state.value = "playing";
    current.value = META;
    const w = mount(VoicePlayerBar);
    await w.find('[data-testid="voice-player-speed"]').trigger("click");
    await w.find('[data-testid="voice-player-close"]').trigger("click");
    expect(playback.cycleSpeed).toHaveBeenCalled();
    expect(playback.stop).toHaveBeenCalled();
  });

  it("tap opens the chat and queues a scroll to the voice", async () => {
    state.value = "playing";
    current.value = META;
    const w = mount(VoicePlayerBar);
    await w.find('[data-testid="voice-player-open"]').trigger("click");

    expect(pendingScroll.value).toEqual({ roomId: "!r:s", messageId: "$ev1" });
    expect(setActiveRoom).toHaveBeenCalledWith("!r:s");
    expect(closeSettingsContent).toHaveBeenCalled();
    expect(setTab).toHaveBeenCalledWith("chats");
    expect(clearActiveChannel).toHaveBeenCalled();
    expect(selectChat).toHaveBeenCalledWith(null);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("tap from another page navigates to the chat page", async () => {
    routeName.value = "ProfilePage";
    state.value = "paused";
    current.value = META;
    const w = mount(VoicePlayerBar);
    await w.find('[data-testid="voice-player-open"]').trigger("click");
    expect(routerPush).toHaveBeenCalledWith({ name: "ChatPage" });
  });
});
