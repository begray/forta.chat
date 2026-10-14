// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const back = vi.hoisted(() => ({ handlers: [] as Array<() => boolean> }));
vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({
  useAndroidBackHandler: (_id: string, _priority: number, fn: () => boolean) => back.handlers.push(fn),
}));

import VideoJsFrame from "../VideoJsFrame.vue";

function setFullscreen(el: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => el });
}

beforeEach(() => {
  setActivePinia(createPinia());
  back.handlers = [];
  document.exitFullscreen = vi.fn(() => Promise.resolve());
});

afterEach(() => {
  setFullscreen(null);
});

describe("VideoJsFrame", () => {
  it("wraps the media in the language provider, player and our skin", () => {
    const wrapper = mount(VideoJsFrame, { slots: { default: "<video data-testid='media' />" } });
    expect(wrapper.find("media-i18n video-player forta-video-skin [data-testid='media']").exists()).toBe(true);
  });

  it("disabled renders the media alone (native controls)", () => {
    const wrapper = mount(VideoJsFrame, {
      props: { enabled: false },
      slots: { default: "<video data-testid='media' />" },
    });
    expect(wrapper.find("[data-testid='media']").exists()).toBe(true);
    expect(wrapper.find("video-player").exists()).toBe(false);
  });

  it("Android back leaves this player's fullscreen", () => {
    const wrapper = mount(VideoJsFrame, { attachTo: document.body });
    setFullscreen(wrapper.find("forta-video-skin").element);
    expect(back.handlers[0]()).toBe(true);
    expect(document.exitFullscreen).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("Android back passes through when this player is not fullscreen", () => {
    const wrapper = mount(VideoJsFrame, { attachTo: document.body });
    expect(back.handlers[0]()).toBe(false);
    setFullscreen(document.createElement("div"));
    expect(back.handlers[0]()).toBe(false);
    expect(document.exitFullscreen).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
