import type { SupabaseClient } from '@supabase/supabase-js';
import type { WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../db/auditRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { MediaArchiveRepository } from '../../db/mediaArchiveRepository';
import { handleViewOnceMessage, isViewOnceMessageType } from './viewOnceHandler';

const { downloadMediaMessageMock } = vi.hoisted(() => ({
  downloadMediaMessageMock: vi.fn<(...args: unknown[]) => Promise<Buffer>>(),
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, downloadMediaMessage: downloadMediaMessageMock };
});

const testLogger = pino({ level: 'silent' });

function waViewOnceImage(overrides: Record<string, unknown> = {}): WAMessage {
  return {
    key: {
      remoteJid: 'group@g.us',
      fromMe: false,
      id: 'MSG1',
      participant: 'alice@s.whatsapp.net',
    },
    message: {
      viewOnceMessage: {
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: '100', ...overrides } },
      },
    },
  } as unknown as WAMessage;
}

function waViewOnceVideo(): WAMessage {
  return {
    key: {
      remoteJid: 'group@g.us',
      fromMe: false,
      id: 'MSG2',
      participant: 'alice@s.whatsapp.net',
    },
    message: {
      viewOnceMessageV2: {
        message: { videoMessage: { mimetype: 'video/mp4', fileLength: '200' } },
      },
    },
  } as unknown as WAMessage;
}

function waViewOnceAudio(): WAMessage {
  return {
    key: {
      remoteJid: 'group@g.us',
      fromMe: false,
      id: 'MSG3',
      participant: 'alice@s.whatsapp.net',
    },
    message: {
      viewOnceMessage: { message: { audioMessage: { mimetype: 'audio/ogg', fileLength: '50' } } },
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

describe('isViewOnceMessageType', () => {
  it('recognizes all three WhatsApp view-once wrapper keys', () => {
    expect(isViewOnceMessageType('viewOnceMessage')).toBe(true);
    expect(isViewOnceMessageType('viewOnceMessageV2')).toBe(true);
    expect(isViewOnceMessageType('viewOnceMessageV2Extension')).toBe(true);
  });

  it('never claims ordinary media or text as view-once', () => {
    expect(isViewOnceMessageType('imageMessage')).toBe(false);
    expect(isViewOnceMessageType('conversation')).toBe(false);
  });
});

describe('handleViewOnceMessage', () => {
  it('does nothing when options.enabled is false (incoming, opt-in gate off)', async () => {
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await handleViewOnceMessage(
      waViewOnceImage(),
      'MSG1',
      'alice@s.whatsapp.net',
      { groupId: 'group-1', contactId: undefined },
      { enabled: false, maxFileSizeBytes: 16_777_216 },
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
    expect(await mediaArchiveRepository.findByMessageId('acct-1', 'MSG1')).toBeUndefined();
  });

  it('downloads, uploads, and records an eligible group view-once image when enabled', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-view-once-bytes'));
    const { mediaArchiveRepository, auditRepository, uploadMock, fromMock, supabase } = setup();

    await handleViewOnceMessage(
      waViewOnceImage(),
      'MSG1',
      'alice@s.whatsapp.net',
      { groupId: 'group-1', contactId: undefined },
      { enabled: true, maxFileSizeBytes: 16_777_216 },
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
      isViewOnce: true,
      mimeType: 'image/jpeg',
    });
    const events = await auditRepository.listRecent();
    expect(events.some((e) => e.eventType === 'media.view_once_archived')).toBe(true);
  });

  it('archives a view-once video the same way', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-video-bytes'));
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await handleViewOnceMessage(
      waViewOnceVideo(),
      'MSG2',
      'alice@s.whatsapp.net',
      { groupId: 'group-1', contactId: undefined },
      { enabled: true, maxFileSizeBytes: 16_777_216 },
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    const recorded = await mediaArchiveRepository.findByMessageId('acct-1', 'MSG2');
    expect(recorded).toMatchObject({ isViewOnce: true, mimeType: 'video/mp4' });
  });

  it('records with contactId (not groupId) for a private-chat view-once message', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-image-bytes'));
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await handleViewOnceMessage(
      waViewOnceImage(),
      'MSG1',
      'alice@s.whatsapp.net',
      { groupId: undefined, contactId: 'contact-1' },
      { enabled: true, maxFileSizeBytes: 16_777_216 },
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    const recorded = await mediaArchiveRepository.findByMessageId('acct-1', 'MSG1');
    expect(recorded).toMatchObject({ groupId: undefined, contactId: 'contact-1' });
  });

  it('skips an unsupported inner type (view-once audio is not in SUPPORTED_INNER_TYPES) without downloading', async () => {
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await handleViewOnceMessage(
      waViewOnceAudio(),
      'MSG3',
      'alice@s.whatsapp.net',
      { groupId: 'group-1', contactId: undefined },
      { enabled: true, maxFileSizeBytes: 16_777_216 },
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

  it('skips before downloading when the declared size exceeds the limit', async () => {
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await handleViewOnceMessage(
      waViewOnceImage({ fileLength: '99999999' }),
      'MSG1',
      'alice@s.whatsapp.net',
      { groupId: 'group-1', contactId: undefined },
      { enabled: true, maxFileSizeBytes: 1000 },
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
  });

  it('discards the downloaded buffer (never uploads) when the actual size exceeds the limit', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.alloc(2000));
    const { mediaArchiveRepository, auditRepository, uploadMock, supabase } = setup();

    await handleViewOnceMessage(
      waViewOnceImage({ fileLength: undefined }),
      'MSG1',
      'alice@s.whatsapp.net',
      { groupId: 'group-1', contactId: undefined },
      { enabled: true, maxFileSizeBytes: 1000 },
      {
        accountId: 'acct-1',
        supabase,
        mediaArchiveRepository,
        auditRepository,
        logger: testLogger,
      },
    );

    expect(uploadMock).not.toHaveBeenCalled();
    expect(await mediaArchiveRepository.findByMessageId('acct-1', 'MSG1')).toBeUndefined();
  });

  it('logs and returns (never throws) when the download itself fails', async () => {
    downloadMediaMessageMock.mockRejectedValueOnce(new Error('network error'));
    const { mediaArchiveRepository, auditRepository, supabase } = setup();

    await expect(
      handleViewOnceMessage(
        waViewOnceImage(),
        'MSG1',
        'alice@s.whatsapp.net',
        { groupId: 'group-1', contactId: undefined },
        { enabled: true, maxFileSizeBytes: 16_777_216 },
        {
          accountId: 'acct-1',
          supabase,
          mediaArchiveRepository,
          auditRepository,
          logger: testLogger,
        },
      ),
    ).resolves.toBeUndefined();
  });
});
