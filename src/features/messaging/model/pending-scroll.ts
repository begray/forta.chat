import { shallowRef, readonly } from "vue";

export interface PendingScroll {
  roomId: string;
  /** `Message.id` (eventId, or clientId while pending). */
  messageId: string;
}

const pending = shallowRef<PendingScroll | null>(null);

/** A message to scroll to once its chat is open and the list has settled.
 *  Set by callers outside the chat surface (the voice mini-player) right
 *  before they open the chat; MessageList consumes it. */
export const pendingScroll = readonly(pending);

export function requestScrollToMessage(roomId: string, messageId: string): void {
  pending.value = { roomId, messageId };
}

/** Take the pending target if it belongs to `roomId`; it is consumed once. */
export function takePendingScroll(roomId: string | null): string | null {
  const target = pending.value;
  if (!target || target.roomId !== roomId) return null;
  pending.value = null;
  return target.messageId;
}
