// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
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
const rooms = [{ id: "!r:s", name: "Team", avatar: "https://x/team.png" as string | undefined }];
vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({
    rooms,
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
  seekByRatio: vi.fn(),
  playbackRate: ref(1),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  cycleSpeed: vi.fn(),
};
const interruptVoicePlayback = vi.fn();
vi.mock("@/features/messaging/model/use-audio-playback", () => ({
  useAudioPlayback: () => playback,
  interruptVoicePlayback: () => interruptVoicePlayback(),
}));

vi.mock("@/entities/user/model", () => ({
  useUserStore: () => ({ getUser: () => ({ image: "https://x/peer.png" }) }),
}));
vi.mock("@/entities/user", () => ({
  UserAvatar: { name: "UserAvatar", props: ["address"], template: '<i class="user-avatar" :data-address="address" />' },
}));
const mediaSessionInfo = vi.fn();
vi.mock("@/features/messaging/model/use-voice-media-session", () => ({
  useVoiceMediaSession: (info: { value: unknown }) => mediaSessionInfo(info),
}));

const inCall = ref(false);
vi.mock("@/entities/call", () => ({
  useCallStore: () => ({ get isInCall() { return inCall.value; } }),
}));

const { setVisibleChatRoom } = await import("@/features/messaging/model/visible-chat-room");
const { resetVoiceWaveformsForTest } = await import("@/features/messaging/model/voice-waveform");
const { pendingScroll, takePendingScroll } = await import("@/features/messaging/model/pending-scroll");
const { default: VoicePlayerBar } = await import("./VoicePlayerBar.vue");

const META = { messageId: "cli_1", roomId: "!r:s", listenedId: "$ev1", timestamp: 1, senderId: "peer" };

const AvatarStub = { name: "Avatar", props: ["src", "name"], template: '<i class="room-avatar" :data-src="src" />' };
const mountBar = () => mount(VoicePlayerBar, { global: { stubs: { Avatar: AvatarStub } } });

enableAutoUnmount(afterEach);

describe("VoicePlayerBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.value = "idle";
    current.value = null;
    routeName.value = "ChatPage";
    inCall.value = false;
    takePendingScroll("!r:s");
    setVisibleChatRoom(null);
    rooms[0].avatar = "https://x/team.png";
    playback.progress.value = 0.25;
    resetVoiceWaveformsForTest();
  });

  it.each(["idle", "failed"])("is hidden in state %s", (s) => {
    state.value = s;
    current.value = META;
    const w = mountBar();
    expect(w.find('[data-testid="voice-player-bar"]').exists()).toBe(false);
  });

  // "ended" = the auto-advance gap: hiding the in-flow bar would jump the screen.
  it.each(["loading", "playing", "paused", "ended"])("is shown in state %s with sender and chat", (s) => {
    state.value = s;
    current.value = META;
    const w = mountBar();
    expect(w.find('[data-testid="voice-player-bar"]').exists()).toBe(true);
    expect(w.text()).toContain("name:peer");
    expect(w.text()).toContain("Team");
  });

  it("pauses while playing and resumes while paused", async () => {
    state.value = "playing";
    current.value = META;
    const w = mountBar();
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
    const w = mountBar();
    await w.find('[data-testid="voice-player-speed"]').trigger("click");
    await w.find('[data-testid="voice-player-close"]').trigger("click");
    expect(playback.cycleSpeed).toHaveBeenCalled();
    expect(playback.stop).toHaveBeenCalled();
  });

  it("tap opens the chat and queues a scroll to the voice", async () => {
    state.value = "playing";
    current.value = META;
    const w = mountBar();
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
    const w = mountBar();
    await w.find('[data-testid="voice-player-open"]').trigger("click");
    expect(routerPush).toHaveBeenCalledWith({ name: "ChatPage" });
  });

  it("a call start interrupts the voice (no resume after it)", async () => {
    state.value = "playing";
    current.value = META;
    const w = mountBar();
    inCall.value = true;
    await w.vm.$nextTick();
    expect(interruptVoicePlayback).toHaveBeenCalledTimes(1);

    inCall.value = false;
    await w.vm.$nextTick();
    expect(interruptVoicePlayback).toHaveBeenCalledTimes(1);
  });

  it("feeds the Media Session with sender, chat and avatar", () => {
    state.value = "playing";
    current.value = META;
    mountBar();
    const info = mediaSessionInfo.mock.calls[0][0] as { value: unknown };
    expect(info.value).toEqual({ title: "name:peer", artist: "Team", artworkUrl: "https://x/peer.png" });
  });

  it("hides while the voice's chat is on screen, shows again when it is left", async () => {
    state.value = "playing";
    current.value = META;
    setVisibleChatRoom("!r:s");
    const w = mountBar();
    expect(w.find('[data-testid="voice-player-bar"]').exists()).toBe(false);
    // Hidden from view only: the system media controls keep the voice.
    const info = mediaSessionInfo.mock.calls[0][0] as { value: unknown };
    expect(info.value).not.toBeNull();

    setVisibleChatRoom("!other:s");
    await w.vm.$nextTick();
    expect(w.find('[data-testid="voice-player-bar"]').exists()).toBe(true);
  });

  it("shows the chat avatar", () => {
    state.value = "playing";
    current.value = META;
    const w = mountBar();
    expect(w.find(".room-avatar").attributes("data-src")).toBe("https://x/team.png");
  });

  it("shows the Bastyon user avatar for a direct chat", () => {
    rooms[0].avatar = "__pocketnet__:PAddr1";
    state.value = "playing";
    current.value = META;
    const w = mountBar();
    expect(w.find(".user-avatar").attributes("data-address")).toBe("PAddr1");
    expect(w.find(".room-avatar").exists()).toBe(false);
  });

  it("draws the voice waveform with the played part highlighted", () => {
    state.value = "playing";
    current.value = { ...META, waveform: Array.from({ length: 50 }, (_, i) => (i % 5) / 4) };
    playback.progress.value = 0.5;
    const w = mountBar();
    const bars = w.findAll('[data-testid="voice-player-waveform"] > div');
    expect(bars).toHaveLength(28);
    const heights = new Set(bars.map((b) => (b.element as HTMLElement).style.height));
    expect(heights.size).toBeGreaterThan(1);
    expect(bars.filter((b) => b.classes().includes("bg-color-bg-ac"))).toHaveLength(14);
  });

  it("tap on the waveform seeks", async () => {
    state.value = "playing";
    current.value = META;
    const w = mountBar();
    const el = w.find('[data-testid="voice-player-waveform"]');
    (el.element as HTMLElement).getBoundingClientRect = () =>
      ({ left: 100, width: 200, top: 0, height: 20, right: 300, bottom: 20, x: 100, y: 0, toJSON: () => ({}) });
    await el.trigger("click", { clientX: 150 });
    expect(playback.seekByRatio).toHaveBeenCalledWith(0.25);
  });
});
