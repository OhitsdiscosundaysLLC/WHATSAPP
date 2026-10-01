import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { GroupsRepository } from '../../db/groupsRepository';
import type { IdentityMapRepository } from '../../db/identityMapRepository';
import type { DiscoveredGroup } from '../connectionManager';

/**
 * Upserts every discovered group (identity = account + JID, never the
 * display name — see docs/DECISIONS.md ADR-012) and ensures each has a
 * safe-defaults `group_settings` row. Called from
 * `WhatsAppConnectionManager`'s `onGroupsDiscovered` callback, both for the
 * full post-connect sync (`groupFetchAllParticipating()`) and for live
 * `groups.upsert`/`groups.update` events (new group, rename).
 *
 * Also opportunistically seeds the durable `@lid` <-> phone-number
 * identity map (`identityMapRepository`, optional — only passed when
 * Supabase is configured) from each participant's `Contact.lid`/`.jid`
 * pair, when a full `groupFetchAllParticipating()` fetch provided them.
 * This is what lets owner/admin command authorization resolve a sender's
 * `@lid` identity even before that person has ever sent a message the
 * bot observed directly — see src/whatsapp/identity/identityResolver.ts.
 */
export async function handleDiscoveredGroups(
  accountId: string,
  groups: DiscoveredGroup[],
  groupsRepository: GroupsRepository,
  identityMapRepository?: IdentityMapRepository,
): Promise<void> {
  for (const group of groups) {
    await groupsRepository.upsertDiscoveredGroup(accountId, group.jid, group.subject);

    if (!identityMapRepository || !group.participants) continue;
    for (const participant of group.participants) {
      if (!participant.lid || !participant.jid) continue;
      const lidJid = jidNormalizedUser(participant.lid) || participant.lid;
      const phoneJid = jidNormalizedUser(participant.jid) || participant.jid;
      await identityMapRepository.upsert(accountId, lidJid, phoneJid).catch(() => undefined); // best-effort enrichment — never block group discovery
    }
  }
}
