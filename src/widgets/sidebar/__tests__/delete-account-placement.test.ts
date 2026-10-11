import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf-8");

// "Delete account" sits inside My Profile, not on the top-level Settings list
// next to Logout, where it was one tap away from an irreversible action.
describe("Delete account placement", () => {
  it("is not on the top-level Settings list", () => {
    expect(read("ui/SettingsPanel.vue")).not.toContain("DeleteAccountButton");
  });

  it("is inside the profile section", () => {
    const src = read("ui/SettingsContentPanel.vue");
    const profileBlock = src.slice(
      src.indexOf("settingsSubView === 'profile'"),
      src.indexOf("settingsSubView === 'callMethods'"),
    );
    expect(profileBlock).toContain("<DeleteAccountButton />");
  });
});
