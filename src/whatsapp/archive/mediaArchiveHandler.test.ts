import type { SupabaseClient } from '@supabase/supabase-js';
import type { WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../db/auditRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { MediaArchiveRepository } from '../../db/mediaArchiveRepository';
import {
  DEFAULT_PRIVATE_MEDIA_MAX_FILE_SIZE_BYTES,
  handleGeneralMediaMessage,
  isGeneralMediaMessageType,
} from './mediaArchiveHandler';

const { downloadMediaMessageMock } = vi.hoisted(() => ({
  downloadMediaMessageMock: vi.fn<(...args: unknown[]) => Promise<Buffer>>(),
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, downloadMediaMessage: downloadMediaMessageMock };
});

const testLogger = pino({ level: 'silent' });

function waImageMessage(overrides: Record<string, unknown> = {}): WAMessage {
  return {
    key: {
      remoteJid: 'group@g.us',
      fromMe: false,
      id: 'MSG1',
      participant: 'alice@s.whatsapp.net',
    },
    message: {
      imageMessage: { mimetype: 'image/jpeg', fileLength: '100', ...overrides },
    },
  } as unknown as WAMessage;
}

function waDocumentMessage(overrides: Record<string, unknown> = {}): WAMessage {
  return {
    key: {
      remoteJid: 'group@g.us',
      fromMe: false,
      id: 'MSG1',
      participant: 'alice@s.whatsapp.net',
    },
    message: {
      documentMessage: { mimetype: 'application/pdf', fileLength: '100', ...overrides },
    },
  } as unknown as WAMessage;
}

afterEach(() => {
  downloadMediaMessageMock.mockReset();
});

function setup() {
  const fake = new FakeSupabaseClient();
  const mediaArchiveRepository = new MediaArchiveRepository(fake as unknown as SupabaseClient);
  const auditRepository = new AuditRepository(fake as unknown as SupabaseClient);
  const uploadMock = vi.fn(async () => ({ error: null as { message: string } | null }));
  const fromMock = vi.fn(() => ({ upload: uploadMock }));
  const supabase = { storage: { from: fromMock } } as unknown as SupabaseClient;
  return { fake, mediaArchiveRepository, auditRepository, uploadMock, fromMock, supabase };
}

describe('isGeneralMediaMessageType', () => {
  it('recognizes image/video/audio/document/sticker messages', () => {
    expect(isGeneralMediaMessageType('imageMessage')).toBe(true);
    expect(isGeneralMediaMessageType('videoMessage')).toBe(true);
    expect(isGeneralMediaMessageType('audioMessage')).toBe(true);
    expect(isGeneralMediaMessageType('documentMessage')).toBe(true);
    expect(isGeneralMediaMessageType('stickerMessage')).toBe(true);
  });

  it('never claims a view-once wrapper or plain text as general media (viewOnceHandler owns those)', () => {
    expect(isGeneralMediaMessageType('viewOnceMessage')).toBe(false);
    expect(isGeneralMediaMessageType('viewOnceMessageV2')).toBe(false);
    expect(isGeneralMediaMessageType('conversation')).toBe(false);
    expect(isGeneralMediaMessageType('extendedTextMessage')).toBe(false);
  });
});

describe('handleGeneralMediaMessage', () => {
  it('downloads, uploads, and records an eligible group image', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-image-bytes'));
    const { mediaArchiveRepository, auditRepository, uploadMock, fromMock, supabase } = setup();

    await handleGeneralMediaMessage(
      waImageMessage(),
      'MSG1',
      'alice@s.whatsapp.net',
      'imageMessage',
      { groupId: 'group-1', contactId: undefined },
      16_777_216,
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    expect(fromMock).toHaveBeenCalledWith('whatsapp-media');
    expect(uploadMock).toHaveBeenCalledWith(
      'acct-1/group-group-1/MSG1',
      expect.anything(),
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );

    const recorded = await mediaArchiveRepository.findByMessageId('acct-1', 'MSG1');
    expect(recorded).toMatchObject({
      groupId: 'group-1',
      contactId: undefined,
      isViewOnce: false,
      mimeType: 'image/jpeg',
    });

    const events = await auditRepository.listRecent();
    expect(events.some((e) => e.eventType === 'media.archived')).toBe(true);
  });

  it('records a private-contact media archive with contactId, not groupId', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-doc-bytes'));
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await handleGeneralMediaMessage(
      waDocumentMessage(),
      'MSG2',
      'alice@s.whatsapp.net',
      'documentMessage',
      { groupId: undefined, contactId: 'contact-1' },
      DEFAULT_PRIVATE_MEDIA_MAX_FILE_SIZE_BYTES,
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    const recorded = await mediaArchiveRepository.findByMessageId('acct-1', 'MSG2');
    expect(recorded).toMatchObject({ groupId: undefined, contactId: 'contact-1' });
  });

  it('skips before downloading when the declared size exceeds the limit', async () => {
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await handleGeneralMediaMessage(
      waImageMessage({ fileLength: '99999999' }),
      'MSG3',
      'alice@s.whatsapp.net',
      'imageMessage',
      { groupId: 'group-1', contactId: undefined },
      1000,
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
    expect(await mediaArchiveRepository.findByMessageId('acct-1', 'MSG3')).toBeUndefined();
  });

  it('discards the downloaded buffer (never uploads) when the actual size exceeds the limit', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.alloc(2000));
    const { mediaArchiveRepository, auditRepository, uploadMock, supabase } = setup();

    await handleGeneralMediaMessage(
      waImageMessage({ fileLength: undefined }),
      'MSG4',
      'alice@s.whatsapp.net',
      'imageMessage',
      { groupId: 'group-1', contactId: undefined },
      1000,
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    expect(uploadMock).not.toHaveBeenCalled();
    expect(await mediaArchiveRepository.findByMessageId('acct-1', 'MSG4')).toBeUndefined();
  });

  it('does nothing when the message carries no content for the given type (never throws)', async () => {
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await expect(
      handleGeneralMediaMessage(
        { key: { remoteJid: 'group@g.us', fromMe: false, id: 'MSG5' }, message: {} } as WAMessage,
        'MSG5',
        'alice@s.whatsapp.net',
        'imageMessage',
        { groupId: 'group-1', contactId: undefined },
        16_777_216,
        {
          accountId: 'acct-1',
          supabase,
          mediaArchiveRepository,
          auditRepository,
          logger: testLogger,
        },
      ),
    ).resolves.not.toThrow();
    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
  });

  it('logs and swallows an upload failure rather than throwing or recording a broken row', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('bytes'));
    const { mediaArchiveRepository, auditRepository } = setup();
    const failingSupabase = {
      storage: { from: () => ({ upload: vi.fn(async () => ({ error: { message: 'boom' } })) }) },
    } as unknown as SupabaseClient;

    await expect(
      handleGeneralMediaMessage(
        waImageMessage(),
        'MSG6',
        'alice@s.whatsapp.net',
        'imageMessage',
        { groupId: 'group-1', contactId: undefined },
        16_777_216,
        {
          accountId: 'acct-1',
          supabase: failingSupabase,
          mediaArchiveRepository,
          auditRepository,
          logger: testLogger,
        },
      ),
    ).resolves.not.toThrow();
    expect(await mediaArchiveRepository.findByMessageId('acct-1', 'MSG6')).toBeUndefined();
  });

  it('logs and swallows a download failure rather than throwing', async () => {
    downloadMediaMessageMock.mockRejectedValueOnce(new Error('network error'));
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await expect(
      handleGeneralMediaMessage(
        waImageMessage(),
        'MSG7',
        'alice@s.whatsapp.net',
        'imageMessage',
        { groupId: 'group-1', contactId: undefined },
        16_777_216,
        {
          accountId: 'acct-1',
          supabase,
          mediaArchiveRepository,
          auditRepository,
          logger: testLogger,
        },
      ),
    ).resolves.not.toThrow();
  });
});
