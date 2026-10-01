import { isLidUser, jidNormalizedUser, type WAMessage } from '@whiskeysockets/baileys';
import type { IdentityMapRepository } from '../../db/identityMapRepository';

/**
 * A sender's identity as WhatsApp presented it for one specific message.
 * Verified against the installed @whiskeysockets/baileys 6.7.24 types:
 * `WAMessageKey` extends the raw protobuf `IMessageKey` with
 * `senderLid`/`senderPn` (non-group) and `participantLid`/`participantPn`
 * (group) — Baileys' own first-class representation of "this person, in
 * both addressing forms, when it knows both." Not inferred, not guessed.
 */
export interface SenderIdentityCandidates {
  /** The JID this codebase already treats as "the sender" (messageNormalizer's senderJid) — may be either form. */
  primary: string;
  /** From participantPn/senderPn, normalized, when Baileys provided it on this message. */
  phoneJid: string | undefined;
  /** From participantLid/senderLid, normalized, when Baileys provided it on this message. */
  lidJid: string | undefined;
}

/**
 * Extracts every identity form Baileys attached to this message's sender —
 * pure, synchronous, no I/O. Works for both group messages (`participantLid`/
 * `participantPn`) and private messages (`senderLid`/`senderPn`).
 */
export function extractIdentityCandidates(
  waMessage: WAMessage,
  isGroup: boolean,
): SenderIdentityCandidates {
  const key = waMessage.key as typeof waMessage.key & {
    senderLid?: string;
    senderPn?: string;
    participantLid?: string;
    participantPn?: string;
  };

  const rawLid = isGroup ? key.participantLid : key.senderLid;
  const rawPhone = isGroup ? key.participantPn : key.senderPn;
  const rawPrimary = isGroup ? (waMessage.participant ?? key.participant) : key.remoteJid;

  return {
    primary: rawPrimary ? jidNormalizedUser(rawPrimary) || rawPrimary : '',
    phoneJid: rawPhone ? jidNormalizedUser(rawPhone) || rawPhone : undefined,
    lidJid: rawLid ? jidNormalizedUser(rawLid) || rawLid : undefined,
  };
}

/**
 * Opportunistically records this message's lid<->phone pairing (when
 * Baileys gave us both) so future messages from the same person can be
 * resolved even on a message that only carries one form. Best-effort:
 * never allowed to break the caller.
 */
export async function recordIdentityIfKnown(
  candidates: SenderIdentityCandidates,
  accountId: string,
  identityMapRepository: IdentityMapRepository,
): Promise<void> {
  const lidJid =
    candidates.lidJid ?? (isLidUser(candidates.primary) ? candidates.primary : undefined);
  const phoneJid =
    candidates.phoneJid ?? (!isLidUser(candidates.primary) ? candidates.primary : undefined);
  if (!lidJid || !phoneJid) return;
  await identityMapRepository.upsert(accountId, lidJid, phoneJid);
}

/**
 * Resolves whether this sender is a configured owner/admin, trying every
 * identity form WhatsApp gave us for this message, then falling back to
 * the durable `whatsapp_identity_map` when the primary identity is an
 * `@lid` we've previously seen paired with a phone number (e.g. from an
 * earlier message, or from group-participant discovery — see
 * src/whatsapp/groups/groupDiscovery.ts). Never authorizes by display
 * name or any other unverified signal — only JIDs compared against
 * OWNER_WHATSAPP_NUMBERS/ADMIN_WHATSAPP_NUMBERS.
 */
export async function resolveAuthorizedRole(
  candidates: SenderIdentityCandidates,
  accountId: string,
  identityMapRepository: IdentityMapRepository,
  ownerNumbers: string[],
  adminNumbers: string[],
): Promise<'owner' | 'admin' | undefined> {
  const ownerJids = new Set(ownerNumbers.map((n) => `${n}@s.whatsapp.net`));
  const adminJids = new Set(adminNumbers.map((n) => `${n}@s.whatsapp.net`));

  const directCandidates = [candidates.primary, candidates.phoneJid].filter((jid): jid is string =>
    Boolean(jid),
  );
  for (const jid of directCandidates) {
    if (ownerJids.has(jid)) return 'owner';
  }
  for (const jid of directCandidates) {
    if (adminJids.has(jid)) return 'admin';
  }

  const lidToResolve =
    candidates.lidJid ?? (isLidUser(candidates.primary) ? candidates.primary : undefined);
  if (lidToResolve) {
    const mappedPhone = await identityMapRepository.getPhoneJidForLid(accountId, lidToResolve);
    if (mappedPhone) {
      if (ownerJids.has(mappedPhone)) return 'owner';
      if (adminJids.has(mappedPhone)) return 'admin';
    }
  }

  return undefined;
}
