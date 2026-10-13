// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { canUseModernPlayer, _resetModernPlayerSupport } from "./video-player-support";

const MODERN_CSS = new Set(["selector(:has(a))", "container-type: inline-size", "color oklch(0 0 0)"]);

function stubCss(missing?: string) {
  vi.stubGlobal("CSS", {
    supports: (a: string, b?: string) => {
      const q = b === undefined ? a : `${a} ${b}`;
      return MODERN_CSS.has(q) && q !== missing;
    },
  });
}

beforeEach(() => {
  _resetModernPlayerSupport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canUseModernPlayer", () => {
  it("a current WebView with MSE gets the HLS player", () => {
    stubCss();
    vi.stubGlobal("MediaSource", function MediaSource() {});
    expect(canUseModernPlayer()).toBe(true);
  });

  it.each([...MODERN_CSS])("an engine without `%s` keeps the plain player", (feature) => {
    stubCss(feature);
    vi.stubGlobal("MediaSource", function MediaSource() {});
    expect(canUseModernPlayer()).toBe(false);
  });

  it("an engine without CSS.supports keeps the plain player", () => {
    vi.stubGlobal("CSS", undefined);
    expect(canUseModernPlayer()).toBe(false);
  });

  it("without MSE, native HLS (Safari / WKWebView) is enough", () => {
    stubCss();
    vi.stubGlobal("MediaSource", undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    expect(canUseModernPlayer()).toBe(true);
  });

  it("neither MSE nor native HLS keeps the plain player", () => {
    stubCss();
    vi.stubGlobal("MediaSource", undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    expect(canUseModernPlayer()).toBe(false);
  });

  it("an engine without constructable stylesheets keeps the plain player", () => {
    stubCss();
    vi.stubGlobal("MediaSource", function MediaSource() {});
    Object.defineProperty(document, "adoptedStyleSheets", { configurable: true, value: undefined });
    try {
      expect(canUseModernPlayer()).toBe(false);
    } finally {
      delete (document as unknown as Record<string, unknown>).adoptedStyleSheets;
    }
  });

  it("probes once per session", () => {
    stubCss();
    vi.stubGlobal("MediaSource", function MediaSource() {});
    const supports = vi.spyOn(window.CSS, "supports");
    canUseModernPlayer();
    canUseModernPlayer();
    expect(supports).toHaveBeenCalledTimes(3);
  });
});
