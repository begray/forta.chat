// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";

import { APP_REVEAL_DELAY_MS, revealApp } from "./reveal-app";

const Main = defineComponent({ render: () => h("div", { id: "main-ui" }, "chats") });
const Loader = defineComponent({ render: () => h("div", { id: "loader-ui" }, "loading") });

describe("revealApp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"><div id="appLoading"></div></div>';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the boot loader over the mounted app, then removes it after the delay", () => {
    const loadingApp = createApp(Loader);
    loadingApp.mount("#appLoading");

    revealApp(createApp(Main), loadingApp);

    // Mounting into #app must not wipe the loader: it now lives on <body>, above the app.
    expect(document.getElementById("main-ui")).not.toBeNull();
    const loader = document.getElementById("appLoading");
    expect(loader?.parentElement).toBe(document.body);
    expect(loader?.style.zIndex).toBe("100000");
    expect(document.getElementById("loader-ui")).not.toBeNull();

    vi.advanceTimersByTime(APP_REVEAL_DELAY_MS - 1);
    expect(document.getElementById("appLoading")).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(document.getElementById("appLoading")).toBeNull();
    expect(document.getElementById("main-ui")).not.toBeNull();
  });

  it("unmounts the loader app when it is removed", () => {
    const loadingApp = createApp(Loader);
    loadingApp.mount("#appLoading");
    const unmount = vi.spyOn(loadingApp, "unmount");

    revealApp(createApp(Main), loadingApp, 10);
    vi.advanceTimersByTime(10);

    expect(unmount).toHaveBeenCalledTimes(1);
  });
});
