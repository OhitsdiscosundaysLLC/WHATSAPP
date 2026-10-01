import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecryptionError } from '../db/encryption';
import type { AuthStateProvider } from './auth/authStateProvider';
import { WhatsAppConnectionManager, type SocketFactory } from './connectionManager';

vi.mock('./qrDisplay', () => ({
  displayQr: vi.fn(),
}));

type Listener = (payload: unknown) => void;

function createFakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  };
  let closed = false;
  return {
    ev: {
      on(event: string, listener: Listener) {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
      },
    },
    emit,
    // Mirrors @whiskeysockets/baileys 6.7.24's real Socket/socket.js `end()`:
    // synchronously emits a 'connection.update' close event exactly once.
    end: vi.fn((error?: Error) => {
      if (closed) return;
      closed = true;
      emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error, date: new Date() },
      });
    }),
    logout: vi.fn(async () => {}),
    waitForSocketOpen: vi.fn(async () => {}),
    requestPairingCode: vi.fn(async (_phoneNumber: string) => 'ABCD1234'),
  };
}
type FakeSocket = ReturnType<typeof createFakeSocket>;

function createFakeAuthProvider(): AuthStateProvider & {
  init: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  hasExistingSession: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    kind: 'fake',
    init: vi.fn(async () => {}),
    load: vi.fn(async () => ({
      state: {} as never,
      saveCreds: vi.fn(async () => {}),
    })),
    hasExistingSession: vi.fn(async () => false),
    clear: vi.fn(async () => {}),
  };
}

const silentLogger = pino({ enabled: false });

function boom(statusCode: number) {
  return { output: { statusCode } };
}

describe('WhatsAppConnectionManager', () => {
  let authProvider: ReturnType<typeof createFakeAuthProvider>;
  let sockets: FakeSocket[];
  let createSocket: ReturnType<typeof vi.fn>;
  let manager: WhatsAppConnectionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    authProvider = createFakeAuthProvider();
    sockets = [];
    createSocket = vi.fn(async () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket as never;
    });
    manager = new WhatsAppConnectionManager({
      authProvider,
      logger: silentLogger,
      reconnect: { baseMs: 1000, maxMs: 10_000 },
      createSocket: createSocket as unknown as SocketFactory,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('transitions initializing -> connecting -> connected on a successful open', async () => {
    await manager.start();
    expect(manager.getStatus().state).toBe('connecting');
    expect(createSocket).toHaveBeenCalledTimes(1);

    sockets[0]!.emit('connection.update', { connection: 'open' });
    expect(manager.getStatus().state).toBe('connected');
    expect(manager.getStatus().reconnectAttempt).toBe(0);
  });

  it('enters awaiting_qr on a qr event and does not re-display an identical QR', async () => {
    const { displayQr } = await import('./qrDisplay');
    await manager.start();

    sockets[0]!.emit('connection.update', { qr: 'same-code' });
    sockets[0]!.emit('connection.update', { qr: 'same-code' });

    expect(manager.getStatus().state).toBe('awaiting_qr');
    expect(displayQr).toHaveBeenCalledTimes(1);

    sockets[0]!.emit('connection.update', { qr: 'different-code' });
    expect(displayQr).toHaveBeenCalledTimes(2);
  });

  it('schedules a backoff reconnect on a transient close and does not create a duplicate socket meanwhile', async () => {
    await manager.start();
    sockets[0]!.emit('connection.update', { connection: 'open' });

    sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boom(428), date: new Date() }, // connectionClosed
    });

    expect(manager.getStatus().state).toBe('reconnecting');
    expect(manager.getStatus().reconnectAttempt).toBe(1);

    // A second start() call while a reconnect is pending must be a no-op.
    await manager.start();
    expect(createSocket).toHaveBeenCalledTimes(1);

    await vi.runOnlyPendingTimersAsync();

    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(manager.getStatus().state).toBe('connecting');
  });

  it('clears credentials and stops reconnecting when WhatsApp reports a logout', async () => {
    await manager.start();
    sockets[0]!.emit('connection.update', { connection: 'open' });

    sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boom(401), date: new Date() }, // loggedOut
    });

    expect(manager.getStatus().state).toBe('logged_out');
    expect(authProvider.clear).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(createSocket).toHaveBeenCalledTimes(1); // no reconnect attempted
  });

  it('stops reconnecting (without wiping credentials) on an unrecoverable disconnect', async () => {
    await manager.start();
    sockets[0]!.emit('connection.update', { connection: 'open' });

    sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boom(500), date: new Date() }, // badSession
    });

    expect(manager.getStatus().state).toBe('error');
    expect(authProvider.clear).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it('reports a clear, actionable status (not a generic error) when stored credentials are undecryptable, and never retries', async () => {
    authProvider.load.mockRejectedValueOnce(new DecryptionError(new Error('bad auth tag')));

    await manager.start();

    expect(manager.getStatus().state).toBe('error');
    expect(manager.getStatus().detail).toMatch(/corrupted or undecryptable/);
    expect(createSocket).not.toHaveBeenCalled();

    // Never auto-retries a permanently-broken (not transient) failure.
    await vi.runAllTimersAsync();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('requestLogout performs an explicit logout, clears credentials, and does not reconnect', async () => {
    await manager.start();
    sockets[0]!.emit('connection.update', { connection: 'open' });

    await manager.requestLogout();

    expect(sockets[0]!.logout).toHaveBeenCalledTimes(1);
    expect(authProvider.clear).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().state).toBe('logged_out');

    await vi.runAllTimersAsync();
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it('shutdown stops pending reconnect timers and does not log out the device', async () => {
    await manager.start();
    sockets[0]!.emit('connection.update', { connection: 'open' });

    sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boom(428), date: new Date() },
    });
    expect(manager.getStatus().state).toBe('reconnecting');

    await manager.shutdown();

    await vi.runAllTimersAsync();
    expect(createSocket).toHaveBeenCalledTimes(1); // the pending reconnect never fired
    expect(sockets[0]!.logout).not.toHaveBeenCalled();
    expect(manager.getStatus().state).toBe('disabled');
  });

  it('does not create two sockets from concurrent start() calls', async () => {
    const first = manager.start();
    const second = manager.start();
    await Promise.all([first, second]);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it('forces a retry if no connection activity is received within the inactivity watchdog window (a silently hung handshake)', async () => {
    const watchdogManager = new WhatsAppConnectionManager({
      authProvider,
      logger: silentLogger,
      reconnect: { baseMs: 1000, maxMs: 10_000 },
      createSocket: createSocket as unknown as SocketFactory,
      inactivityWatchdogMs: 5000,
    });

    await watchdogManager.start();
    expect(watchdogManager.getStatus().state).toBe('connecting');

    // Nothing happens at all — no qr, no 'connecting' update, no open/close
    // (the exact failure mode observed against a network that silently
    // drops the WebSocket handshake).
    await vi.advanceTimersByTimeAsync(5000);

    expect(sockets[0]!.end).toHaveBeenCalledTimes(1);
    expect(watchdogManager.getStatus().state).toBe('reconnecting');

    await vi.runOnlyPendingTimersAsync();
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it('does not fire the inactivity watchdog while QR regeneration keeps providing activity', async () => {
    const watchdogManager = new WhatsAppConnectionManager({
      authProvider,
      logger: silentLogger,
      reconnect: { baseMs: 1000, maxMs: 10_000 },
      createSocket: createSocket as unknown as SocketFactory,
      inactivityWatchdogMs: 5000,
    });

    await watchdogManager.start();

    // A new QR every 3s (under the 5s watchdog window) should keep
    // resetting it indefinitely.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(3000);
      sockets[0]!.emit('connection.update', { qr: `code-${i}` });
    }

    expect(sockets[0]!.end).not.toHaveBeenCalled();
    expect(watchdogManager.getStatus().state).toBe('awaiting_qr');
  });

  it('never includes qr/pairingCode in getStatus() (used for /health) even while awaiting_qr', async () => {
    await manager.start();
    sockets[0]!.emit('connection.update', { qr: 'super-secret-qr-payload' });

    const status = manager.getStatus() as unknown as Record<string, unknown>;
    expect(status.state).toBe('awaiting_qr');
    expect(status).not.toHaveProperty('qr');
    expect(status).not.toHaveProperty('pairingCode');
    expect(JSON.stringify(status)).not.toContain('super-secret-qr-payload');

    // getPairingSnapshot() is the one place it's deliberately available.
    const pairing = manager.getPairingSnapshot();
    expect(pairing.qr).toBe('super-secret-qr-payload');
  });

  it('requestPairingCode() returns a code and reflects it only in the pairing snapshot', async () => {
    await manager.start();
    sockets[0]!.emit('connection.update', { connection: 'connecting' });

    const code = await manager.requestPairingCode('15551234567');

    expect(code).toBe('ABCD1234');
    expect(sockets[0]!.waitForSocketOpen).toHaveBeenCalledTimes(1);
    expect(sockets[0]!.requestPairingCode).toHaveBeenCalledWith('15551234567');
    expect(manager.getStatus().state).toBe('awaiting_pairing_code');
    expect(manager.getPairingSnapshot().pairingCode).toBe('ABCD1234');
    expect(manager.getPairingSnapshot().pairingPhoneNumber).toBe('15551234567');
    expect(manager.getStatus()).not.toHaveProperty('pairingCode');
  });

  it('requestPairingCode() throws when there is no active connection attempt', async () => {
    await expect(manager.requestPairingCode('15551234567')).rejects.toThrow();
  });

  it('onUpdate() notifies subscribers of every state transition and unsubscribe() stops delivery', async () => {
    const seen: string[] = [];
    const unsubscribe = manager.onUpdate((snapshot) => seen.push(snapshot.state));

    await manager.start();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    unsubscribe();
    sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boom(428), date: new Date() },
    });

    expect(seen).toContain('connecting');
    expect(seen).toContain('connected');
    expect(seen).not.toContain('reconnecting'); // delivered after unsubscribe
  });
});
