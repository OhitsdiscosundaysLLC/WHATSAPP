import type {
  AuthenticationState,
  ConnectionState as BaileysConnectionState,
  WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AuthStateProvider } from './auth/authStateProvider';
import { createWhatsAppSocket } from './client';
import { displayQr } from './qrDisplay';
import { computeBackoffDelayMs, decideOnDisconnect, extractStatusCode } from './reconnectPolicy';
import type { WhatsAppConnectionState, WhatsAppStatus } from './types';

export type SocketFactory = (params: {
  authState: AuthenticationState;
  logger: Logger;
}) => Promise<WASocket>;

export interface ConnectionManagerOptions {
  authProvider: AuthStateProvider;
  logger: Logger;
  reconnect: { baseMs: number; maxMs: number };
  /** Injectable for tests. Defaults to the real Baileys socket factory. */
  createSocket?: SocketFactory;
  /**
   * How long to wait for *any* sign of life (a QR, a 'connecting' update, an
   * open) before giving up on a connection attempt and retrying. Baileys'
   * own `connectTimeoutMs` (20s by default) covers a TCP/TLS handshake that
   * actively fails, but a connection that's silently black-holed by a
   * network policy (observed during this project's own development —
   * see docs/INTEGRATIONS.md) produces no event at all, ever, so nothing
   * would otherwise retry it. Reset on every event received, so a
   * legitimately long QR-scanning wait (Baileys keeps regenerating QRs) is
   * never cut short. Defaults to 45s.
   */
  inactivityWatchdogMs?: number;
}

/**
 * Owns the WhatsApp connection lifecycle: creating the socket, applying
 * auth state, reconnecting on transient failures with capped backoff,
 * distinguishing explicit/terminal logout from temporary disconnects, and
 * preventing duplicate sockets/listeners. Does not process any message
 * content — that's deliberately out of scope until later phases.
 */
export class WhatsAppConnectionManager {
  private readonly authProvider: AuthStateProvider;
  private readonly logger: Logger;
  private readonly reconnectConfig: { baseMs: number; maxMs: number };
  private readonly socketFactory: SocketFactory;
  private readonly inactivityWatchdogMs: number;

  private socket: WASocket | null = null;
  private state: WhatsAppConnectionState = 'disabled';
  private detail: string | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityWatchdog: ReturnType<typeof setTimeout> | null = null;
  private explicitLogoutRequested = false;
  private shuttingDown = false;
  private starting = false;
  private lastQr: string | undefined;
  private lastConnectedAt: string | undefined;
  private lastDisconnectedAt: string | undefined;
  private updatedAt = new Date().toISOString();
  private saveCreds: (() => Promise<void>) | null = null;

  constructor(options: ConnectionManagerOptions) {
    this.authProvider = options.authProvider;
    this.logger = options.logger;
    this.reconnectConfig = options.reconnect;
    this.socketFactory = options.createSocket ?? createWhatsAppSocket;
    this.inactivityWatchdogMs = options.inactivityWatchdogMs ?? 45_000;
  }

  getStatus(): WhatsAppStatus {
    return {
      state: this.state,
      detail: this.detail,
      reconnectAttempt: this.reconnectAttempt,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      updatedAt: this.updatedAt,
    };
  }

  /** Start (or resume) the connection. Safe to call once at boot. */
  async start(): Promise<void> {
    if (this.shuttingDown) {
      this.logger.warn('Ignoring WhatsApp start() call: shutting down');
      return;
    }
    if (this.socket || this.reconnectTimer || this.starting) {
      this.logger.warn(
        'WhatsApp connection already active/starting; ignoring duplicate start() call',
      );
      return;
    }

    this.starting = true;
    this.setState('initializing');
    try {
      await this.authProvider.init();
      const hasExisting = await this.authProvider.hasExistingSession();
      this.logger.info(
        { hasExistingSession: hasExisting },
        hasExisting
          ? 'Existing WhatsApp session found — attempting reconnect without QR'
          : 'No existing WhatsApp session — QR authentication will be required',
      );
      await this.connect();
    } catch (err) {
      this.logger.error({ err }, 'Failed to start WhatsApp connection');
      this.setState('error', 'Failed to start WhatsApp connection');
    } finally {
      this.starting = false;
    }
  }

  private async connect(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.socket) {
      this.logger.warn('connect() called with a socket already active; ignoring');
      return;
    }

    this.clearReconnectTimer();
    this.setState('connecting');

    const { state, saveCreds } = await this.authProvider.load();
    this.saveCreds = saveCreds;

    const socket = await this.socketFactory({ authState: state, logger: this.logger });

    if (this.shuttingDown) {
      // Shutdown happened while we were awaiting socket creation.
      socket.end(undefined);
      return;
    }

    this.socket = socket;
    this.attachListeners(socket);
    this.armInactivityWatchdog(socket);
  }

  private attachListeners(socket: WASocket): void {
    socket.ev.on('creds.update', () => {
      void this.persistCreds();
    });

    socket.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(update);
    });
  }

  private async persistCreds(): Promise<void> {
    try {
      await this.saveCreds?.();
    } catch (err) {
      this.logger.error({ err }, 'Failed to persist WhatsApp credentials after update');
    }
  }

  private async handleConnectionUpdate(update: Partial<BaileysConnectionState>): Promise<void> {
    // Any event at all is a sign of life — reset the inactivity watchdog
    // (e.g. a freshly-regenerated QR legitimately extends a long user wait).
    if (this.socket) {
      this.armInactivityWatchdog(this.socket);
    }

    const { connection, qr, lastDisconnect, isNewLogin } = update;

    if (qr && qr !== this.lastQr) {
      this.lastQr = qr;
      this.setState(
        'awaiting_qr',
        'Scan the QR code with WhatsApp > Linked Devices > Link a Device',
      );
      displayQr(qr, this.logger);
    }

    if (connection === 'connecting') {
      this.setState('connecting');
    }

    if (connection === 'open') {
      this.clearInactivityWatchdog(); // connected — no longer waiting on anything
      this.lastQr = undefined;
      this.reconnectAttempt = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.setState('connected', isNewLogin ? 'Newly linked device' : undefined);
      this.logger.info({ isNewLogin: Boolean(isNewLogin) }, 'WhatsApp connection established');
    }

    if (connection === 'close') {
      await this.handleClose(lastDisconnect);
    }
  }

  private async handleClose(
    lastDisconnect: BaileysConnectionState['lastDisconnect'],
  ): Promise<void> {
    this.clearInactivityWatchdog();
    this.socket = null;
    this.lastDisconnectedAt = new Date().toISOString();

    if (this.explicitLogoutRequested) {
      this.explicitLogoutRequested = false;
      this.logger.warn('WhatsApp connection closed as part of an explicit logout');
      await this.authProvider.clear();
      this.setState('logged_out', 'Logged out by explicit request');
      return;
    }

    const statusCode = extractStatusCode(lastDisconnect?.error);
    const action = decideOnDisconnect(statusCode);
    this.logger.warn({ statusCode, action }, 'WhatsApp connection closed');

    switch (action) {
      case 'logout':
        this.setState(
          'logged_out',
          'Device was unlinked from WhatsApp — scanning a new QR is required',
        );
        await this.authProvider.clear();
        break;
      case 'stop':
        this.setState(
          'error',
          `Unrecoverable disconnect (status ${statusCode ?? 'unknown'}) — not reconnecting automatically`,
        );
        break;
      case 'reconnect':
        this.setState('reconnecting');
        this.scheduleReconnect(false);
        break;
      case 'reconnect_immediate':
        this.setState('reconnecting');
        this.scheduleReconnect(true);
        break;
    }
  }

  private scheduleReconnect(immediate: boolean): void {
    if (this.shuttingDown) return;

    this.reconnectAttempt += 1;
    const delayMs = immediate
      ? 0
      : computeBackoffDelayMs(this.reconnectAttempt, this.reconnectConfig);
    this.logger.info(
      { attempt: this.reconnectAttempt, delayMs },
      'Scheduling WhatsApp reconnect attempt',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err: unknown) => {
        this.logger.error({ err }, 'WhatsApp reconnect attempt threw unexpectedly');
        this.setState('error', 'Reconnect attempt failed unexpectedly');
      });
    }, delayMs);

    // Don't let a pending reconnect timer keep the process alive on its own.
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** (Re-)arms the inactivity watchdog for the given socket. See `inactivityWatchdogMs`. */
  private armInactivityWatchdog(socket: WASocket): void {
    this.clearInactivityWatchdog();
    this.inactivityWatchdog = setTimeout(() => {
      this.inactivityWatchdog = null;
      if (this.socket !== socket) return; // superseded by a newer socket already
      this.logger.warn(
        { timeoutMs: this.inactivityWatchdogMs },
        'No WhatsApp connection activity received in time; forcing a retry',
      );
      try {
        socket.end(undefined);
      } catch (err) {
        this.logger.warn({ err }, 'Error forcing an unresponsive WhatsApp socket closed');
      }
    }, this.inactivityWatchdogMs);
    this.inactivityWatchdog.unref?.();
  }

  private clearInactivityWatchdog(): void {
    if (this.inactivityWatchdog) {
      clearTimeout(this.inactivityWatchdog);
      this.inactivityWatchdog = null;
    }
  }

  private setState(state: WhatsAppConnectionState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Explicit, owner-initiated logout: unlinks the device and clears local
   * credentials. Not reachable from any endpoint yet — reserved for the
   * Phase 11 command system (`.bot logout` or similar) to call.
   *
   * Deterministic by design: it performs the state transition and
   * credential clear itself rather than waiting on the `connection.update`
   * close event that Baileys will *also* eventually emit for the same
   * logout. That later close event still arrives and is handled safely by
   * `handleClose`'s `explicitLogoutRequested` branch, but by then this
   * method has already cleared `explicitLogoutRequested`, so it instead
   * falls through to the normal disconnect-reason handling — WhatsApp
   * reports `loggedOut` for its own logout, so it resolves to the same
   * (idempotent) outcome rather than a confusing "unrecoverable error".
   */
  async requestLogout(): Promise<void> {
    this.explicitLogoutRequested = true;
    this.clearReconnectTimer();
    this.clearInactivityWatchdog();

    const socket = this.socket;
    this.socket = null;

    if (socket) {
      try {
        await socket.logout();
      } catch (err) {
        this.logger.warn(
          { err },
          'Error during explicit WhatsApp logout; clearing local state anyway',
        );
      }
    }

    this.explicitLogoutRequested = false;
    await this.authProvider.clear();
    this.setState('logged_out', 'Logged out by explicit request');
  }

  /**
   * Graceful shutdown: stops reconnect timers and closes the socket without
   * logging out the linked device, so a normal process restart preserves
   * the session. Call on SIGTERM/SIGINT.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearReconnectTimer();
    this.clearInactivityWatchdog();

    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch (err) {
        this.logger.warn({ err }, 'Error while closing WhatsApp socket during shutdown');
      }
      this.socket = null;
    }

    this.setState('disabled', 'Shut down');
  }
}
