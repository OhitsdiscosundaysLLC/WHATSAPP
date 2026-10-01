import type { GroupsRepository } from '../../db/groupsRepository';
import type { DiscoveredGroup } from '../connectionManager';

/**
 * Upserts every discovered group (identity = account + JID, never the
 * display name — see docs/DECISIONS.md ADR-012) and ensures each has a
 * safe-defaults `group_settings` row. Called from
 * `WhatsAppConnectionManager`'s `onGroupsDiscovered` callback, both for the
 * full post-connect sync (`groupFetchAllParticipating()`) and for live
 * `groups.upsert`/`groups.update` events (new group, rename).
 */
export async function handleDiscoveredGroups(
  accountId: string,
  groups: DiscoveredGroup[],
  groupsRepository: GroupsRepository,
): Promise<void> {
  for (const group of groups) {
    await groupsRepository.upsertDiscoveredGroup(accountId, group.jid, group.subject);
  }
}
