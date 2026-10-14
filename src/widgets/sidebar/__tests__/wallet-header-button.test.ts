// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
}));

import WalletHeaderButton from "../ui/WalletHeaderButton.vue";

const logo = (w: ReturnType<typeof mount>) => w.get('[data-testid="wallet-logo"]');

describe("WalletHeaderButton", () => {
  it("keeps the last balance visible while refreshing and spins the logo", async () => {
    const wrapper = mount(WalletHeaderButton, { props: { balance: 1037.1, isLoading: false, hasError: false } });
    expect(logo(wrapper).classes()).not.toContain("animate-spin");

    await wrapper.setProps({ isLoading: true, hasError: false });

    expect(wrapper.text()).toContain("1037.10");
    expect(wrapper.text()).not.toContain("...");
    expect(logo(wrapper).classes()).toContain("animate-spin");
    expect(logo(wrapper).classes()).toContain("contain-strict");
  });

  it("finishes the current turn before stopping", async () => {
    const wrapper = mount(WalletHeaderButton, { props: { balance: 5, isLoading: true, hasError: false } });

    await wrapper.setProps({ isLoading: false, hasError: false });
    expect(logo(wrapper).classes()).toContain("animate-spin");

    await logo(wrapper).trigger("animationiteration");
    expect(logo(wrapper).classes()).not.toContain("animate-spin");
  });

  it("keeps spinning across turns while still loading", async () => {
    const wrapper = mount(WalletHeaderButton, { props: { balance: null, isLoading: true, hasError: false } });

    await logo(wrapper).trigger("animationiteration");

    expect(logo(wrapper).classes()).toContain("animate-spin");
    expect(wrapper.text()).toBe("");
  });

  it("emits refresh on click", async () => {
    const wrapper = mount(WalletHeaderButton, { props: { balance: 1, isLoading: false, hasError: false } });
    await wrapper.trigger("click");
    expect(wrapper.emitted("refresh")).toHaveLength(1);
  });

  it("turns the logo red after a failed request", async () => {
    const wrapper = mount(WalletHeaderButton, { props: { balance: 5, isLoading: false, hasError: false } });
    expect(logo(wrapper).classes()).not.toContain("text-color-bad");

    await wrapper.setProps({ hasError: true });

    expect(logo(wrapper).classes()).toContain("text-color-bad");
    expect(wrapper.text()).toContain("5.00");
  });
});
