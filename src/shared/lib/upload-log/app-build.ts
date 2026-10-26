/**
 * Which build wrote an upload log. The version name alone ("1.13.5-…") does
 * not tell test builds of the same version apart, so the header also names
 * the native versionCode and the commit the web bundle was built from
 * (VITE_BUILD_COMMIT, set by the build; absent in dev).
 */

export interface AppBuild {
  /** Native versionName (or the web app's version). */
  version?: string;
  /** Native versionCode. */
  build?: string;
  /** Commit of the web bundle. */
  commit?: string;
}

/** "1.13.5-test2 (versionCode 11305, commit 1a2b3c4d)", or undefined. */
export function formatAppBuild(b: AppBuild): string | undefined {
  const details = [
    b.build ? `versionCode ${b.build}` : "",
    b.commit ? `commit ${b.commit}` : "",
  ].filter(Boolean);
  if (!b.version && !details.length) return undefined;
  const version = b.version || "unknown";
  return details.length ? `${version} (${details.join(", ")})` : version;
}

export function bundleCommit(): string | undefined {
  const commit = (import.meta.env.VITE_BUILD_COMMIT ?? "").trim();
  return commit ? commit.slice(0, 12) : undefined;
}

/** The running build: native app info where there is one. */
export async function readAppBuild(fallbackVersion?: string): Promise<AppBuild> {
  const commit = bundleCommit();
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    return { version: info.version || fallbackVersion, build: info.build || undefined, commit };
  } catch {
    // The web has no native app info.
    return { version: fallbackVersion, commit };
  }
}
