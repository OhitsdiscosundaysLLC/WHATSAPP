import { createHash } from 'crypto';
import {
  downloadMediaMessage,
  normalizeMessageContent,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditRepository } from '../../db/auditRepository';
import type { MediaArchiveRepository } from '../../db/mediaArchiveRepository';

const VIEW_ONCE_KEYS = new Set([
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
]);
const SUPPORTED_INNER_TYPES = new Set(['imageMessage', 'videoMessage']);
const STORAGE_BUCKET = 'whatsapp-media';

export function isViewOnceMessageType(messageType: string): boolean {
  return VIEW_ONCE_KEYS.has(messageType);
}

interface ViewOnceMediaInfo {
  innerType: string;
  mimeType: string;
  fileLengthBytes: number | undefined;
}

/**
 * Unwraps a view-once wrapper to find the real media content — `imageMessage`/
 * `videoMessage` are the realistic cases; anything else (e.g. a future
 * WhatsApp view-once audio type) is reported but left unsupported rather
 * than guessed at. Uses Baileys' own `normalizeMessageContent()`
 * (verified against the installed 6.7.24 source,
 * `lib/Utils/messages.js`), not a hand-rolled unwrap.
 */
function getViewOnceMediaInfo(waMessage: WAMessage): ViewOnceMediaInfo | undefined {
  const normalized = normalizeMessageContent(waMessage.message);
  if (!normalized) return undefined;
  const innerType = Object.keys(normalized).find((k) => k.includes('Message'));
  if (!innerType) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (normalized as Record<string, any>)[innerType];
  return {
    innerType,
    mimeType: typeof inner?.mimetype === 'string' ? inner.mimetype : 'application/octet-stream',
    fileLengthBytes: inner?.fileLength ? Number(inner.fileLength) : undefined,
  };
}

export interface ViewOnceHandlerDeps {
  accountId: string;
  supabase: SupabaseClient;
  mediaArchiveRepository: MediaArchiveRepository;
  auditRepository: AuditRepository;
  logger: Logger;
}

/** Exactly one of groupId/contactId is set. */
export interface ViewOnceScope {
  groupId: string | undefined;
  contactId: string | undefined;
}

export interface ViewOnceOptions {
  /**
   * Whether to archive at all. For incoming group messages this is
   * `view_once_handling_enabled && monitoring_enabled` (a genuinely
   * privacy-sensitive capability, opt-in per group — see
   * docs/SECURITY.md and docs/DECISIONS.md ADR-001); for incoming private
   * messages, `media_archive_enabled && private_monitoring_enabled`
   * (contacts have no separate view-once toggle — see
   * supabase/migrations). For the bot's OWN sent view-once media
   * (src/whatsapp/events/eventPipeline.ts's `handleSelfSentMessage`),
   * always `true` — the owner's own content is never subject to a
   * third-party-privacy opt-in gate.
   */
  enabled: boolean;
  maxFileSizeBytes: number;
}

/**
 * Archives eligible view-once media (incoming, opt-in per the caller's
 * `options.enabled`; or self-sent, always archived) BEFORE it disappears.
 * Enforces `maxFileSizeBytes` BEFORE downloading whenever Baileys reports
 * a declared size, and again on the actual downloaded buffer — a file is
 * never partially fetched past the limit, and an unexpectedly large actual
 * download is discarded rather than uploaded. Best-effort: any failure
 * here is logged and swallowed, never allowed to break the rest of the
 * event pipeline.
 */
export async function handleViewOnceMessage(
  waMessage: WAMessage,
  whatsappMessageId: string,
  senderJid: string,
  scope: ViewOnceScope,
  options: ViewOnceOptions,
  deps: ViewOnceHandlerDeps,
): Promise<void> {
  if (!options.enabled) return;

  const info = getViewOnceMediaInfo(waMessage);
  if (!info) return;

  if (!SUPPORTED_INNER_TYPES.has(info.innerType)) {
    deps.logger.info(
      { ...scope, innerType: info.innerType },
      'Unsupported view-once media type — skipping archive',
    );
    return;
  }

  if (info.fileLengthBytes !== undefined && info.fileLengthBytes > options.maxFileSizeBytes) {
    deps.logger.info(
      {
        ...scope,
        declaredBytes: info.fileLengthBytes,
        limit: options.maxFileSizeBytes,
      },
      'View-once media exceeds the configured size limit — skipped before download',
    );
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await downloadMediaMessage(waMessage, 'buffer', {});
  } catch (err) {
    deps.logger.warn({ err, ...scope }, 'Failed to download view-once media');
    return;
  }

  if (buffer.length > options.maxFileSizeBytes) {
    deps.logger.warn(
      { ...scope, actualBytes: buffer.length, limit: options.maxFileSizeBytes },
      'Downloaded view-once media exceeded the configured size limit — discarded, not uploaded',
    );
    return;
  }

  const scopeSegment = scope.groupId ? `group-${scope.groupId}` : `contact-${scope.contactId}`;
  const storagePath = `${deps.accountId}/${scopeSegment}/${whatsappMessageId}`;
  const { error: uploadError } = await deps.supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: info.mimeType, upsert: false });
  if (uploadError) {
    deps.logger.warn({ err: uploadError, ...scope }, 'Failed to upload archived view-once media');
    return;
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  await deps.mediaArchiveRepository.record({
    accountId: deps.accountId,
    groupId: scope.groupId,
    contactId: scope.contactId,
    whatsappMessageId,
    senderJid,
    isViewOnce: true,
    storagePath,
    mimeType: info.mimeType,
    fileSizeBytes: buffer.length,
    sha256,
  });

  await deps.auditRepository.recordEvent({
    accountId: deps.accountId,
    groupId: scope.groupId,
    contactId: scope.contactId,
    eventType: 'media.view_once_archived',
    detail: { whatsappMessageId, mimeType: info.mimeType, fileSizeBytes: buffer.length },
  });
}
