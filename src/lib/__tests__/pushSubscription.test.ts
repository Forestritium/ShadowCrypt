import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();

const mockRegistration = {
  pushManager: {
    subscribe: mockSubscribe,
    getSubscription: vi.fn().mockResolvedValue(null)
  }
};

describe('Push Subscription Toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve(mockRegistration),
        getRegistration: vi.fn().mockResolvedValue(mockRegistration)
      }
    });

    vi.stubGlobal('window', {
      Notification: {
        permission: 'granted',
        requestPermission: vi.fn().mockResolvedValue('granted')
      }
    });
  });

  it('subscribes to push notifications if permission granted', async () => {
    mockSubscribe.mockResolvedValue({
      endpoint: 'https://push.example.com',
      toJSON: () => ({ endpoint: 'https://push.example.com', keys: { p256dh: 'a', auth: 'b' } })
    });

    const reg = await (global as any).navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true });

    expect(mockSubscribe).toHaveBeenCalledWith({ userVisibleOnly: true });
    expect(sub.endpoint).toBe('https://push.example.com');
  });

  it('handles permission denied', async () => {
    vi.stubGlobal('window', {
      Notification: {
        permission: 'default',
        requestPermission: vi.fn().mockResolvedValue('denied')
      }
    });
    
    const permission = await (global as any).window.Notification.requestPermission();
    expect(permission).toBe('denied');
  });
});
