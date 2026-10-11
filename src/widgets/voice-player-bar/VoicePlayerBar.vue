<script setup lang="ts">
import { useRouter } from "vue-router";
import { useChatStore } from "@/entities/chat";
import { useResolvedRoomName } from "@/entities/chat/lib/use-resolved-room-name";
import { useChannelStore } from "@/entities/channel";
import { useAiChatStore } from "@/entities/ai-chat";
import { useAudioPlayback, interruptVoicePlayback } from "@/features/messaging/model/use-audio-playback";
import { useCallStore } from "@/entities/call";
import { requestScrollToMessage } from "@/features/messaging/model/pending-scroll";
import { useVoiceMediaSession } from "@/features/messaging/model/use-voice-media-session";
import { useUserStore } from "@/entities/user/model";
import { UserAvatar } from "@/entities/user";
import { visibleChatRoomId } from "@/features/messaging/model/visible-chat-room";
import { getVoiceWaveform, waveformBars } from "@/features/messaging/model/voice-waveform";
import { useSidebarTab } from "@/widgets/sidebar/model/use-sidebar-tab";

const { t } = useI18n();
const router = useRouter();
const chatStore = useChatStore();
const channelStore = useChannelStore();
const aiChatStore = useAiChatStore();
const { resolve: resolveRoomName } = useResolvedRoomName();
const { closeSettingsContent, setTab } = useSidebarTab();
const playback = useAudioPlayback();
const callStore = useCallStore();

// A call takes over the audio (and on iOS the AVAudioSession): pause the
// voice, no resume after the call. The bar lives for the whole signed-in
// session, so it is the one place that sees every call start.
watch(() => callStore.isInCall, (inCall) => {
  if (inCall) interruptVoicePlayback();
});

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

// The voice's own chat is on screen: its bubble already has the controls.
const isShown = computed(() => !!meta.value && visibleChatRoomId.value !== meta.value.roomId);

const room = computed(() => {
  const roomId = meta.value?.roomId;
  return roomId ? chatStore.rooms.find((r) => r.id === roomId) : undefined;
});

const roomName = computed(() => (room.value ? resolveRoomName(room.value) : ""));

/** `__pocketnet__:<address>` avatars belong to a Bastyon user (direct chats). */
const avatarAddress = computed(() => {
  const avatar = room.value?.avatar;
  return avatar?.startsWith("__pocketnet__:") ? avatar.slice("__pocketnet__:".length) : null;
});

const BARS = 28;
const bars = computed(() => {
  const current = meta.value;
  return waveformBars(current ? getVoiceWaveform(current.messageId, current.waveform) : null, BARS);
});
const playedBars = computed(() => Math.floor(playback.progress.value * BARS));

const seekTo = (e: MouseEvent) => {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  if (rect.width > 0) playback.seekByRatio(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
};

const isPlaying = computed(() => playback.state.value === "playing");

const userStore = useUserStore();

// Media keys, the system overlay and the iOS lock screen.
useVoiceMediaSession(computed(() => {
  const current = meta.value;
  if (!current) return null;
  return {
    title: senderName.value,
    artist: roomName.value || t("message.voiceMessage"),
    artworkUrl: userStore.getUser(current.senderId)?.image || undefined,
  };
}));

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
    v-if="isShown"
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
      class="flex min-w-0 flex-1 items-center gap-2 text-left leading-tight"
      :aria-label="t('voicePlayer.openMessage')"
      @click="openMessage"
    >
      <UserAvatar v-if="avatarAddress" data-testid="voice-player-avatar" :address="avatarAddress" size="sm" />
      <Avatar
        v-else
        data-testid="voice-player-avatar"
        :src="room?.avatar"
        :name="roomName || senderName"
        size="sm"
      />
      <span class="flex min-w-0 flex-1 flex-col items-start">
        <span class="w-full truncate text-sm font-medium text-text-color">{{ senderName }}</span>
        <span class="w-full truncate text-xs text-text-on-main-bg-color">
          {{ roomName || t("message.voiceMessage") }}
        </span>
      </span>
    </button>

    <!-- Waveform: tap to seek; bars recolor only on timeupdate. -->
    <div
      data-testid="voice-player-waveform"
      class="flex h-5 shrink-0 cursor-pointer items-center gap-[2px]"
      @click="seekTo"
    >
      <div
        v-for="(v, i) in bars"
        :key="i"
        class="w-[2px] rounded-full"
        :class="i < playedBars ? 'bg-color-bg-ac' : 'bg-color-bg-ac/30'"
        :style="{ height: `${Math.max(2, v * 20)}px` }"
      />
    </div>

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
