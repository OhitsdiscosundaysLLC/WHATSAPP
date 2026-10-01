import type {
  AuthenticationState,
  ConnectionState as BaileysConnectionState,
  GroupMetadata,
  MessageUpsertType,
  WACallEvent,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { AuthStateProvider } from './auth/authStateProvider';
import { createWhatsAppSocket } from './client';
import { displayQr } from './qrDisplay';
import { computeBackoffDelayMs, decideOnDisconnect, extractStatusCode } from './reconnectPolicy';
import type {
  PairingListener,
  PairingSnapshot,
  WhatsAppConnectionState,
  WhatsAppStatus,
} from './types';

export type SocketFactory = (params: {
  authState: AuthenticationState;
  logger: Logger;
}) => Promise<WASocket>;

/** A WhatsApp group known to the connected account — JID + current display name. */
export interface DiscoveredGroup {
  jid: string;
  subject: string;
}

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
  /**
   * Fired for every raw incoming `WAMessage` from Baileys' `messages.upsert`
   * (Phase 4). This manager does no normalization or interpretation of
   * content itself — see src/whatsapp/events/eventPipeline.ts for that.
   * `type` is Baileys' own 'notify' (live) vs 'append' (offline backlog)
   * distinction; callers decide what to do with each.
   */
  onMessage?: (message: WAMessage, type: MessageUpsertType) => void;
  /**
   * Fired with the full list of groups the account is known to belong to:
   * once after every successful connect (via `groupFetchAllParticipating()`
   * — the standard Baileys discovery call for "all my groups", not
   * invented) and again whenever Baileys reports new/changed groups
   * (`groups.upsert`/`groups.update`). See src/whatsapp/groups/groupDiscovery.ts.
   */
  onGroupsDiscovered?: (groups: DiscoveredGroup[]) => void;
  /**
   * Fired for every raw Baileys `call` event (Phase 9) — offer, ringing,
   * reject, accept, timeout, terminate. Signaling metadata only; Baileys
   * does not implement WebRTC media handling, so there is no audio/video
   * to fan out (see docs/DECISIONS.md ADR-001). See
   * src/whatsapp/calls/callHandler.ts.
   */
  onCall?: (call: WACallEvent) => void;
}

/**
 * Owns the WhatsApp connection lifecycle: creating the socket, applying
 * auth state, reconnecting on transient failures with capped backoff,
 * distinguishing explicit/terminal logout from temporary disconnects, and
 * preventing duplicate sockets/listeners. Message content interpretation
 * and group-settings/rule logic live elsewhere (src/whatsapp/events/,
 * src/whatsapp/groups/, src/rules/) — this class only fans out the raw
 * Baileys events via `onMessage`/`onGroupsDiscovered` and exposes
 * `sendTextMessage()` for the action engine to use.
 */
export class WhatsAppConnectionManager {
  private readonly authProvider: AuthStateProvider;
  private readonly logger: Logger;
  private readonly reconnectConfig: { baseMs: number; maxMs: number };
  private readonly socketFactory: SocketFactory;
  private readonly inactivityWatchdogMs: number;
  private readonly onMessage: ConnectionManagerOptions['onMessage'];
  private readonly onGroupsDiscovered: ConnectionManagerOptions['onGroupsDiscovered'];
  private readonly onCall: ConnectionManagerOptions['onCall'];

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
  private lastPairingCode: string | undefined;
  private lastPairingPhoneNumber: string | undefined;
  private lastConnectedAt: string | undefined;
  private lastDisconnectedAt: string | undefined;
  private updatedAt = new Date().toISOString();
  private saveCreds: (() => Promise<void>) | null = null;
  private readonly listeners = new Set<PairingListener>();

  constructor(options: ConnectionManagerOptions) {
    this.authProvider = options.authProvider;
    this.logger = options.logger;
    this.reconnectConfig = options.reconnect;
    this.socketFactory = options.createSocket ?? createWhatsAppSocket;
    this.inactivityWatchdogMs = options.inactivityWatchdogMs ?? 45_000;
    this.onMessage = options.onMessage;
    this.onGroupsDiscovered = options.onGroupsDiscovered;
    this.onCall = options.onCall;
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

  /**
   * `getStatus()` plus short-lived QR/pairing-code material. Callers of
   * this method are responsible for keeping it off `/health`, logs, and any
   * public response — see the type's own doc comment and docs/SECURITY.md.
   * Only `src/web/` (the authenticated dashboard layer) may call this.
   */
  getPairingSnapshot(): PairingSnapshot {
    return {
      ...this.getStatus(),
      qr: this.lastQr,
      pairingCode: this.lastPairingCode,
      pairingPhoneNumber: this.lastPairingPhoneNumber,
    };
  }

  /**
   * Subscribe to status/pairing updates (used by the dashboard's SSE
   * stream). Returns an unsubscribe function. The listener fires once
   * immediately isn't guaranteed — callers that want the current state
   * right away should call `getPairingSnapshot()` first.
   */
  onUpdate(listener: PairingListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitUpdate(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getPairingSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.logger.warn({ err }, 'WhatsApp status listener threw');
      }
    }
  }

  /** Clears transient QR/pairing-code material — see PairingSnapshot's doc comment. */
  private clearPairingMaterial(): void {
    this.lastQr = undefined;
    this.lastPairingCode = undefined;
    this.lastPairingPhoneNumber = undefined;
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
    this.clearPairingMaterial(); // a fresh socket means any prior QR/code is stale
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

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (!this.onMessage) return;
      for (const message of messages) {
        try {
          this.onMessage(message, type);
        } catch (err) {
          this.logger.error({ err }, 'onMessage handler threw');
        }
      }
    });

    socket.ev.on('groups.upsert', (groups) => {
      this.emitDiscoveredGroups(groups);
    });

    socket.ev.on('groups.update', (partials) => {
      // Partial updates (e.g. a rename) still carry id+subject when that's
      // what changed; entries missing either are skipped rather than
      // guessed at.
      this.emitDiscoveredGroups(partials);
    });

    socket.ev.on('call', (calls) => {
      if (!this.onCall) return;
      for (const call of calls) {
        try {
          this.onCall(call);
        } catch (err) {
          this.logger.error({ err }, 'onCall handler threw');
        }
      }
    });
  }

  private emitDiscoveredGroups(groups: Array<Partial<GroupMetadata>>): void {
    if (!this.onGroupsDiscovered) return;
    const discovered: DiscoveredGroup[] = groups
      .filter((g): g is Partial<GroupMetadata> & { id: string; subject: string } =>
        Boolean(g.id && typeof g.subject === 'string'),
      )
      .map((g) => ({ jid: g.id, subject: g.subject }));
    if (discovered.length > 0) {
      this.onGroupsDiscovered(discovered);
    }
  }

  /**
   * Full group discovery on (re)connect, via Baileys' own
   * `groupFetchAllParticipating()` — the standard call for "every group
   * this account currently participates in," not something hand-rolled.
   * Best-effort: a failure here must never affect the live connection it
   * runs alongside.
   */
  private discoverGroups(socket: WASocket): void {
    if (!this.onGroupsDiscovered) return;
    socket
      .groupFetchAllParticipating()
      .then((groups) => {
        const discovered = Object.values(groups).map((g) => ({ jid: g.id, subject: g.subject }));
        this.onGroupsDiscovered?.(discovered);
      })
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'Failed to fetch participating WhatsApp groups');
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
      this.clearPairingMaterial();
      this.reconnectAttempt = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.setState('connected', isNewLogin ? 'Newly linked device' : undefined);
      this.logger.info({ isNewLogin: Boolean(isNewLogin) }, 'WhatsApp connection established');
      if (this.socket) {
        this.discoverGroups(this.socket);
      }
    }

    if (connection === 'close') {
      await this.handleClose(lastDisconnect);
    }
  }

  private async handleClose(
    lastDisconnect: BaileysConnectionState['lastDisconnect'],
  ): Promise<void> {
    this.clearInactivityWatchdog();
    this.clearPairingMaterial();
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
    this.emitUpdate();
  }

  /**
   * Sends a plain text message through this account's live connection —
   * the one path the action engine (src/rules/actionEngine.ts) uses for
   * `SEND_MESSAGE`/`NOTIFY_OWNER`. Only callable while actually connected;
   * throws otherwise rather than queuing or silently dropping the send, so
   * a failed send is always visible to the caller (and from there, to the
   * audit log). Not reachable from any HTTP endpoint directly — only from
   * rule evaluation, which itself only runs for dashboard-configured,
   * owner-authenticated rules.
   */
  async sendTextMessage(jid: string, text: string): Promise<void> {
    if (!this.socket || this.state !== 'connected') {
      throw new Error('Cannot send a WhatsApp message: this account is not currently connected');
    }
    await this.socket.sendMessage(jid, { text });
  }

  /**
   * Deletes a message "for everyone" by sending Baileys' revoke protocol
   * message (`sendMessage(jid, { delete: key })` — verified against the
   * installed @whiskeysockets/baileys 6.7.24 types). WhatsApp itself
   * enforces who may delete what: the connected account can always delete
   * its own messages, and can delete another participant's message only
   * if it holds group-admin permissions — a permission failure surfaces
   * as a thrown error here, never a silent no-op. Only reachable from
   * moderation rule execution (src/rules/moderation/moderationActionEngine.ts),
   * itself gated by `moderation_destructive_actions_enabled`.
   */
  async deleteMessage(key: {
    remoteJid: string;
    id: string;
    participant: string | undefined;
    fromMe: boolean;
  }): Promise<void> {
    if (!this.socket || this.state !== 'connected') {
      throw new Error('Cannot delete a WhatsApp message: this account is not currently connected');
    }
    await this.socket.sendMessage(key.remoteJid, {
      delete: {
        remoteJid: key.remoteJid,
        id: key.id,
        fromMe: key.fromMe,
        ...(key.participant ? { participant: key.participant } : {}),
      },
    });
  }

  /**
   * Removes a participant from a group (`groupParticipantsUpdate(jid,
   * [participantJid], 'remove')` — verified against the installed
   * Baileys types' `ParticipantAction` union). Requires the connected
   * account to hold group-admin permissions; WhatsApp enforces this
   * server-side and a failure surfaces as a thrown error. Only reachable
   * from moderation rule execution, gated by
   * `moderation_destructive_actions_enabled`.
   */
  async removeParticipant(groupJid: string, participantJid: string): Promise<void> {
    if (!this.socket || this.state !== 'connected') {
      throw new Error('Cannot remove a participant: this account is not currently connected');
    }
    await this.socket.groupParticipantsUpdate(groupJid, [participantJid], 'remove');
  }

  /**
   * Rejects an incoming call (`rejectCall(callId, callFrom)` — verified
   * against the installed Baileys types). Used for the `AUTO_REJECT`
   * call-response action (src/whatsapp/calls/callHandler.ts). Baileys
   * does not implement WebRTC media handling, so there is no "answer" or
   * audio capability to expose — only reject.
   */
  async rejectCall(callId: string, callFrom: string): Promise<void> {
    if (!this.socket) {
      throw new Error('Cannot reject a call: no active WhatsApp connection');
    }
    await this.socket.rejectCall(callId, callFrom);
  }

  /**
   * Requests a WhatsApp linking code as an alternative to scanning a QR
   * (verified against @whiskeysockets/baileys 6.7.24's actual
   * `requestPairingCode` implementation — see docs/DECISIONS.md). Only
   * valid while a socket exists and hasn't registered yet (i.e. during
   * `connecting`/`awaiting_qr`); throws otherwise. `phoneNumber` must be
   * digits only, no leading `+` (E.164 local-part form, matching how
   * OWNER_WHATSAPP_NUMBERS is already documented in .env.example).
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.socket) {
      throw new Error('No active WhatsApp connection attempt to request a pairing code for');
    }
    const socket = this.socket;
    await socket.waitForSocketOpen();
    if (this.socket !== socket) {
      throw new Error('WhatsApp connection changed while requesting a pairing code');
    }
    const code = await socket.requestPairingCode(phoneNumber);
    this.lastPairingCode = code;
    this.lastPairingPhoneNumber = phoneNumber;
    this.setState(
      'awaiting_pairing_code',
      'Enter this code in WhatsApp > Linked Devices > Link with phone number instead',
    );
    return code;
  }

  /**
   * Explicit, owner-initiated logout: unlinks the device and clears local
   * credentials. Reachable from the dashboard's "Disconnect" action
   * (src/web/accountRoutes.ts) and reserved for the future Phase 11
   * WhatsApp-native command system (`.bot logout` or similar) too.
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
