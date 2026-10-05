import { createHash } from 'crypto';
import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditRepository } from '../../db/auditRepository';
import type { MediaArchiveRepository } from '../../db/mediaArchiveRepository';

const STORAGE_BUCKET = 'whatsapp-media';

/** Top-level Baileys message keys this handler archives — deliberately excludes the view-once wrapper types, which `viewOnceHandler.ts` already owns. */
const GENERAL_MEDIA_MESSAGE_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
]);

/** Contacts have no configurable size limit field (unlike groups) — same default as `DEFAULT_GROUP_SETTINGS.mediaMaxFileSizeBytes`. */
export const DEFAULT_PRIVATE_MEDIA_MAX_FILE_SIZE_BYTES = 16_777_216;

export function isGeneralMediaMessageType(messageType: string): boolean {
  return GENERAL_MEDIA_MESSAGE_TYPES.has(messageType);
}

interface MediaInfo {
  mimeType: string;
  fileLengthBytes: number | undefined;
}

function getMediaInfo(waMessage: WAMessage, messageType: string): MediaInfo | undefined {
  const content = (waMessage.message as Record<string, unknown> | null | undefined)?.[
    messageType
  ] as { mimetype?: unknown; fileLength?: unknown } | undefined;
  if (!content) return undefined;
  return {
    mimeType: typeof content.mimetype === 'string' ? content.mimetype : 'application/octet-stream',
    fileLengthBytes:
      content.fileLength !== undefined && content.fileLength !== null
        ? Number(content.fileLength)
        : undefined,
  };
}

export interface MediaArchiveHandlerDeps {
  accountId: string;
  supabase: SupabaseClient;
  mediaArchiveRepository: MediaArchiveRepository;
  auditRepository: AuditRepository;
  logger: Logger;
}

/** Exactly one of groupId/contactId is set. */
export interface MediaArchiveScope {
  groupId: string | undefined;
  contactId: string | undefined;
}

/**
 * Archives ordinary (non-view-once) incoming media — images, videos,
 * audio, documents, stickers — when explicitly opted in
 * (`media_archive_enabled`), the same opt-in-only posture as every other
 * archival feature in this project (docs/SECURITY.md). Requires monitoring
 * to already be on for this group/contact, matching `handleViewOnceMessage`'s
 * reasoning exactly. Enforces the configured size limit before download
 * (when Baileys reports a declared size) and again on the actual
 * downloaded buffer. Best-effort: any failure is logged and swallowed,
 * never allowed to break the rest of the event pipeline.
 */
export async function handleGeneralMediaMessage(
  waMessage: WAMessage,
  whatsappMessageId: string,
  senderJid: string,
  messageType: string,
  scope: MediaArchiveScope,
  maxFileSizeBytes: number,
  deps: MediaArchiveHandlerDeps,
): Promise<void> {
  const info = getMediaInfo(waMessage, messageType);
  if (!info) return;

  if (info.fileLengthBytes !== undefined && info.fileLengthBytes > maxFileSizeBytes) {
    deps.logger.info(
      { ...scope, declaredBytes: info.fileLengthBytes, limit: maxFileSizeBytes },
      'Media exceeds the configured size limit — skipped before download',
    );
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await downloadMediaMessage(waMessage, 'buffer', {});
  } catch (err) {
    deps.logger.warn({ err, ...scope }, 'Failed to download media for archive');
    return;
  }

  if (buffer.length > maxFileSizeBytes) {
    deps.logger.warn(
      { ...scope, actualBytes: buffer.length, limit: maxFileSizeBytes },
      'Downloaded media exceeded the configured size limit — discarded, not uploaded',
    );
    return;
  }

  const scopeSegment = scope.groupId ? `group-${scope.groupId}` : `contact-${scope.contactId}`;
  const storagePath = `${deps.accountId}/${scopeSegment}/${whatsappMessageId}`;
  const { error: uploadError } = await deps.supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: info.mimeType, upsert: false });
  if (uploadError) {
    deps.logger.warn({ err: uploadError, ...scope }, 'Failed to upload archived media');
    return;
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  await deps.mediaArchiveRepository.record({
    accountId: deps.accountId,
    groupId: scope.groupId,
    contactId: scope.contactId,
    whatsappMessageId,
    senderJid,
    isViewOnce: false,
    storagePath,
    mimeType: info.mimeType,
    fileSizeBytes: buffer.length,
    sha256,
  });

  await deps.auditRepository.recordEvent({
    accountId: deps.accountId,
    groupId: scope.groupId,
    contactId: scope.contactId,
    eventType: 'media.archived',
    detail: {
      whatsappMessageId,
      mimeType: info.mimeType,
      fileSizeBytes: buffer.length,
      messageType,
    },
  });
}
