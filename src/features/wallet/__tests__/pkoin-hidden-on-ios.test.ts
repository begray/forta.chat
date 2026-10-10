import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * App Store rules: the iOS app shows no PKOIN wallet (balance, sending), but
 * the wallet keeps working in the background — balances still load for
 * account deletion and fees. So the gate `isPkoinWalletEnabled` sits on the
 * display points only, never on the store.
 *
 * Source-level checks: the sidebar, settings and chat window are too large to
 * mount here (same approach as the MessageBubble watchdog tests).
 */
const src = (rel: string) => readFileSync(resolve(__dirname, "../../..", rel), "utf-8");

describe("PKOIN wallet hidden on iOS", () => {
  it.each([
    ["widgets/sidebar/ChatSidebar.vue", 'v-if="walletStore.isAvailable && isPkoinWalletEnabled"'],
    ["widgets/sidebar/ui/SettingsPanel.vue", 'v-if="walletStore.isAvailable && isPkoinWalletEnabled"'],
    ["widgets/chat-window/ChatWindow.vue", "walletStore.isAvailable && isPkoinWalletEnabled"],
    ["features/post-player/ui/PostCard.vue", 'v-if="!isOwnPost && isPkoinWalletEnabled"'],
    ["features/post-player/ui/PostActions.vue", 'v-if="!isOwnPost && isPkoinWalletEnabled"'],
  ])("%s gates its PKOIN UI on isPkoinWalletEnabled", (file, gate) => {
    expect(src(file)).toContain(gate);
  });

  it("does not stop the wallet itself: the store keeps loading balances", () => {
    expect(src("features/wallet/model/wallet-store.ts")).not.toContain("isPkoinWalletEnabled");
  });
});
