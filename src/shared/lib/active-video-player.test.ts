// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  bindMediaElement,
  claimActivePlayer,
  _resetActivePlayer,
} from "./active-video-player";

/** A page <video> that reports itself playing, with a spied pause(). */
function pageVideo(opts: { muted?: boolean } = {}) {
  const video = document.createElement("video");
  video.muted = opts.muted ?? false;
  let paused = true;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
  });
  document.body.appendChild(video);
  const start = () => {
    paused = false;
    video.dispatchEvent(new Event("play"));
  };
  return { video, pause, start };
}

beforeEach(() => {
  _resetActivePlayer();
  document.body.innerHTML = "";
});

describe("one sound at a time", () => {
  it("a video starting pauses the video that was playing", () => {
    const a = pageVideo();
    const b = pageVideo();
    a.start();
    b.start();
    expect(a.pause).toHaveBeenCalled();
    expect(b.pause).not.toHaveBeenCalled();
  });

  it("a video starting pauses a player outside the DOM (voice)", () => {
    const voice = { pause: vi.fn() };
    claimActivePlayer(voice);
    pageVideo().start();
    expect(voice.pause).toHaveBeenCalled();
  });

  it("the voice starting pauses a playing video", () => {
    const v = pageVideo();
    v.start();
    claimActivePlayer({ pause: vi.fn() });
    expect(v.pause).toHaveBeenCalled();
  });

  it("a muted autoplay preview does not pause anything", () => {
    const a = pageVideo();
    a.start();
    pageVideo({ muted: true }).start();
    expect(a.pause).not.toHaveBeenCalled();
  });

  it("unmuting a playing video circle takes the slot", () => {
    const a = pageVideo();
    a.start();
    const circle = pageVideo({ muted: true });
    circle.start();
    circle.video.muted = false;
    circle.video.dispatchEvent(new Event("volumechange"));
    expect(a.pause).toHaveBeenCalled();
  });

  it("a live call stream is never paused and never pauses others", () => {
    const call = pageVideo();
    Object.defineProperty(call.video, "srcObject", { configurable: true, value: new MediaStream() });
    call.start();
    const v = pageVideo();
    v.start();
    expect(call.pause).not.toHaveBeenCalled();
  });

  it("custom media elements (Video.js <hls-video>) count too", () => {
    const a = pageVideo();
    a.start();
    const host = document.createElement("hls-video");
    Object.assign(host, { muted: false, volume: 1, paused: false, pause: vi.fn() });
    document.body.appendChild(host);
    host.dispatchEvent(new Event("play"));
    expect(a.pause).toHaveBeenCalled();
  });

  it("a bound element is paused through its player's own handle", () => {
    const feed = pageVideo();
    const handle = { pause: vi.fn() };
    bindMediaElement(feed.video, handle);
    feed.start();
    // Claiming the same handle again (the player's own claim) is a no-op.
    claimActivePlayer(handle);
    expect(handle.pause).not.toHaveBeenCalled();

    pageVideo().start();
    expect(handle.pause).toHaveBeenCalled();
    expect(feed.pause).not.toHaveBeenCalled();
  });

  it("a paused video no longer holds the slot", () => {
    const a = pageVideo();
    a.start();
    a.video.dispatchEvent(new Event("pause"));
    const voice = { pause: vi.fn() };
    claimActivePlayer(voice);
    expect(a.pause).not.toHaveBeenCalled();
  });
});
