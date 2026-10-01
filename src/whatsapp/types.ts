/**
 * Internal WhatsApp connection state. Deliberately not derived from "does a
 * socket object exist" — the connection manager sets this explicitly at
 * every lifecycle transition (see docs/ARCHITECTURE.md).
 */
export type WhatsAppConnectionState =
  | 'disabled'
  | 'initializing'
  | 'awaiting_qr'
  | 'awaiting_pairing_code'
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

/**
 * `WhatsAppStatus` plus short-lived pairing material (QR / pairing code).
 * This is a STRICTLY SEPARATE type from `WhatsAppStatus` on purpose: nothing
 * that builds a `/health` or `/ready` response may ever construct one of
 * these. Only the authenticated dashboard pairing routes (`src/web/`) are
 * allowed to read it. See docs/SECURITY.md.
 */
export interface PairingSnapshot extends WhatsAppStatus {
  /** Current QR string to render, if any. Cleared on connect/replace/logout. */
  qr?: string | undefined;
  /** Current WhatsApp linking code to display, if a pairing-code flow was requested. */
  pairingCode?: string | undefined;
  /** The phone number a pairing code was most recently requested for. */
  pairingPhoneNumber?: string | undefined;
}

export type PairingListener = (snapshot: PairingSnapshot) => void;
