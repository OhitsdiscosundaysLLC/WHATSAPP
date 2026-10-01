/**
 * Internal WhatsApp connection state. Deliberately not derived from "does a
 * socket object exist" — the connection manager sets this explicitly at
 * every lifecycle transition (see docs/ARCHITECTURE.md).
 */
export type WhatsAppConnectionState =
  | 'disabled'
  | 'initializing'
  | 'awaiting_qr'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'logged_out'
  | 'error';

export interface WhatsAppStatus {
  state: WhatsAppConnectionState;
  /** Human-readable context for the current state (never secret material). */
  detail?: string | undefined;
  reconnectAttempt: number;
  lastConnectedAt?: string | undefined;
  lastDisconnectedAt?: string | undefined;
  updatedAt: string;
}
