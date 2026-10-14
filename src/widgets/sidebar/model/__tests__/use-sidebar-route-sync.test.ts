// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createRouter, createWebHashHistory, RouterView, type Router } from "vue-router";
import {
  buildSidebarQuery,
  parseSidebarQuery,
  sidebarDepth,
  useSidebarRouteSync,
} from "../use-sidebar-route-sync";
import { useSidebarTab } from "../use-sidebar-tab";

describe("parseSidebarQuery", () => {
  it("defaults to chats without a section", () => {
    expect(parseSidebarQuery({})).toEqual({ tab: "chats", section: null });
  });

  it("reads tab and section", () => {
    expect(parseSidebarQuery({ tab: "settings", section: "profile" })).toEqual({ tab: "settings", section: "profile" });
    expect(parseSidebarQuery({ tab: "contacts" })).toEqual({ tab: "contacts", section: null });
  });

  it("ignores unknown values and a section outside settings", () => {
    expect(parseSidebarQuery({ tab: "bogus" })).toEqual({ tab: "chats", section: null });
    expect(parseSidebarQuery({ tab: "settings", section: "bogus" })).toEqual({ tab: "settings", section: null });
    expect(parseSidebarQuery({ tab: "contacts", section: "profile" })).toEqual({ tab: "contacts", section: null });
  });
});

describe("buildSidebarQuery", () => {
  it("drops the keys for chats and keeps foreign keys", () => {
    expect(buildSidebarQuery({ tab: "settings", section: "about", x: "1" }, { tab: "chats", section: null })).toEqual({ x: "1" });
  });

  it("writes tab and section", () => {
    expect(buildSidebarQuery({}, { tab: "settings", section: "storage" })).toEqual({ tab: "settings", section: "storage" });
  });
});

describe("sidebarDepth", () => {
  it("orders chats < tab < section", () => {
    expect(sidebarDepth({ tab: "chats", section: null })).toBe(0);
    expect(sidebarDepth({ tab: "contacts", section: null })).toBe(1);
    expect(sidebarDepth({ tab: "settings", section: "profile" })).toBe(2);
  });
});

describe("useSidebarRouteSync", () => {
  let router: Router;
  let wrapper: VueWrapper | null = null;
  const { activeTab, settingsSubView, setTab, openSettingsContent, closeSettingsContent } = useSidebarTab();

  const ChatPageStub = defineComponent({
    setup() {
      useSidebarRouteSync();
      return () => h("div");
    },
  });

  /** Waits for a popstate-driven navigation (router.back) to land. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await flushPromises();
    }
  };

  const mountAt = async (path: string) => {
    window.location.hash = "";
    router = createRouter({
      history: createWebHashHistory(),
      routes: [
        { path: "/chat", name: "ChatPage", component: ChatPageStub },
        { path: "/other", name: "Other", component: { render: () => h("div") } },
      ],
    });
    await router.push(path);
    await router.isReady();
    wrapper = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] } });
    await flushPromises();
  };

  beforeEach(() => {
    activeTab.value = "chats";
    settingsSubView.value = null;
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("restores the tab and section from the URL", async () => {
    await mountAt("/chat?tab=settings&section=appearance");
    expect(activeTab.value).toBe("settings");
    expect(settingsSubView.value).toBe("appearance");
  });

  it("opening Settings and a section adds history entries", async () => {
    await mountAt("/chat");
    setTab("settings");
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/chat?tab=settings");

    openSettingsContent("profile");
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/chat?tab=settings&section=profile");
  });

  it("browser Back walks section -> Settings -> Chats without leaving the page", async () => {
    await mountAt("/chat");
    setTab("settings");
    await settle();
    openSettingsContent("profile");
    await settle();

    router.back();
    await settle();
    expect(router.currentRoute.value.name).toBe("ChatPage");
    expect(activeTab.value).toBe("settings");
    expect(settingsSubView.value).toBeNull();

    router.back();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/chat");
    expect(activeTab.value).toBe("chats");
  });

  it("browser Back from Contacts returns to Chats", async () => {
    await mountAt("/chat");
    setTab("contacts");
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/chat?tab=contacts");

    router.back();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/chat");
    expect(activeTab.value).toBe("chats");
  });

  it("closing a section in the UI pops its history entry instead of stacking one", async () => {
    await mountAt("/chat");
    setTab("settings");
    await settle();
    openSettingsContent("storage");
    await settle();
    const lengthWithSection = window.history.length;

    closeSettingsContent();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/chat?tab=settings");
    expect(router.options.history.state.back).toBe("/chat");
    expect(window.history.length).toBe(lengthWithSection);
  });

  it("switching between Contacts and Settings replaces the entry", async () => {
    await mountAt("/chat");
    setTab("contacts");
    await settle();
    setTab("settings");
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/chat?tab=settings");
    expect(router.options.history.state.back).toBe("/chat");
  });
});
