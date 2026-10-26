// @vitest-environment happy-dom
/**
 * When the keep-alive service is started, updated and stopped (the native
 * plugin is mocked): batch start, progress, all done, the notification's
 * Cancel, a refused start, Android's time limit, and the permission ask.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  describeRun,
  holdTransfer,
  setBackgroundTransferDepsForTests,
  setTransferHandlers,
  setTransferSource,
  START_DELAY_MS,
  STOP_GRACE_MS,
  UPDATE_MIN_MS,
  type BackgroundTransferDeps,
} from "./background-transfer";
import type { KeepAliveNotice, KeepAliveStopReason, NotificationPermissionState } from "./background-transfer-plugin";
import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";

interface Fake extends BackgroundTransferDeps {
  start: ReturnType<typeof vi.fn<(n: KeepAliveNotice) => Promise<void>>>;
  update: ReturnType<typeof vi.fn<(n: KeepAliveNotice) => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  requestNotificationPermission: ReturnType<typeof vi.fn<() => Promise<NotificationPermissionState>>>;
  notificationPermission: ReturnType<typeof vi.fn<() => Promise<NotificationPermissionState>>>;
  visible: boolean;
  fire: {
    cancelAll: () => void;
    heartbeat: () => void;
    stopped: (r: KeepAliveStopReason) => void;
    visibility: (v: boolean) => void;
  };
}

function makeFake(available = true): Fake {
  const fake = {
    visible: true,
    fire: {} as Fake["fire"],
    available: () => available,
    start: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    notificationPermission: vi.fn(async () => "granted" as NotificationPermissionState),
    requestNotificationPermission: vi.fn(async () => "granted" as NotificationPermissionState),
    listen: (events: { cancelAll: () => void; heartbeat: () => void; stopped: (r: KeepAliveStopReason) => void }) => {
      fake.fire.cancelAll = events.cancelAll;
      fake.fire.heartbeat = events.heartbeat;
      fake.fire.stopped = events.stopped;
    },
    isVisible: () => fake.visible,
    onVisibilityChange: (cb: (v: boolean) => void) => {
      fake.fire.visibility = (v: boolean) => {
        fake.visible = v;
        cb(v);
      };
    },
    now: () => Date.now(),
  } as unknown as Fake;
  return fake;
}

const events = (prefix = "fgs:") => getUploadLog().filter((e) => e.e.startsWith(prefix));
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("background transfer keep-alive", () => {
  let fake: Fake;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetUploadLogForTests();
    fake = makeFake();
    setBackgroundTransferDepsForTests(fake);
  });

  afterEach(() => {
    setBackgroundTransferDepsForTests(null);
    vi.useRealTimers();
  });

  it("does not start for a send that finishes within the start delay", async () => {
    const release = holdTransfer("photo");
    vi.advanceTimersByTime(START_DELAY_MS / 2);
    release();
    vi.advanceTimersByTime(START_DELAY_MS * 2);
    await flush();
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it("starts once for a batch, with the run's position and progress", async () => {
    setTransferSource("batch", [
      { id: "a", phase: "waiting" },
      { id: "b", phase: "waiting" },
      { id: "c", phase: "waiting" },
    ]);
    expect(fake.start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.start.mock.calls[0][0]).toEqual({
      title: "Sending 1 of 3 · 0%",
      text: "Waiting to send",
      percent: 0,
      cancelLabel: "Cancel",
    });
    expect(events().map((e) => e.e)).toEqual(["fgs:start"]);
    // More work while running never starts a second service.
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 10 }]);
    vi.advanceTimersByTime(START_DELAY_MS * 3);
    await flush();
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it("updates with progress, at most once per second", async () => {
    setTransferSource("batch", [
      { id: "a", phase: "waiting" },
      { id: "b", phase: "waiting" },
    ]);
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 50 }]);
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 60 }]);
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 80 }]);
    expect(fake.update).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(UPDATE_MIN_MS);
    await flush();
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.update.mock.calls[0][0]).toMatchObject({ title: "Sending 1 of 2 · 40%", text: "Uploading", percent: 40 });

    // "a" is sent: the batch and the engine let go of it.
    setTransferSource("batch", [{ id: "b", phase: "waiting" }]);
    setTransferSource("engine", [{ id: "b", phase: "uploading", percent: 0 }]);
    vi.advanceTimersByTime(UPDATE_MIN_MS);
    await flush();
    expect(fake.update).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Sending 2 of 2 · 50%" }));
  });

  it("counts a compressed video's encode as the first half of its way", async () => {
    // The send call holds it across the compressor -> queue hand-off.
    const release = holdTransfer("v");
    setTransferSource("compress", [{ id: "v", phase: "compressing", percent: 50, compressed: true }]);
    expect(describeRun()).toMatchObject({ total: 1, percent: 25, phase: "compressing" });
    setTransferSource("compress", []);
    setTransferSource("engine", [{ id: "v", phase: "uploading", percent: 50 }]);
    expect(describeRun()).toMatchObject({ total: 1, percent: 75, phase: "uploading" });
    release();
  });

  it("stops after the grace once everything is done, and not across a hand-off", async () => {
    const release = holdTransfer("v");
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    expect(fake.start).toHaveBeenCalledTimes(1);

    // The send call ends right after the engine took the item over.
    setTransferSource("engine", [{ id: "v", phase: "waiting" }]);
    release();
    vi.advanceTimersByTime(STOP_GRACE_MS * 2);
    await flush();
    expect(fake.stop).not.toHaveBeenCalled();

    setTransferSource("engine", []);
    vi.advanceTimersByTime(STOP_GRACE_MS - 1);
    expect(fake.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(events().map((e) => [e.e, e.d?.reason])).toEqual([["fgs:start", undefined], ["fgs:stop", "done"]]);
  });

  it("a new item within the stop grace keeps the same service", async () => {
    setTransferSource("engine", [{ id: "a", phase: "waiting" }]);
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    setTransferSource("engine", []);
    vi.advanceTimersByTime(STOP_GRACE_MS / 2);
    setTransferSource("engine", [{ id: "b", phase: "waiting" }]);
    vi.advanceTimersByTime(STOP_GRACE_MS * 2);
    await flush();
    expect(fake.stop).not.toHaveBeenCalled();
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it("the notification's Cancel cancels every active send", async () => {
    const cancelAll = vi.fn(async () => {});
    setTransferHandlers({ cancelAll });
    setTransferSource("batch", [
      { id: "a", phase: "uploading", percent: 20 },
      { id: "b", phase: "waiting" },
    ]);
    setTransferSource("engine", [{ id: "solo", phase: "uploading" }]);
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    fake.fire.cancelAll();
    expect(cancelAll).toHaveBeenCalledWith(["a", "b", "solo"]);
    expect(events().some((e) => e.e === "fgs:cancel" && e.d?.items === 3)).toBe(true);

    // The cancelled items leave their sources: the service stops.
    setTransferSource("batch", []);
    setTransferSource("engine", []);
    vi.advanceTimersByTime(STOP_GRACE_MS);
    await flush();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("the heartbeat reaches the handler", async () => {
    const heartbeat = vi.fn();
    setTransferHandlers({ heartbeat });
    setTransferSource("engine", [{ id: "a", phase: "waiting" }]);
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    fake.fire.heartbeat();
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("a refused start is logged, sends no updates, and is retried once visible", async () => {
    fake.start.mockRejectedValueOnce(new Error("ForegroundServiceStartNotAllowedException"));
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 5 }]);
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    expect(events().map((e) => e.e)).toEqual(["fgs:start", "fgs:denied"]);
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 50 }]);
    vi.advanceTimersByTime(START_DELAY_MS * 3);
    await flush();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.start).toHaveBeenCalledTimes(1);

    fake.fire.visibility(false);
    fake.fire.visibility(true);
    await flush();
    expect(fake.start).toHaveBeenCalledTimes(2);
  });

  it("starts at once when the app leaves the screen with work pending", async () => {
    setTransferSource("engine", [{ id: "a", phase: "waiting" }]);
    fake.fire.visibility(false);
    await flush();
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(events()[0].d?.visible).toBe(false);
  });

  it("Android's time limit: logged, no restart until the app is visible again", async () => {
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 5 }]);
    vi.advanceTimersByTime(START_DELAY_MS);
    await flush();
    fake.visible = false;
    fake.fire.stopped("timeout");
    expect(events().map((e) => e.e)).toEqual(["fgs:start", "fgs:timeout"]);
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 60 }]);
    vi.advanceTimersByTime(START_DELAY_MS * 3);
    await flush();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.start).toHaveBeenCalledTimes(1);
    // Done while stopped: no stop call for a service that is gone.
    setTransferSource("engine", []);
    vi.advanceTimersByTime(STOP_GRACE_MS);
    await flush();
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it("asks for the notification permission once, at the first big send", async () => {
    fake.notificationPermission.mockResolvedValue("prompt");
    // One small item: no ask.
    setTransferSource("engine", [{ id: "a", phase: "waiting" }]);
    await flush();
    expect(fake.requestNotificationPermission).not.toHaveBeenCalled();
    // A second item makes it a batch.
    setTransferSource("engine", [{ id: "a", phase: "waiting" }, { id: "b", phase: "waiting" }]);
    await flush();
    expect(fake.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(events().some((e) => e.e === "fgs:notif" && e.d?.state === "granted")).toBe(true);

    // A later session does not ask again.
    setBackgroundTransferDepsForTests(fake);
    setTransferSource("compress", [{ id: "v", phase: "compressing", percent: 0, compressed: true }]);
    await flush();
    expect(fake.requestNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it("does nothing native where the plugin is missing (iOS, web)", async () => {
    const web = makeFake(false);
    setBackgroundTransferDepsForTests(web);
    setTransferSource("batch", [{ id: "a", phase: "waiting" }, { id: "b", phase: "waiting" }]);
    vi.advanceTimersByTime(START_DELAY_MS * 2);
    setTransferSource("batch", []);
    vi.advanceTimersByTime(STOP_GRACE_MS * 2);
    await flush();
    expect(web.start).not.toHaveBeenCalled();
    expect(web.stop).not.toHaveBeenCalled();
    expect(web.notificationPermission).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });

  it("says once when Android has no service to start (plugin missing)", async () => {
    const missing = { ...makeFake(false), missingReason: () => "plugin-missing" } as unknown as Fake;
    setBackgroundTransferDepsForTests(missing);
    setTransferSource("engine", [{ id: "a", phase: "waiting" }]);
    setTransferSource("engine", [{ id: "a", phase: "uploading", percent: 5 }]);
    vi.advanceTimersByTime(START_DELAY_MS * 2);
    await flush();
    expect(events()).toEqual([expect.objectContaining({ e: "fgs:unavailable", d: { reason: "plugin-missing", items: 1 } })]);
    setTransferSource("engine", []);
  });
});
