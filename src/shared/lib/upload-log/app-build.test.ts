import { describe, it, expect } from "vitest";
import { formatAppBuild } from "./app-build";

describe("formatAppBuild (upload log header)", () => {
  it("names the version, versionCode and commit", () => {
    expect(formatAppBuild({ version: "1.13.5-test2", build: "11305", commit: "1a2b3c4d" }))
      .toBe("1.13.5-test2 (versionCode 11305, commit 1a2b3c4d)");
  });

  it("leaves out what it does not know", () => {
    expect(formatAppBuild({ version: "1.13.5" })).toBe("1.13.5");
    expect(formatAppBuild({ commit: "abc" })).toBe("unknown (commit abc)");
    expect(formatAppBuild({})).toBeUndefined();
  });
});
