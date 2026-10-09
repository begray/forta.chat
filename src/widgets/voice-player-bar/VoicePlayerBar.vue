<script setup lang="ts">
import { useRouter } from "vue-router";
import { useChatStore } from "@/entities/chat";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { useChannelStore } from "@/entities/channel";
import { useAiChatStore } from "@/entities/ai-chat";
import { useAudioPlayback } from "@/features/messaging/model/use-audio-playback";
import { requestScrollToMessage } from "@/features/messaging/model/pending-scroll";
import { useSidebarTab } from "@/widgets/sidebar/model/use-sidebar-tab";

const { t } = useI18n();
const router = useRouter();
const chatStore = useChatStore();
const channelStore = useChannelStore();
const aiChatStore = useAiChatStore();
const { resolve: resolveRoomName } = useResolvedRoomName();
const { closeSettingsContent, setTab } = useSidebarTab();
const playback = useAudioPlayback();

// Shown on every screen while a voice is loading, playing or paused — the
// voice keeps playing after the user leaves its chat. "ended" is the gap while
// the auto-advance fetches the next voice (the player goes idle at the end of
// the chain): hiding the in-flow bar there would jump the screen by its height.
const meta = computed(() => {
  const state = playback.state.value;
  if (state !== "loading" && state !== "playing" && state !== "paused" && state !== "ended") return null;
  return playback.current.value;
});

const senderName = computed(() =>
  meta.value ? chatStore.getDisplayName(meta.value.senderId) : "",
);

const roomName = computed(() => {
  const roomId = meta.value?.roomId;
  if (!roomId) return "";
  return resolveRoomName(chatStore.rooms.find((r) => r.id === roomId));
});

const isPlaying = computed(() => playback.state.value === "playing");

const togglePause = () => {
  if (isPlaying.value) playback.pause();
  else void playback.resume();
};

/** Open the voice's chat and scroll to it, from any screen. */
const openMessage = () => {
  const current = meta.value;
  if (!current) return;
  requestScrollToMessage(current.roomId, current.listenedId);
  closeSettingsContent();
  setTab("chats");
  channelStore.clearActiveChannel();
  aiChatStore.selectChat(null);
  chatStore.setActiveRoom(current.roomId);
  if (router.currentRoute.value.name !== "ChatPage") void router.push({ name: "ChatPage" });
};
</script>

<template>
  <div
    v-if="meta"
    data-testid="voice-player-bar"
    class="relative flex h-11 shrink-0 items-center gap-2 border-b border-neutral-grad-0 bg-background-total-theme px-3"
  >
    <button
      data-testid="voice-player-toggle"
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-color-bg-ac hover:bg-color-bg-ac/10"
      :aria-label="isPlaying ? t('voicePlayer.pause') : t('voicePlayer.play')"
      @click="togglePause"
    >
      <div
        v-if="playback.state.value === 'loading'"
        class="contain-strict h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      />
      <svg v-else-if="isPlaying" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
      </svg>
      <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
    </button>

    <button
      data-testid="voice-player-open"
      class="flex min-w-0 flex-1 flex-col items-start text-left leading-tight"
      :aria-label="t('voicePlayer.openMessage')"
      @click="openMessage"
    >
      <span class="w-full truncate text-sm font-medium text-text-color">{{ senderName }}</span>
      <span class="w-full truncate text-xs text-text-on-main-bg-color">
        {{ roomName || t("message.voiceMessage") }}
      </span>
    </button>

    <button
      data-testid="voice-player-speed"
      class="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-color-bg-ac hover:bg-color-bg-ac/10"
      @click="playback.cycleSpeed()"
    >
      {{ playback.playbackRate.value }}x
    </button>

    <button
      data-testid="voice-player-close"
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
      :aria-label="t('voicePlayer.close')"
      @click="playback.stop()"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>

    <!-- Progress: changes only on timeupdate, no idle animation. -->
    <div class="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
      <div
        data-testid="voice-player-progress"
        class="h-full origin-left bg-color-bg-ac"
        :style="{ transform: `scaleX(${playback.progress.value})` }"
      />
    </div>
  </div>
</template>
