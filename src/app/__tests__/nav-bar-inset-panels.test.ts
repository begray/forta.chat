import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Full-screen mobile panels that reach the bottom edge must clear the Android
 * nav bar themselves: MainActivity is edge-to-edge and the chat route is not
 * wrapped in MainLayout's `.safe-bottom`, so each panel pads its own scroll
 * area. "Delete account" at the end of My Profile sat under the nav bar.
 *
 * Panels that hold a text field use the keyboard-aware `.safe-bottom` /
 * `.safe-y`; the rest use `.pb-safe` (see keyboard-inset-utilities.test.ts).
 */

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

/** The opening tag of the settings sub-view container. */
function subViewTag(src: string, view: string): string {
  const at = src.indexOf(`settingsSubView === '${view}'`);
  expect(at, `sub-view ${view} must exist`).toBeGreaterThan(-1);
  const start = src.lastIndexOf("<div", at);
  return src.slice(start, src.indexOf(">", at));
}

describe("nav bar inset on full-screen mobile panels", () => {
  const settings = read("src/widgets/sidebar/ui/SettingsContentPanel.vue");

  it("pads My Profile (text fields) by the keyboard-aware inset", () => {
    expect(subViewTag(settings, "profile")).toMatch(/\bsafe-bottom\b/);
  });

  it.each(["callMethods", "appearance", "localAi", "about"])(
    "pads the %s sub-view by the nav bar",
    (view) => {
      expect(subViewTag(settings, view)).toMatch(/\bpb-safe\b/);
    },
  );

  it.each([
    "src/features/settings/ui/NotificationSettings.vue",
    "src/features/settings/ui/StorageSettings.vue",
    "src/features/settings/ui/TorSettingsSection.vue",
    "src/features/settings/ui/DesktopSettingsSection.vue",
  ])("%s pads its own content by the nav bar", (file) => {
    expect(read(file)).toMatch(/\bpb-safe\b/);
  });

  it("pads both group-creation lists (search / name field above them)", () => {
    const src = read("src/features/group-creation/ui/GroupCreationPanel.vue");
    const lists = src.match(/<div class="member-list-scroll[^"]*"/g) ?? [];
    expect(lists).toHaveLength(2);
    for (const tag of lists) expect(tag).toMatch(/\bsafe-bottom\b/);
  });

  it("lifts the poll sheet above the nav bar and the keyboard", () => {
    const src = read("src/features/messaging/ui/PollCreator.vue");
    const sheet = src.slice(src.indexOf('<div class="fixed bottom-0'), src.indexOf(">", src.indexOf('<div class="fixed bottom-0')));
    expect(sheet).toMatch(/padding-bottom:\s*calc\(max\(var\(--app-bottom-inset/);
  });

  it("keeps the registration stepper inside the safe area", () => {
    const src = read("src/features/auth/ui/RegistrationStepper.vue");
    expect(src).toMatch(/<div class="safe-y fixed inset-0/);
  });
});
