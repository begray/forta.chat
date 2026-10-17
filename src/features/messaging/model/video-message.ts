/**
 * Gallery videos go out as m.video, not m.file.
 *
 * Upstream (4c4a51e7) sends every picked file, videos included, as an m.file
 * whose body is JSON {name, type, size}. Recipients then have no duration,
 * no dimensions and no poster: the bubble is a grey box with a play button
 * and the raw file name (often a UUID) as its caption, and other Matrix
 * clients show a generic file. Video notes (circles) were the only m.video.
 */
import { videoBodyName } from "./media-name";

/** What we know about a video when it is sent. Display dimensions (rotation
 *  applied); duration in ms. */
export interface VideoFacts {
  w?: number;
  h?: number;
  durationMs?: number;
}

export interface VideoSendPayload {
  msgtype: "m.video";
  body: string;
  eventInfo: Record<string, unknown>;
}

function positiveInt(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** The op payload fields for an m.video send (syncSendFile adds the url,
 *  secrets and thumbnail). Unknown facts are left out, not sent as 0. */
export function buildVideoSendPayload(file: { name: string; size: number }, mime: string, facts: VideoFacts): VideoSendPayload {
  const info: Record<string, unknown> = { mimetype: mime, size: Math.round(file.size) };
  const w = positiveInt(facts.w);
  const h = positiveInt(facts.h);
  if (w && h) {
    info.w = w;
    info.h = h;
  }
  const duration = positiveInt(facts.durationMs);
  if (duration) info.duration = duration;
  return { msgtype: "m.video", body: videoBodyName(file.name), eventInfo: info };
}
