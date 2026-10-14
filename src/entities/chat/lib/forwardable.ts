import { MessageStatus, MessageType, type Message } from "../model/types";

type ForwardableFields = Pick<
  Message,
  "type" | "status" | "deleted" | "decryptionStatus" | "callInfo" | "uploadProgress"
>;

/** Statuses of a message that has not reached the server yet. */
const UNSETTLED_STATUSES = new Set<MessageStatus>([
  MessageStatus.sending,
  MessageStatus.failed,
  MessageStatus.cancelled,
]);

/**
 * Whether a message may be forwarded — to another chat or to other apps.
 * Only settled, decrypted messages qualify: an undecrypted event has no
 * content to hand over, and a pending / failed / deleted one is not a real
 * message yet (or any more). Call records and system events are not content.
 */
export function isForwardableMessage(msg: ForwardableFields): boolean {
  if (msg.deleted || msg.decryptionStatus) return false;
  if (UNSETTLED_STATUSES.has(msg.status)) return false;
  if (msg.uploadProgress !== undefined) return false;
  if (msg.callInfo || msg.type === MessageType.system) return false;
  return true;
}
