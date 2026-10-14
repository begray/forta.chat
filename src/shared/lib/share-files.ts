import { sanitizeFileName } from "@/shared/lib/file-name-sanitizer";

/** Cache sub-directory holding files handed to other apps via the share sheet. */
export const SHARE_OUT_DIR = "share-out";

/** Bytes per bridge call. A whole video as one base64 string (~1.33× its
 *  size) runs old Android WebViews out of memory; 3 MiB chunks keep every
 *  call small. A multiple of 3, so each chunk is self-contained base64. */
export const SHARE_CHUNK_BYTES = 3 * 1024 * 1024;

/** Batches older than this are deleted on the next share. The receiving app
 *  reads the file after the share sheet closes, so it can't be removed at once. */
export const SHARE_FILE_TTL_MS = 60 * 60 * 1000;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "application/pdf": "pdf",
};

/** A safe file name with an extension — receiving apps pick the handler by it. */
export function shareFileName(name: string | undefined, mimeType: string, index: number): string {
  const safe = name ? sanitizeFileName(name) : "";
  const base = safe && safe !== "file" ? safe : `file-${index + 1}`;
  if (/\.[a-z0-9]{1,5}$/i.test(base)) return base;
  const ext = EXTENSION_BY_MIME[mimeType.split(";")[0].trim().toLowerCase()];
  return ext ? `${base}.${ext}` : base;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Delete share batches older than {@link SHARE_FILE_TTL_MS}. Best effort. */
export async function purgeOldShareFiles(now = Date.now()): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  let entries: { name: string }[];
  try {
    entries = (await Filesystem.readdir({ path: SHARE_OUT_DIR, directory: Directory.Cache })).files;
  } catch {
    return; // nothing shared yet
  }
  for (const entry of entries) {
    const createdAt = Number(entry.name);
    if (Number.isFinite(createdAt) && now - createdAt < SHARE_FILE_TTL_MS) continue;
    try {
      await Filesystem.rmdir({ path: `${SHARE_OUT_DIR}/${entry.name}`, directory: Directory.Cache, recursive: true });
    } catch (e) {
      console.warn("[shareFiles] purge failed:", entry.name, e);
    }
  }
}

export interface ShareFileInput {
  blob: Blob;
  name?: string;
  mimeType: string;
}

/** Write files into a fresh cache batch, chunk by chunk, and return their
 *  native URIs for `Share.share({ files })`. Native only. */
export async function writeShareFiles(inputs: ShareFileInput[], now = Date.now()): Promise<string[]> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  await purgeOldShareFiles(now);
  const batchDir = `${SHARE_OUT_DIR}/${now}`;
  const usedNames = new Set<string>();
  const uris: string[] = [];
  for (const [index, input] of inputs.entries()) {
    let name = shareFileName(input.name, input.mimeType, index);
    // Several "image.jpg" in one batch must not overwrite each other.
    if (usedNames.has(name)) name = `${index + 1}-${name}`;
    usedNames.add(name);
    const path = `${batchDir}/${name}`;

    const { blob } = input;
    let offset = 0;
    do {
      const data = await blobToBase64(blob.slice(offset, offset + SHARE_CHUNK_BYTES));
      if (offset === 0) {
        await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
      } else {
        await Filesystem.appendFile({ path, data, directory: Directory.Cache });
      }
      offset += SHARE_CHUNK_BYTES;
    } while (offset < blob.size);

    uris.push((await Filesystem.getUri({ path, directory: Directory.Cache })).uri);
  }
  return uris;
}
