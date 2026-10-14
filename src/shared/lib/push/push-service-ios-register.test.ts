import { describe, it, expect, vi, beforeEach } from 'vitest';

// iOS: the FCM-availability probe is an Android plugin method. On iOS the
// PushData plugin is IOSPushIntentPlugin, which rejects the call with
// UNIMPLEMENTED, and the service used to treat that as "FCM not configured"
// and return before registering for APNs or wiring the VoIP token. The
// probe must not run on iOS at all.

const register = vi.fn().mockResolvedValue(undefined);

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register,
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    removeAllListeners: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/shared/lib/platform', () => ({
  isNative: true,
  isIOS: true,
}));

const isFcmAvailable = vi.fn().mockRejectedValue({ code: 'UNIMPLEMENTED' });

vi.mock('./push-data-plugin', () => ({
  PushData: {
    cacheRoomNames: vi.fn().mockResolvedValue(undefined),
    cacheSenderNames: vi.fn().mockResolvedValue(undefined),
    getPendingIntent: vi.fn().mockResolvedValue({}),
    isFcmAvailable,
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

const voipAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });
const voipGetToken = vi.fn().mockResolvedValue({ token: null });

vi.mock('./ios-voip-push', () => ({
  IOSVoIPPush: {
    addListener: voipAddListener,
    getToken: voipGetToken,
  },
}));

vi.mock('@/shared/lib/i18n', () => ({
  tRaw: (k: string) => k,
}));

describe('PushService on iOS', () => {
  beforeEach(() => {
    register.mockClear();
    isFcmAvailable.mockClear();
    voipAddListener.mockClear();
  });

  it('registers for APNs and wires the VoIP token without probing FCM availability', async () => {
    const { pushService } = await import('./push-service');
    await pushService.init({ setPusher: vi.fn(), getPushers: vi.fn() });
    expect(isFcmAvailable).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
    const events = voipAddListener.mock.calls.map(([name]) => name);
    expect(events).toContain('voipTokenReceived');
    expect(events).toContain('voipTokenInvalidated');
    expect(voipGetToken).toHaveBeenCalled();
  });

  // Each APNs server has its own Sygnal pushkin: a token from an Xcode build
  // registered as fortaios.voip would be sent to the production server and fail.
  it('registers the VoIP pusher under the app_id of the APNs server of its token', async () => {
    voipGetToken.mockResolvedValueOnce({ token: 'voip-hex', environment: 'sandbox' });
    const client = { setPusher: vi.fn().mockResolvedValue({}), getPushers: vi.fn().mockResolvedValue({ pushers: [] }) };
    const { pushService } = await import('./push-service');
    await pushService.init(client);

    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ pushkey: 'voip-hex', app_id: 'fortaios.voip.sandbox' }),
    );

    const onToken = voipAddListener.mock.calls.find(([name]) => name === 'voipTokenReceived')?.[1] as
      (data: { token: string }) => Promise<void>;
    await onToken({ token: 'voip-hex-2' });
    // Older native builds send no environment: production.
    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ pushkey: 'voip-hex-2', app_id: 'fortaios.voip' }),
    );
  });
});
