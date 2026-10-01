import QRCode from 'qrcode';
import type { PairingSnapshot } from '../whatsapp/types';

/**
 * Client-facing shape of a `PairingSnapshot`: the raw QR string is never
 * sent to the browser — it's rendered server-side into a scannable PNG
 * data URL instead, so the dashboard needs no client-side QR library (and
 * nothing resembling the raw QR payload crosses the wire more than once).
 */
export type ClientPairingSnapshot = Omit<PairingSnapshot, 'qr'> & {
  qrImage?: string;
};

export async function toClientPairingSnapshot(
  snapshot: PairingSnapshot,
): Promise<ClientPairingSnapshot> {
  const { qr, ...rest } = snapshot;
  if (!qr) {
    return rest;
  }
  const qrImage = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  return { ...rest, qrImage };
}
