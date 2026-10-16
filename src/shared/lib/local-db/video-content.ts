/**
 * The thumbnail part of an m.video event's `info`.
 *
 * Matrix puts a video's poster frame in `info.thumbnail_url` (plain rooms) or
 * `info.thumbnail_file` (encrypted rooms), with `info.thumbnail_info`
 * { w, h, mimetype, size }. Forta encrypts media with Bastyon's scheme
 * (`secrets` { block, keys, v }, the same shape as `info.secrets` on the
 * video itself), not Matrix's AES-CTR EncryptedFile, so an encrypted
 * thumbnail goes out as `thumbnail_file: { url, secrets, mimetype }` and
 * never as a bare `thumbnail_url`: other clients would show ciphertext.
 */

export interface VideoThumbnailRef {
  url: string;
  /** Bastyon secrets when the thumbnail was encrypted. */
  secrets?: Record<string, unknown>;
  info: { w: number; h: number; mimetype: string; size: number };
}

/** `info` with the thumbnail fields added (a copy); unchanged without one. */
export function withVideoThumbnail<T extends Record<string, unknown>>(
  info: T,
  thumb: VideoThumbnailRef | null | undefined,
): T & Record<string, unknown> {
  if (!thumb?.url) return { ...info };
  if (thumb.secrets) {
    return {
      ...info,
      thumbnail_file: { url: thumb.url, secrets: thumb.secrets, mimetype: thumb.info.mimetype },
      thumbnail_info: { ...thumb.info },
    };
  }
  return { ...info, thumbnail_url: thumb.url, thumbnail_info: { ...thumb.info } };
}
