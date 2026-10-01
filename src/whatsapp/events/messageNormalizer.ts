import {
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  type WAMessage,
} from '@whiskeysockets/baileys';

export type MessageContext = 'group' | 'private';

/**
 * A WhatsApp message reduced to exactly what the rest of the pipeline
 * needs. Deliberately does not carry the raw Baileys `WAMessage` — nothing
 * downstream (storage, rule engine, audit) should depend on, or risk
 * leaking, the full protobuf payload. See docs/DATABASE.md.
 */
export interface NormalizedMessageEvent {
  accountId: string;
  /** The chat this message belongs to — a group JID or the other party's JID. */
  chatJid: string;
  context: MessageContext;
  /** Only set when `context === 'group'` — same value as `chatJid`. */
  groupJid: string | undefined;
  whatsappMessageId: string;
  /** Normalized sender JID. For a group message this is the participant, not the group. */
  senderJid: string;
  fromMe: boolean;
  timestamp: string;
  messageType: string;
  text: string | undefined;
  quotedWhatsappMessageId: string | undefined;
  quotedParticipant: string | undefined;
}

const TEXT_BEARING_FIELDS = ['text', 'caption'] as const;

/**
 * Normalizes one Baileys `WAMessage` into a `NormalizedMessageEvent`, or
 * `undefined` if the message can't be meaningfully processed (missing key,
 * missing remoteJid, or an empty/protocol-only message with no content —
 * e.g. a reaction-only or history-sync marker with no `message` payload).
 *
 * Uses Baileys' own `getContentType`/`isJidGroup`/`jidNormalizedUser`
 * utilities rather than hand-rolled JID/content-type parsing — mirrored
 * from the installed @whiskeysockets/baileys 6.7.24 contract, the same
 * verification approach used throughout this project (see
 * src/whatsapp/auth/baileysSerialization.ts).
 */
export function normalizeMessage(
  accountId: string,
  waMessage: WAMessage,
): NormalizedMessageEvent | undefined {
  const key = waMessage.key;
  const chatJidRaw = key.remoteJid;
  const messageId = key.id;
  if (!chatJidRaw || !messageId || !waMessage.message) {
    return undefined;
  }

  const chatJid = jidNormalizedUser(chatJidRaw) || chatJidRaw;
  const isGroup = Boolean(isJidGroup(chatJidRaw));
  const context: MessageContext = isGroup ? 'group' : 'private';
  const fromMe = Boolean(key.fromMe);

  // In a group, the actual sender is `participant` (or `key.participant` for
  // fromMe messages in some Baileys versions); in a private chat, the
  // sender is the chat itself (us, if fromMe, otherwise the other party).
  const senderJidRaw =
    (isGroup ? (waMessage.participant ?? key.participant) : undefined) ??
    (fromMe ? undefined : chatJidRaw);
  const senderJid = senderJidRaw ? jidNormalizedUser(senderJidRaw) || senderJidRaw : 'unknown';

  const messageType = getContentType(waMessage.message) ?? 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (waMessage.message as Record<string, any>)[messageType];

  let text: string | undefined;
  if (messageType === 'conversation') {
    text =
      typeof waMessage.message.conversation === 'string'
        ? waMessage.message.conversation
        : undefined;
  } else if (content && typeof content === 'object') {
    for (const field of TEXT_BEARING_FIELDS) {
      if (typeof content[field] === 'string') {
        text = content[field];
        break;
      }
    }
  }

  const contextInfo =
    content && typeof content === 'object' && content.contextInfo ? content.contextInfo : undefined;
  const quotedWhatsappMessageId: string | undefined =
    typeof contextInfo?.stanzaId === 'string' ? contextInfo.stanzaId : undefined;
  const quotedParticipantRaw: string | undefined =
    typeof contextInfo?.participant === 'string' ? contextInfo.participant : undefined;
  const quotedParticipant = quotedParticipantRaw
    ? jidNormalizedUser(quotedParticipantRaw) || quotedParticipantRaw
    : undefined;

  const timestampValue = waMessage.messageTimestamp;
  const timestampMs = timestampValue
    ? Number(typeof timestampValue === 'object' ? timestampValue.toNumber() : timestampValue) * 1000
    : Date.now();

  return {
    accountId,
    chatJid,
    context,
    groupJid: isGroup ? chatJid : undefined,
    whatsappMessageId: messageId,
    senderJid,
    fromMe,
    timestamp: new Date(timestampMs).toISOString(),
    messageType,
    text,
    quotedWhatsappMessageId,
    quotedParticipant,
  };
}
