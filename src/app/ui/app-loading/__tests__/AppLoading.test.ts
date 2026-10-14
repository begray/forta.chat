// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";

import { bootStatus } from "@/app/model/boot-status";
import { tRaw } from "@/shared/lib/i18n";
import AppLoading from "../AppLoading.vue";

describe("AppLoading", () => {
  afterEach(() => bootStatus.reset());

  it("keeps the spinner with an 'opening chats' label while it covers the ready app", () => {
    bootStatus.setReady();
    const wrapper = mount(AppLoading);

    expect(wrapper.find(".animate-spin").exists()).toBe(true);
    expect(wrapper.text()).toContain(tRaw("boot.openingChats"));
  });
});
