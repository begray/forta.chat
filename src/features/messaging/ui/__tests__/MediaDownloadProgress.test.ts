// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "en" } }),
}));

const { default: MediaDownloadProgress } = await import("../MediaDownloadProgress.vue");

describe("MediaDownloadProgress", () => {
  it("draws a determinate ring for the download percent and shows the caption", () => {
    const w = mount(MediaDownloadProgress, {
      props: { phase: "download", progress: 50, caption: "12.0 MB / 24.0 MB", cancellable: true },
    });
    const ring = w.findAll("circle")[1];
    expect(Number(ring.attributes("stroke-dashoffset"))).toBeCloseTo(94.25 / 2, 1);
    expect(w.find("svg").classes()).not.toContain("animate-spin");
    expect(w.text()).toContain("12.0 MB / 24.0 MB");
  });

  it("spins while the size is unknown and still lets the user cancel", async () => {
    const w = mount(MediaDownloadProgress, {
      props: { phase: "download", progress: null, caption: "", cancellable: true },
    });
    expect(w.find("svg").classes()).toContain("animate-spin");
    await w.find("button").trigger("click");
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("shows the ring without a cancel when nothing here can abort the download", async () => {
    // Regression: a download started by another consumer showed a cross that
    // did nothing when tapped.
    const w = mount(MediaDownloadProgress, {
      props: { phase: "download", progress: 30, caption: "", cancellable: false },
    });
    expect(w.find("button").exists()).toBe(false);
    expect(w.findAll("circle")).toHaveLength(2);
    await w.find("div div").trigger("click");
    expect(w.emitted("cancel")).toBeUndefined();
  });

  it("offers no cancel during decryption, which cannot be interrupted", () => {
    const w = mount(MediaDownloadProgress, {
      props: { phase: "decrypt", progress: null, caption: "message.decrypting", cancellable: true },
    });
    expect(w.find("button").exists()).toBe(false);
    expect(w.text()).toContain("message.decrypting");
  });
});
