// Straight from model/types: component tests mock the "@/entities/chat" barrel.
import { MessageType, POST_SHARE_ROOM_ID } from "@/entities/chat/model/types";
import type { FileInfo, ForwardingMessage, Message } from "@/entities/chat/model/types";
import { bastyonLinksToHttps, buildTransferMessageBody } from "@/shared/lib/bastyon-link";
import { formatMessageForCopy } from "@/shared/lib/message-format";

/** A media file to hand to other apps — enough to download and decrypt it. */
export interface ShareFileSource {
  fileInfo: FileInfo;
  roomId: string;
  senderId: string;
  timestamp: number;
  /** Already decrypted bytes on screen (MediaViewer) — skips the download. */
  objectUrl?: string;
}

/** What goes into the system share sheet. */
export interface ExternalSharePlan {
  text?: string;
  url?: string;
  files: ShareFileSource[];
}

/** One message to share — the fields common to Message and ForwardingMessage. */
export type ShareSource = Pick<
  Message,
  "type" | "content" | "fileInfo" | "pollInfo" | "transferInfo" | "callLinkInfo" | "roomId" | "senderId"
> & { timestamp: number };

type GetAlias = (userId: string) => string | null | undefined;

const MEDIA_TYPES = new Set<MessageType>([
  MessageType.image,
  MessageType.video,
  MessageType.audio,
  MessageType.file,
  MessageType.videoCircle,
]);

/** Text of a non-media message as other apps should see it: plain text,
 *  `@Name` mentions and https://bastyon.com instead of bastyon:// links. */
export function messageShareText(src: ShareSource, getAlias?: GetAlias): string {
  if (src.type === MessageType.poll && src.pollInfo) {
    const options = src.pollInfo.options.map((o) => `• ${o.text}`);
    return [src.pollInfo.question, ...options].join("\n");
  }
  if (src.type === MessageType.transfer && src.transferInfo) {
    return bastyonLinksToHttps(buildTransferMessageBody(src.transferInfo.txId, src.transferInfo.message));
  }
  if (src.type === MessageType.callLink && src.callLinkInfo) {
    const { label, url } = src.callLinkInfo;
    return label ? `${label}\n${url}` : url;
  }
  return formatMessageForCopy(src.content, getAlias);
}

/** Share plan for one or several messages, in chronological order: media
 *  become files (their captions join the text), everything else becomes text. */
export function buildMessagesSharePlan(sources: ShareSource[], getAlias?: GetAlias): ExternalSharePlan {
  const texts: string[] = [];
  const files: ShareFileSource[] = [];
  const ordered = [...sources].sort((a, b) => a.timestamp - b.timestamp);
  for (const src of ordered) {
    if (MEDIA_TYPES.has(src.type) && src.fileInfo) {
      files.push({ fileInfo: src.fileInfo, roomId: src.roomId, senderId: src.senderId, timestamp: src.timestamp });
      const caption = src.fileInfo.caption?.trim();
      if (caption) texts.push(formatMessageForCopy(caption, getAlias));
      continue;
    }
    const text = messageShareText(src, getAlias).trim();
    if (text) texts.push(text);
  }
  const text = texts.join("\n\n");
  return { ...(text ? { text } : {}), files };
}

/** Share plan for the single forward in progress. A Bastyon post shared from
 *  a feed goes out as its https://bastyon.com link only. */
export function buildForwardSharePlan(fwd: ForwardingMessage, getAlias?: GetAlias): ExternalSharePlan {
  if (fwd.roomId === POST_SHARE_ROOM_ID) {
    return { url: bastyonLinksToHttps(fwd.content.trim()), files: [] };
  }
  return buildMessagesSharePlan([{ ...fwd, timestamp: fwd.sourceTimestamp ?? 0 }], getAlias);
}

/** Whether the plan has anything to share. */
export function isSharePlanEmpty(plan: ExternalSharePlan): boolean {
  return !plan.text && !plan.url && plan.files.length === 0;
}
