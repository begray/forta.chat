// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { reactive } from "vue";

const authStore = reactive({ isLoggingIn: false, login: vi.fn() });
vi.mock("@/entities/auth", () => ({ useAuthStore: () => authStore }));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: { value: "en" } }),
}));
vi.mock("@/shared/lib/platform", () => ({ isNative: false }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { default: LoginForm } = await import("../LoginForm.vue");

// Regression: the accent Spinner was invisible on the accent button and,
// being in the flow, pushed the "Signing in..." label off center.
describe("LoginForm sign-in button", () => {
  it("shows a spinner out of the flow, in the button's text color", async () => {
    const w = mount(LoginForm, { global: { stubs: { PrivateKeyInput: true } } });
    const button = w.find('button[type="submit"]');
    expect(button.find('[data-testid="login-spinner"]').exists()).toBe(false);

    authStore.isLoggingIn = true;
    await w.vm.$nextTick();
    const spinner = button.find('[data-testid="login-spinner"]');
    expect(spinner.classes()).toEqual(expect.arrayContaining(["absolute", "right-full", "border-current"]));
    expect(button.text()).toBe("auth.signingIn");
    // animate-spin overwrites `transform`; a translate there bobs the spinner.
    expect(spinner.classes().some((c) => c.includes("translate"))).toBe(false);
    expect(spinner.classes()).toEqual(expect.arrayContaining(["inset-y-0", "my-auto"]));
  });
});
