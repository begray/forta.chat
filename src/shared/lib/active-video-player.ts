/**
 * One sound at a time across the app: a video or audio that starts playing
 * audibly pauses whatever played before it.
 *
 * - Page media (`<video>`, `<audio>`, and custom media elements such as
 *   Video.js `<hls-video>`, which re-dispatch their media events on the host)
 *   are picked up by a document-level listener — no wiring per component.
 *   Media events don't bubble, hence the capture phase.
 * - Players outside the DOM (the voice message `<audio>`) call
 *   `claimActivePlayer` themselves.
 * - A player that keeps its own state around the element (FeedVideoPlayer)
 *   binds the element to its handle, so it's paused through its own code.
 * - Muted media (autoplaying previews, video circles before unmute) never
 *   count. Live call streams (`srcObject` = MediaStream) are left alone:
 *   pausing them would cut the call's sound.
 */
export interface ActiveVideoPlayer {
  pause: () => void;
}

let activePlayer: ActiveVideoPlayer | null = null;

export function claimActivePlayer(player: ActiveVideoPlayer): void {
  if (activePlayer && activePlayer !== player) {
    activePlayer.pause();
  }
  activePlayer = player;
}

export function releaseActivePlayer(player: ActiveVideoPlayer): void {
  if (activePlayer === player) {
    activePlayer = null;
  }
}

/** Exported for test cleanup only. */
export function _resetActivePlayer(): void {
  activePlayer = null;
}

// ── Page media ──

export interface MediaLike {
  muted: boolean;
  volume: number;
  paused: boolean;
  pause: () => void;
}

/** A media element, or a custom element that behaves like one. */
export function asMediaLike(target: EventTarget | null): (Element & MediaLike) | null {
  if (typeof HTMLMediaElement !== "undefined" && target instanceof HTMLMediaElement) return target;
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return null;
  const m = target as HTMLElement & Partial<MediaLike>;
  return typeof m.muted === "boolean"
    && typeof m.volume === "number"
    && typeof m.paused === "boolean"
    && typeof m.pause === "function"
    ? (m as HTMLElement & MediaLike)
    : null;
}

function isLiveStream(el: Element): boolean {
  const src = (el as Partial<HTMLMediaElement>).srcObject;
  return typeof MediaStream !== "undefined" && src instanceof MediaStream;
}

const boundHandles = new WeakMap<Element, ActiveVideoPlayer>();
const elementHandles = new WeakMap<Element, ActiveVideoPlayer>();

/** Route this element through the player's own handle. Returns an unbind. */
export function bindMediaElement(el: Element, player: ActiveVideoPlayer): () => void {
  boundHandles.set(el, player);
  return () => {
    if (boundHandles.get(el) === player) boundHandles.delete(el);
  };
}

function handleFor(el: Element & MediaLike): ActiveVideoPlayer {
  const bound = boundHandles.get(el);
  if (bound) return bound;
  let handle = elementHandles.get(el);
  if (!handle) {
    handle = { pause: () => el.pause() };
    elementHandles.set(el, handle);
  }
  return handle;
}

function onMediaEvent(e: Event): void {
  const el = asMediaLike(e.target);
  if (!el || isLiveStream(el)) return;
  if (el.muted || el.volume === 0) return;
  // Unmuting a paused element doesn't make sound yet.
  if (e.type === "volumechange" && el.paused) return;
  claimActivePlayer(handleFor(el));
}

function onMediaStop(e: Event): void {
  const el = asMediaLike(e.target);
  if (!el) return;
  const handle = boundHandles.get(el) ?? elementHandles.get(el);
  if (handle) releaseActivePlayer(handle);
}

if (typeof document !== "undefined") {
  document.addEventListener("play", onMediaEvent, true);
  document.addEventListener("volumechange", onMediaEvent, true);
  document.addEventListener("pause", onMediaStop, true);
  document.addEventListener("ended", onMediaStop, true);
}
