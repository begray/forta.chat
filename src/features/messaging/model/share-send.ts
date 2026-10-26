/**
 * Sending media that was shared into Forta from another app (the Android
 * share sheet), once the user has picked the chat and tapped Send.
 *
 * Field log (2026-10-26, 11 items shared from the gallery): every item went
 * out twice. The composer kept the share, and an enabled Send button, until
 * the last file had gone through, and it sent the files one by one with
 * about 5 s of image preparation before the first bubble showed. A second
 * tap on Send about 3 s later ran the whole share again. The share also
 * skipped the batch pipeline (no snapshot, no batch bar, no summary), and
 * every video was copied through the WebView before compressing.
 *
 * Now:
 *  - Send takes the share off the composer before anything slow runs, and
 *    claims it (claimShareSend): a second tap, or the same intent delivered
 *    again, finds nothing to send;
 *  - the files go through sendPickedBatch like a gallery pick: snapshot
 *    first, one batch bar, at most two in flight, one honest summary, and
 *    the background keep-alive through the batch and queue sources;
 *  - the share plugin's sandbox copies become sourced Files (kind "share"):
 *    their bytes are read natively when each send runs, and the video
 *    compressor opens the file itself.
 */
import { Capacitor } from "@capacitor/core";
import type { FileInfo, ForwardingMessage } from "@/entities/chat/model/types";
import { isNative } from "@/shared/lib/platform";
import {
  claimShareSend,
  finishShareSend,
  readShareUriAsBlob,
  releaseShareClaim,
  shareKeyOf,
  toNativeFileUri,
} from "@/shared/lib/share-target";
import { describeError, fileLabel, logUpload } from "@/shared/lib/upload-log/upload-log";
import { makeSourcedFile, markPicked } from "./picked-media";
import { sendPickedBatch, type BatchOutcome, type BatchSendContext } from "./media-batch";
import { reportSendError } from "./send-error-bus";
import { SendError } from "./send-errors";

export interface ShareSendDeps {
  /** Native file APIs are there (Android/iOS app, not the web). */
  native: () => boolean;
  /** Size in bytes of a file in our sandbox, by bare path. */
  statPath: (path: string) => Promise<number>;
  /** Delete a file in our sandbox, by bare path. */
  deletePath: (path: string) => Promise<void>;
  /** A URL the WebView can fetch for a file:// or content:// URI. */
  webUrl: (uri: string) => string;
  /** Read a share the old way, into memory (web, content:// fallback). */
  readBlob: (uri: string, mimeType: string) => Promise<Blob>;
  sendPickedBatch: typeof sendPickedBatch;
}

const realDeps: ShareSendDeps = {
  native: () => isNative,
  statPath: async (path) => {
    const { Filesystem } = await import("@capacitor/filesystem");
    return (await Filesystem.stat({ path })).size;
  },
  deletePath: async (path) => {
    const { Filesystem } = await import("@capacitor/filesystem");
    await Filesystem.deleteFile({ path });
  },
  webUrl: (uri) => Capacitor.convertFileSrc(uri),
  readBlob: readShareUriAsBlob,
  sendPickedBatch,
};

let deps: ShareSendDeps = realDeps;

/** Test hook (null restores the real dependencies). */
export function setShareSendDepsForTests(next: Partial<ShareSendDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
  liveCopies.clear();
}

/** The plugin names its copy after the shared item, so the same photo
 *  shared twice lands on the same path: delete it only when no send still
 *  holds it. */
const liveCopies = new Map<string, number>();

function holdCopy(path: string): void {
  liveCopies.set(path, (liveCopies.get(path) ?? 0) + 1);
}

async function releaseCopy(path: string): Promise<void> {
  const left = (liveCopies.get(path) ?? 1) - 1;
  if (left > 0) {
    liveCopies.set(path, left);
    return;
  }
  liveCopies.delete(path);
  await deps.deletePath(path).catch(() => { /* the cache is the OS's to clear */ });
}

/** A bare absolute path or file:// URI in our sandbox (not content://). */
function sandboxPathOf(uri: string): string | null {
  if (uri.startsWith("/")) return uri;
  if (uri.startsWith("file://")) {
    try {
      return decodeURI(uri.slice("file://".length));
    } catch {
      return uri.slice("file://".length);
    }
  }
  return null;
}

export interface SharedPicks {
  files: File[];
  unreadable: FileInfo[];
  /** How many are read natively (sourced), the rest are in memory. */
  native: number;
}

/** Turn the shared files into Files for the batch: sourced ones for the
 *  plugin's sandbox copies, in-memory ones otherwise. */
export async function sharedFilesToPicks(infos: readonly FileInfo[]): Promise<SharedPicks> {
  const d = deps;
  const files: File[] = [];
  const unreadable: FileInfo[] = [];
  let native = 0;
  for (const info of infos) {
    const mime = info.type || "application/octet-stream";
    const name = info.name || "shared_file";
    const path = d.native() ? sandboxPathOf(info.url) : null;
    if (path) {
      try {
        const size = await d.statPath(path);
        if (size > 0) {
          const uri = toNativeFileUri(path);
          holdCopy(path);
          const file = makeSourcedFile(name, mime, size, {
            kind: "share",
            uri,
            previewUrl: d.webUrl(uri),
            release: () => releaseCopy(path),
          });
          markPicked(file);
          files.push(file);
          native++;
          continue;
        }
      } catch {
        // Not readable natively: try the WebView below.
      }
    }
    try {
      const blob = await d.readBlob(info.url, mime);
      if (blob.size === 0) throw new Error("The shared file is empty");
      files.push(new File([blob], name, { type: mime }));
    } catch (e) {
      unreadable.push(info);
      logUpload("read:fail", null, { stage: "share", mime, name: fileLabel(name), err: describeError(e) });
    }
  }
  return { files, unreadable, native };
}

export interface ShareComposer {
  /** The share on the composer now (null when there is none). */
  current: () => ForwardingMessage | null;
  /** Take the share off the composer. */
  clear: () => void;
}

export interface ShareSenders {
  sendImage: (file: File, options: { caption?: string } & BatchSendContext) => Promise<boolean>;
  sendFile: (file: File, options: { caption?: string } & BatchSendContext) => Promise<boolean>;
  sendText: (text: string) => Promise<boolean>;
}

const isMedia = (f: File): boolean => /^(image|video)\//.test(f.type ?? "");

/** The key a share is claimed with: the intent's own, or its files. */
function keyOf(fwd: ForwardingMessage): string {
  if (fwd.shareKey) return fwd.shareKey;
  const files = fwd.externalFiles?.length ? fwd.externalFiles : fwd.fileInfo ? [fwd.fileInfo] : [];
  return shareKeyOf({ files: files.map((f) => ({ uri: f.url, name: f.name, mimeType: f.type })) });
}

/**
 * Send the share on the composer. Resolves false when nothing went out (the
 * caller then puts the typed text back), true once the batch is queued (a
 * single item: once it is sent). A second call while the share is being
 * sent, or for the same share again, does nothing and resolves undefined.
 *
 * The caption goes on the last photo/video, like a gallery pick; with
 * other files in the share it follows as its own message.
 */
export async function sendShareFromComposer(
  composer: ShareComposer,
  caption: string,
  senders: ShareSenders,
): Promise<boolean | undefined> {
  const fwd = composer.current();
  if (!fwd?.isExternalShare) return undefined;
  const infos = fwd.externalFiles?.length ? fwd.externalFiles : fwd.fileInfo ? [fwd.fileInfo] : [];
  if (!infos.length) return undefined;
  const key = keyOf(fwd);
  // Before anything slow: the Send button goes back to idle, and a second
  // tap (or the same intent again) finds the share gone or claimed.
  composer.clear();
  if (!claimShareSend(key)) {
    logUpload("share:dup", null, { n: infos.length });
    return undefined;
  }
  try {
    const picks = await sharedFilesToPicks(infos);
    logUpload("pick:share", null, {
      n: infos.length,
      src: "share",
      native: picks.native,
      memory: picks.files.length - picks.native,
      unreadable: picks.unreadable.length,
    });
    if (picks.unreadable.length) {
      const total = infos.length;
      const lost = picks.unreadable.length;
      reportSendError(new SendError(
        total > 1 ? "batchIncomplete" : "fileUnreadable",
        `${lost} of ${total} shared items could not be read`,
        { fileName: picks.unreadable[0].name, totalCount: total, failedCount: lost, unreadableCount: lost },
        false,
      ));
    }
    if (!picks.files.length) {
      releaseShareClaim(key);
      return false;
    }
    const trimmed = caption.trim();
    const allMedia = picks.files.every(isMedia);
    const run = deps.sendPickedBatch(
      picks.files,
      (f) => f,
      (_, f) => f,
      (f, _i, isLast, ctx) => {
        const opts = { ...(isLast && allMedia && trimmed ? { caption: trimmed } : {}), ...ctx };
        return (f.type ?? "").startsWith("image/") ? senders.sendImage(f, opts) : senders.sendFile(f, opts);
      },
    );
    const settled = run.then(async (outcome: BatchOutcome) => {
      if (outcome.sent > 0) finishShareSend(key);
      else releaseShareClaim(key);
      if (trimmed && !allMedia && outcome.sent > 0) await senders.sendText(trimmed);
      return outcome;
    }, (e: unknown) => {
      releaseShareClaim(key);
      throw e;
    });
    // A batch shows its progress in the batch bar; the composer is free.
    if (picks.files.length > 1) {
      settled.catch((e) => console.error("[share-send] batch failed:", e));
      return true;
    }
    const outcome = await settled;
    return outcome.sent > 0;
  } catch (e) {
    releaseShareClaim(key);
    throw e;
  }
}
