// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

vi.mock("@videojs/html/video/skin", () => ({}));
vi.mock("@videojs/html/video", () => ({ VideoSkinElement: class extends HTMLElement {} }));

import { retuneTouchGestures } from "./forta-video-skin";

/** The gesture layer of the packaged skin (template.js). */
function skinRoot(): ShadowRoot {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <media-gesture type="tap" action="togglePaused" pointer="mouse" region="center"></media-gesture>
    <media-gesture type="tap" action="toggleControls" pointer="touch"></media-gesture>
    <media-gesture type="doubletap" action="seekStep" region="left"></media-gesture>`;
  return root;
}

const touchTaps = (root: ShadowRoot) =>
  [...root.querySelectorAll('media-gesture[type="tap"][pointer="touch"]')].map((g) => ({
    action: g.getAttribute("action"),
    region: g.getAttribute("region"),
  }));

describe("retuneTouchGestures", () => {
  it("a touch tap in the middle plays / pauses, on the sides toggles the controls", () => {
    const root = skinRoot();
    retuneTouchGestures(root);
    expect(touchTaps(root)).toEqual([
      { action: "togglePaused", region: "center" },
      { action: "toggleControls", region: "left" },
      { action: "toggleControls", region: "right" },
    ]);
  });

  it("leaves the mouse tap and double taps alone", () => {
    const root = skinRoot();
    retuneTouchGestures(root);
    expect(root.querySelector('media-gesture[pointer="mouse"]')?.getAttribute("action")).toBe("togglePaused");
    expect(root.querySelectorAll('media-gesture[type="doubletap"]')).toHaveLength(1);
  });
});
