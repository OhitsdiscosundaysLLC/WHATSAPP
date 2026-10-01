import type { SupabaseClient } from '@supabase/supabase-js';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../db/auditRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { GroupsRepository } from '../../db/groupsRepository';
import { MessagesRepository } from '../../db/messagesRepository';
import { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import {
  extractRevokedKey,
  handleDeletedMessage,
  type DeletedMessageHandlerDeps,
} from './deletedMessageHandler';

const testLogger = pino({ level: 'silent' });

function revokeMessage(targetId: string, targetParticipant?: string): WAMessage {
  return {
    key: { remoteJid: 'group@g.us', fromMe: false, id: 'REVOKE1' },
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.REVOKE,
        key: { remoteJid: 'group@g.us', id: targetId, participant: targetParticipant },
      },
    },
  } as WAMessage;
}

describe('extractRevokedKey', () => {
  it('extracts the target key from a REVOKE protocolMessage', () => {
    const key = extractRevokedKey(revokeMessage('ORIGINAL_MSG', 'alice@s.whatsapp.net'));
    expect(key).toEqual({
      remoteJid: 'group@g.us',
      id: 'ORIGINAL_MSG',
      participant: 'alice@s.whatsapp.net',
    });
  });

  it('returns undefined for a normal message', () => {
    const key = extractRevokedKey({
      key: { remoteJid: 'group@g.us', fromMe: false, id: 'MSG1' },
      message: { conversation: 'hi' },
    } as WAMessage);
    expect(key).toBeUndefined();
  });

  it('returns undefined for a non-REVOKE protocolMessage type', () => {
    const key = extractRevokedKey({
      key: { remoteJid: 'group@g.us', fromMe: false, id: 'MSG1' },
      message: {
        protocolMessage: { type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING },
      },
    } as WAMessage);
    expect(key).toBeUndefined();
  });
});

async function setup() {
  const fake = new FakeSupabaseClient();
  const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);
  const messagesRepository = new MessagesRepository(fake as unknown as SupabaseClient);
  const auditRepository = new AuditRepository(fake as unknown as SupabaseClient);
  const notificationCooldowns = new NotificationCooldownRepository(
    fake as unknown as SupabaseClient,
  );
  const sender = { sendTextMessage: vi.fn(async () => {}) };
  const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team');
  const deps: DeletedMessageHandlerDeps = {
    accountId: 'acct-1',
    groupsRepository,
    messagesRepository,
    auditRepository,
    notificationCooldowns,
    sender,
    ownerJids: ['15550001111@s.whatsapp.net'],
    logger: testLogger,
  };
  return { fake, groupsRepository, messagesRepository, auditRepository, sender, group, deps };
}

describe('handleDeletedMessage', () => {
  it('does nothing when deletedMessageArchiveEnabled is false (safe default)', async () => {
    const { deps, auditRepository } = await setup();
    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );
    const events = await auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'message.deleted')).toBeUndefined();
  });

  it('marks a previously-stored message as deleted when archiving is enabled', async () => {
    const { group, deps, groupsRepository, messagesRepository, fake } = await setup();
    await groupsRepository.updateSettings(group.id, { deletedMessageArchiveEnabled: true });
    await messagesRepository.store(
      {
        accountId: 'acct-1',
        chatJid: 'group@g.us',
        context: 'group',
        groupJid: 'group@g.us',
        whatsappMessageId: 'MSG1',
        senderJid: 'alice@s.whatsapp.net',
        fromMe: false,
        timestamp: new Date().toISOString(),
        messageType: 'conversation',
        text: 'hello',
        quotedWhatsappMessageId: undefined,
        quotedParticipant: undefined,
      },
      { groupId: group.id },
    );

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    const row = fake.rawRows('whatsapp_messages').find((r) => r.whatsapp_message_id === 'MSG1');
    expect(row?.deleted).toBe(true);
    expect(row?.deleted_at).toBeTruthy();
  });

  it('a message that was never stored (monitoring was off) is still audited, just not "archived"', async () => {
    const { group, deps, groupsRepository, auditRepository } = await setup();
    await groupsRepository.updateSettings(group.id, { deletedMessageArchiveEnabled: true });

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'NEVER_STORED', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    const events = await auditRepository.listRecent();
    const deletedEvent = events.find((e) => e.eventType === 'message.deleted');
    expect(deletedEvent?.detail).toMatchObject({ archived: false });
  });

  it('records an audit event when a message is archived-deleted', async () => {
    const { group, deps, groupsRepository, auditRepository } = await setup();
    await groupsRepository.updateSettings(group.id, { deletedMessageArchiveEnabled: true });

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    const events = await auditRepository.listRecent();
    const deletedEvent = events.find((e) => e.eventType === 'message.deleted');
    expect(deletedEvent).toBeDefined();
    expect(deletedEvent?.detail).toMatchObject({ whatsappMessageId: 'MSG1' });
  });

  it('notifies the owner (cooldown-protected) when configured', async () => {
    const { group, deps, groupsRepository, sender } = await setup();
    await groupsRepository.updateSettings(group.id, { deletedMessageArchiveEnabled: true });

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );
    expect(sender.sendTextMessage).toHaveBeenCalledTimes(1);

    // A second deletion in the same group right after — cooldown should suppress a second notification.
    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG2', participant: 'bob@s.whatsapp.net' },
      'group@g.us',
      deps,
    );
    expect(sender.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('never notifies when no owners are configured', async () => {
    const { group, deps, groupsRepository, sender } = await setup();
    deps.ownerJids = [];
    await groupsRepository.updateSettings(group.id, { deletedMessageArchiveEnabled: true });
    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );
    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('does nothing for an undiscovered group (never throws)', async () => {
    const { deps } = await setup();
    await expect(
      handleDeletedMessage(
        { remoteJid: 'unknown@g.us', id: 'MSG1', participant: undefined },
        'unknown@g.us',
        deps,
      ),
    ).resolves.not.toThrow();
  });
});
