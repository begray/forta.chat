// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

const routerReplace = vi.fn(async () => {});
vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: routerReplace }),
}));

const toast = vi.fn();
vi.mock("@/shared/lib/use-toast", () => ({ useToast: () => ({ toast }) }));

const deleteAccount = vi.fn();
vi.mock("@/entities/auth", () => ({ useAuthStore: () => ({ deleteAccount }) }));

import DeleteAccountButton from "../delete-account-button/DeleteAccountButton.vue";
import { DeleteAccountError } from "@/entities/auth/lib/delete-account";

enableAutoUnmount(afterEach);

const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("DeleteAccountButton", () => {
  beforeEach(() => {
    deleteAccount.mockReset();
    routerReplace.mockClear();
    toast.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("asks before deleting and does nothing on cancel", async () => {
    const w = mount(DeleteAccountButton, { attachTo: document.body });
    await w.find("button").trigger("click");
    expect(q("delete-account-confirm")?.textContent).toContain("settings.deleteAccount.question");
    q("delete-account-cancel")!.click();
    await flushPromises();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(q("delete-account-confirm")).toBeNull();
  });

  it("shows each step, then the success message and the welcome page", async () => {
    let finish!: () => void;
    deleteAccount.mockImplementation((onProgress: (s: string) => void) => new Promise<void>((resolve) => {
      onProgress("removeMatrix");
      finish = resolve;
    }));
    const w = mount(DeleteAccountButton, { attachTo: document.body });
    await w.find("button").trigger("click");
    q("delete-account-yes")!.click();
    await flushPromises();
    expect(q("delete-account-progress")?.textContent).toContain("settings.deleteAccount.step.removeMatrix");

    finish();
    await flushPromises();
    expect(q("delete-account-progress")).toBeNull();
    expect(toast).toHaveBeenCalledWith("settings.deleteAccount.success", "success", 8000);
    expect(routerReplace).toHaveBeenCalledWith({ name: "WelcomePage" });
  });

  it("shows the Pocketnet error text for a failed deletion and stays on the page", async () => {
    deleteAccount.mockRejectedValue(new DeleteAccountError("balance"));
    const w = mount(DeleteAccountButton, { attachTo: document.body });
    await w.find("button").trigger("click");
    q("delete-account-yes")!.click();
    await flushPromises();
    expect(q("delete-account-error")?.textContent).toContain("settings.deleteAccount.error.balance");
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
