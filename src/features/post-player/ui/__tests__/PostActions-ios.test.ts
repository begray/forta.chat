// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

/** App Store rules: the PKOIN boost button is not offered in the iOS app. */

vi.mock("@/shared/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

async function mountWith(isPkoinWalletEnabled: boolean) {
  vi.resetModules();
  vi.doMock("@/shared/lib/platform", () => ({ isPkoinWalletEnabled }));
  const { default: PostActions } = await import("../PostActions.vue");
  return mount(PostActions, { props: { totalComments: 0, isOwnPost: false } });
}

describe("PostActions PKOIN boost", () => {
  beforeEach(() => {
    vi.doUnmock("@/shared/lib/platform");
  });

  it("is shown where the wallet is enabled", async () => {
    const w = await mountWith(true);
    expect(w.text()).toContain("PKOIN");
  });

  it("is hidden on iOS", async () => {
    const w = await mountWith(false);
    expect(w.text()).not.toContain("PKOIN");
  });
});
