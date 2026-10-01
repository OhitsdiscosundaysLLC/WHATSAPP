import type { Logger } from 'pino';
import type { ContactsRepository } from '../../db/contactsRepository';
import type { GroupsRepository } from '../../db/groupsRepository';
import type { MessagesRepository } from '../../db/messagesRepository';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Purges archived deleted-message *text* past each group's/contact's
 * configured retention-days setting (product spec Part D: "do not keep
 * everything forever by default"). Only clears `whatsapp_messages.text_content`
 * for already-deleted rows — never the row itself, which stays for audit
 * continuity (sender, timestamp, that a deletion happened).
 *
 * This is a best-effort periodic sweep (`setInterval`, see `startRetentionSweep`
 * below), not a real job scheduler — this project has no cron/queue
 * infrastructure yet. A missed sweep (e.g. the process was down) just means
 * the next sweep catches up; nothing depends on exact timing.
 */
export async function runRetentionSweep(
  groupsRepository: GroupsRepository,
  messagesRepository: MessagesRepository,
  logger: Logger,
  contactsRepository?: ContactsRepository,
): Promise<void> {
  const groups = await groupsRepository.listAll();
  for (const group of groups) {
    try {
      const settings = await groupsRepository.getSettings(group.id);
      if (!settings?.deletedMessageRetentionDays) continue; // undefined/0 = no automatic purge

      const cutoff = new Date(Date.now() - settings.deletedMessageRetentionDays * DAY_MS);
      const purgedCount = await messagesRepository.purgeExpiredDeletedContent(group.id, cutoff);
      if (purgedCount > 0) {
        logger.info({ groupId: group.id, purgedCount }, 'Purged expired deleted-message content');
      }
    } catch (err) {
      // One group's failure must never stop the sweep for every other group/contact.
      logger.warn({ err, groupId: group.id }, 'Retention sweep failed for group');
    }
  }

  if (!contactsRepository) return; // undefined only outside full production wiring — see accountManager.ts

  const contacts = await contactsRepository.listAll();
  for (const contact of contacts) {
    try {
      const settings = await contactsRepository.getSettings(contact.id);
      if (!settings?.deletedMessageRetentionDays) continue;

      const cutoff = new Date(Date.now() - settings.deletedMessageRetentionDays * DAY_MS);
      const purgedCount = await messagesRepository.purgeExpiredDeletedContentForContact(
        contact.id,
        cutoff,
      );
      if (purgedCount > 0) {
        logger.info(
          { contactId: contact.id, purgedCount },
          'Purged expired deleted-message content (private)',
        );
      }
    } catch (err) {
      logger.warn({ err, contactId: contact.id }, 'Retention sweep failed for contact');
    }
  }
}

/** Starts the periodic sweep. Returns a stop function. Safe to call at most once per process. */
export function startRetentionSweep(
  groupsRepository: GroupsRepository,
  messagesRepository: MessagesRepository,
  logger: Logger,
  contactsRepository?: ContactsRepository,
  intervalMs = 6 * 60 * 60 * 1000, // 6 hours
): () => void {
  const run = () => {
    runRetentionSweep(groupsRepository, messagesRepository, logger, contactsRepository).catch(
      (err: unknown) => logger.error({ err }, 'Retention sweep threw unexpectedly'),
    );
  };

  run(); // once at startup, don't wait a full interval before the first sweep
  const timer = setInterval(run, intervalMs);
  timer.unref?.(); // never keeps the process alive on its own

  return () => clearInterval(timer);
}
