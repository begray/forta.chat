import { Capacitor, registerPlugin, WebPlugin } from "@capacitor/core";

/** What the ongoing notification shows. Text is composed (and translated)
 *  on the JS side; the native side only displays it. */
export interface KeepAliveNotice {
  /** "Sending 3 of 12 · 40%" */
  title: string;
  /** "Compressing a video" / "Uploading" / "Waiting to send" */
  text: string;
  /** 0-100 for the progress bar. */
  percent: number;
  /** Label of the notification's Cancel action. */
  cancelLabel: string;
}

export type NotificationPermissionState = "granted" | "denied" | "prompt";

/** Why the native service stopped on its own (not because JS asked):
 *  - `idle`: no progress for the service's idle cap (default 30 min);
 *  - `timeout`: Android's dataSync time limit (Android 15+: 6 h per day);
 *  - `start-failed`: startForeground() was refused inside the service;
 *  - `system`: the service was destroyed without a stop request. */
export type KeepAliveStopReason = "idle" | "timeout" | "start-failed" | "system";

/**
 * Native contract of android/.../plugins/backgroundupload/BackgroundUploadPlugin.kt.
 * A keep-alive foreground service: it does no uploading itself, it keeps the
 * process (and so the WebView's XHRs, the Tor transfer and the video encoder)
 * at foreground priority with the screen off. start() rejects when Android
 * refuses the foreground service (app not visible, daily limit used up).
 * iOS and web have no implementation: every call resolves and does nothing.
 */
export interface BackgroundUploadNativePlugin {
  start(notice: KeepAliveNotice): Promise<void>;
  update(notice: KeepAliveNotice): Promise<void>;
  stop(): Promise<void>;
  notificationPermission(): Promise<{ state: NotificationPermissionState }>;
  requestNotificationPermission(): Promise<{ state: NotificationPermissionState }>;
  addListener(event: "cancelAll", cb: () => void): Promise<{ remove: () => Promise<void> | void }>;
  addListener(event: "heartbeat", cb: () => void): Promise<{ remove: () => Promise<void> | void }>;
  addListener(
    event: "stopped",
    cb: (data: { reason: KeepAliveStopReason }) => void,
  ): Promise<{ remove: () => Promise<void> | void }>;
}

class BackgroundUploadWeb extends WebPlugin {
  async start(): Promise<void> {}
  async update(): Promise<void> {}
  async stop(): Promise<void> {}
  async notificationPermission(): Promise<{ state: NotificationPermissionState }> {
    return { state: "granted" };
  }
  async requestNotificationPermission(): Promise<{ state: NotificationPermissionState }> {
    return { state: "granted" };
  }
}

export const BackgroundUpload = registerPlugin<BackgroundUploadNativePlugin>("BackgroundUpload", {
  web: () => new BackgroundUploadWeb(),
  ios: () => new BackgroundUploadWeb(),
});

/** True on Android builds that ship BackgroundUploadPlugin. */
export function isBackgroundUploadAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("BackgroundUpload");
}

/** "plugin-missing" on Android without the native plugin; null elsewhere
 *  (iOS and the web have no service by design). */
export function backgroundUploadMissingReason(): string | null {
  if (Capacitor.getPlatform() !== "android") return null;
  return Capacitor.isPluginAvailable("BackgroundUpload") ? null : "plugin-missing";
}
