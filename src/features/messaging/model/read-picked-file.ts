import { withTimeout } from "@/shared/lib/with-timeout";
import { fileSourceOf, readSourcedFile } from "./picked-media";

/** Reading a picked file must not hang a send forever: a cloud item the
 *  provider cannot fetch may never settle. 30 s, or 512 KB/s for big files. */
const FILE_READ_MIN_TIMEOUT_MS = 30_000;
const FILE_READ_MIN_BYTES_PER_SEC = 512 * 1024;

/** Read a picked File fully into memory before anything is shown.
 *  On Android the picker hands over content:// backed Files that the WebView
 *  reads lazily. A cloud item (e.g. Google Photos) or an expired grant then
 *  failed only when IndexedDB copied the bytes — after the bubble was already
 *  on screen, leaving it "sending" forever. Reading up front turns that into
 *  an immediate error, and the preview and the persisted copy come from
 *  memory instead of the provider. */
export async function readPickedFile(file: File): Promise<File> {
  const timeoutMs = Math.max(FILE_READ_MIN_TIMEOUT_MS, (file.size / FILE_READ_MIN_BYTES_PER_SEC) * 1000);
  // Native picks carry no bytes of their own: load them from our copy (or
  // the pinned provider URI of a big video that was not compressed).
  const source = fileSourceOf(file);
  if (source) {
    const read = await withTimeout(readSourcedFile(file, source), timeoutMs, "Reading the file");
    if (read.size === 0) throw new Error(`The file is empty (reported size ${file.size})`);
    return read;
  }
  const bytes = await withTimeout(file.arrayBuffer(), timeoutMs, "Reading the file");
  if (bytes.byteLength === 0) throw new Error(`The file is empty (reported size ${file.size})`);
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}

/** Errors IndexedDB / the WebView raise when a File's bytes cannot be read. */
export function isUnreadableFileError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  const inner = (e as { inner?: { name?: string } } | null)?.inner?.name ?? "";
  return [name, inner].some((n) => n === "NotReadableError" || n === "NotFoundError" || n === "UnknownError" || n === "DataCloneError");
}
