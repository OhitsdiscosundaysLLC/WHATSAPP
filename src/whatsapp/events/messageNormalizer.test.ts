import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { normalizeMessage } from './messageNormalizer';

function groupTextMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: '123456789-987654321@g.us',
      fromMe: false,
      id: 'MSG1',
      participant: '15551234567@s.whatsapp.net',
    },
    message: { conversation: 'Hello group' },
    messageTimestamp: 1_700_000_000,
    ...overrides,
  } as WAMessage;
}

function privateTextMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: '15551234567@s.whatsapp.net',
      fromMe: false,
      id: 'MSG2',
    },
    message: { conversation: 'Hello private' },
    messageTimestamp: 1_700_000_000,
    ...overrides,
  } as WAMessage;
}

describe('normalizeMessage', () => {
  it('returns undefined for a message with no content (e.g. a protocol/reaction-only event)', () => {
    const waMessage = { key: { remoteJid: 'x@g.us', id: 'MSG0' } } as WAMessage;
    expect(normalizeMessage('acct-1', waMessage)).toBeUndefined();
  });

  it('returns undefined when remoteJid or message id is missing', () => {
    expect(
      normalizeMessage('acct-1', {
        key: { id: 'MSG0' },
        message: { conversation: 'x' },
      } as WAMessage),
    ).toBeUndefined();
    expect(
      normalizeMessage('acct-1', {
        key: { remoteJid: 'x@g.us' },
        message: { conversation: 'x' },
      } as WAMessage),
    ).toBeUndefined();
  });

  it('identifies a group message, extracting the participant as sender (not the group JID)', () => {
    const event = normalizeMessage('acct-1', groupTextMessage());
    expect(event?.context).toBe('group');
    expect(event?.groupJid).toBe('123456789-987654321@g.us');
    expect(event?.chatJid).toBe('123456789-987654321@g.us');
    expect(event?.senderJid).toBe('15551234567@s.whatsapp.net');
    expect(event?.text).toBe('Hello group');
  });

  it('identifies a private message, using the chat JID as sender', () => {
    const event = normalizeMessage('acct-1', privateTextMessage());
    expect(event?.context).toBe('private');
    expect(event?.groupJid).toBeUndefined();
    expect(event?.senderJid).toBe('15551234567@s.whatsapp.net');
  });

  it('marks fromMe correctly and does not mistake our own outgoing message for an incoming one', () => {
    const event = normalizeMessage(
      'acct-1',
      groupTextMessage({
        key: {
          remoteJid: '123456789-987654321@g.us',
          fromMe: true,
          id: 'MSG3',
        },
      }),
    );
    expect(event?.fromMe).toBe(true);
  });

  it('extracts text from extendedTextMessage', () => {
    const event = normalizeMessage(
      'acct-1',
      groupTextMessage({
        message: { extendedTextMessage: { text: 'Congrats sir' } },
      }),
    );
    expect(event?.messageType).toBe('extendedTextMessage');
    expect(event?.text).toBe('Congrats sir');
  });

  it('extracts the quoted message id and participant from contextInfo', () => {
    const event = normalizeMessage(
      'acct-1',
      groupTextMessage({
        message: {
          extendedTextMessage: {
            text: 'Congrats sir',
            contextInfo: {
              stanzaId: 'ANNOUNCEMENT_MSG_ID',
              participant: '15559998888@s.whatsapp.net',
            },
          },
        },
      }),
    );
    expect(event?.quotedWhatsappMessageId).toBe('ANNOUNCEMENT_MSG_ID');
    expect(event?.quotedParticipant).toBe('15559998888@s.whatsapp.net');
  });

  it('has no quoted message id when the message is not a reply', () => {
    const event = normalizeMessage('acct-1', groupTextMessage());
    expect(event?.quotedWhatsappMessageId).toBeUndefined();
  });

  it('extracts caption text from an image message', () => {
    const event = normalizeMessage(
      'acct-1',
      groupTextMessage({
        message: { imageMessage: { caption: 'Look at this', mimetype: 'image/jpeg' } },
      }),
    );
    expect(event?.messageType).toBe('imageMessage');
    expect(event?.text).toBe('Look at this');
  });

  it('reports a sensible messageType with no text for a media message without a caption', () => {
    const event = normalizeMessage(
      'acct-1',
      groupTextMessage({
        message: { audioMessage: { mimetype: 'audio/ogg' } },
      }),
    );
    expect(event?.messageType).toBe('audioMessage');
    expect(event?.text).toBeUndefined();
  });

  it('converts the WhatsApp timestamp (seconds) into an ISO string', () => {
    const event = normalizeMessage('acct-1', groupTextMessage({ messageTimestamp: 1_700_000_000 }));
    expect(event?.timestamp).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
});
