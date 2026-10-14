import { shallowRef, readonly } from "vue";

const roomId = shallowRef<string | null>(null);

/** The room whose message list is on screen right now, or null (chat list,
 *  settings, a channel, another page). Published by ChatPage, which owns the
 *  layout; the voice mini-player hides for the chat the voice plays in. */
export const visibleChatRoomId = readonly(roomId);

export function setVisibleChatRoom(id: string | null): void {
  roomId.value = id;
}
