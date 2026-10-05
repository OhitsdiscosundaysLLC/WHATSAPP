import type { SupabaseClient } from '@supabase/supabase-js';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../db/auditRepository';
import { ContactsRepository } from '../../db/contactsRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { GroupsRepository } from '../../db/groupsRepository';
import { MediaArchiveRepository } from '../../db/mediaArchiveRepository';
import { MessagesRepository } from '../../db/messagesRepository';
import { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import { OwnerInboxRepository } from '../../db/ownerInboxRepository';
import {
  extractRevokedKey,
  handleDeletedMessage,
  handlePrivateDeletedMessage,
  type DeletedMessageHandlerDeps,
  type PrivateDeletedMessageHandlerDeps,
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
  const mediaArchiveRepository = new MediaArchiveRepository(fake as unknown as SupabaseClient);
  const auditRepository = new AuditRepository(fake as unknown as SupabaseClient);
  const ownerInbox = new OwnerInboxRepository(fake as unknown as SupabaseClient);
  const notificationCooldowns = new NotificationCooldownRepository(
    fake as unknown as SupabaseClient,
  );
  const sender = { sendTextMessage: vi.fn(async () => {}) };
  const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team');
  const deps: DeletedMessageHandlerDeps = {
    accountId: 'acct-1',
    groupsRepository,
    messagesRepository,
    mediaArchiveRepository,
    auditRepository,
    ownerInbox,
    notificationCooldowns,
    sender,
    ownerJids: ['15550001111@s.whatsapp.net'],
    logger: testLogger,
  };
  return {
    fake,
    groupsRepository,
    messagesRepository,
    mediaArchiveRepository,
    auditRepository,
    ownerInbox,
    sender,
    group,
    deps,
  };
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

  it('records an audit event when a message is archived-deleted, regardless of alert mode', async () => {
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

  it('the default alert mode (archive_only) never writes to the inbox or notifies — detection/archiving still happens', async () => {
    const { group, deps, groupsRepository, ownerInbox, sender } = await setup();
    await groupsRepository.updateSettings(group.id, { deletedMessageArchiveEnabled: true });
    // deletedMessageAlertMode defaults to 'archive_only' — never explicitly set here.

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    expect(await ownerInbox.list('acct-1')).toHaveLength(0);
    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('"dashboard" alert mode writes an Owner Inbox item but never sends a WhatsApp notification', async () => {
    const { group, deps, groupsRepository, ownerInbox, sender } = await setup();
    await groupsRepository.updateSettings(group.id, {
      deletedMessageArchiveEnabled: true,
      deletedMessageAlertMode: 'dashboard',
    });

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    expect(await ownerInbox.list('acct-1')).toHaveLength(1);
    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('"whatsapp" alert mode sends a notification but never writes to the Owner Inbox', async () => {
    const { group, deps, groupsRepository, ownerInbox, sender } = await setup();
    await groupsRepository.updateSettings(group.id, {
      deletedMessageArchiveEnabled: true,
      deletedMessageAlertMode: 'whatsapp',
    });

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    expect(await ownerInbox.list('acct-1')).toHaveLength(0);
    expect(sender.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('records an Owner Inbox item for every deletion — independent of the notification cooldown ("both" mode)', async () => {
    const { group, deps, groupsRepository, ownerInbox } = await setup();
    await groupsRepository.updateSettings(group.id, {
      deletedMessageArchiveEnabled: true,
      deletedMessageAlertMode: 'both',
    });

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );
    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG2', participant: 'bob@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    // Both deletions get an inbox item, even though the 2nd WhatsApp
    // notification was suppressed by cooldown — inbox visibility is never
    // throttled the way the outbound WhatsApp ping is.
    const items = await ownerInbox.list('acct-1');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ category: 'deleted_message', groupId: group.id });
  });

  it('notifies the owner (cooldown-protected) in "both" mode', async () => {
    const { group, deps, groupsRepository, sender } = await setup();
    await groupsRepository.updateSettings(group.id, {
      deletedMessageArchiveEnabled: true,
      deletedMessageAlertMode: 'both',
    });

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
    await groupsRepository.updateSettings(group.id, {
      deletedMessageArchiveEnabled: true,
      deletedMessageAlertMode: 'both',
    });
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

  it('links already-archived media to the deletion — audited and mentioned in the WhatsApp notification', async () => {
    const {
      group,
      deps,
      groupsRepository,
      messagesRepository,
      mediaArchiveRepository,
      auditRepository,
      sender,
    } = await setup();
    await groupsRepository.updateSettings(group.id, {
      deletedMessageArchiveEnabled: true,
      deletedMessageAlertMode: 'both',
    });
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
        messageType: 'imageMessage',
        text: undefined,
        quotedWhatsappMessageId: undefined,
        quotedParticipant: undefined,
      },
      { groupId: group.id },
    );
    await mediaArchiveRepository.record({
      accountId: 'acct-1',
      groupId: group.id,
      contactId: undefined,
      whatsappMessageId: 'MSG1',
      senderJid: 'alice@s.whatsapp.net',
      isViewOnce: false,
      storagePath: 'acct-1/group-x/MSG1',
      mimeType: 'image/jpeg',
      fileSizeBytes: 1234,
      sha256: undefined,
    });

    await handleDeletedMessage(
      { remoteJid: 'group@g.us', id: 'MSG1', participant: 'alice@s.whatsapp.net' },
      'group@g.us',
      deps,
    );

    const events = await auditRepository.listRecent();
    const deletedEvent = events.find((e) => e.eventType === 'message.deleted');
    expect(deletedEvent?.detail).toMatchObject({ hasArchivedMedia: true });
    expect(sender.sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Its media was archived'),
    );
  });
});

async function setupPrivate() {
  const fake = new FakeSupabaseClient();
  const contactsRepository = new ContactsRepository(fake as unknown as SupabaseClient);
  const messagesRepository = new MessagesRepository(fake as unknown as SupabaseClient);
  const mediaArchiveRepository = new MediaArchiveRepository(fake as unknown as SupabaseClient);
  const auditRepository = new AuditRepository(fake as unknown as SupabaseClient);
  const ownerInbox = new OwnerInboxRepository(fake as unknown as SupabaseClient);
  const notificationCooldowns = new NotificationCooldownRepository(
    fake as unknown as SupabaseClient,
  );
  const sender = { sendTextMessage: vi.fn(async () => {}) };
  const contact = await contactsRepository.upsertDiscoveredContact(
    'acct-1',
    'alice@s.whatsapp.net',
    'Alice',
  );
  const deps: PrivateDeletedMessageHandlerDeps = {
    accountId: 'acct-1',
    contactsRepository,
    messagesRepository,
    mediaArchiveRepository,
    auditRepository,
    ownerInbox,
    notificationCooldowns,
    sender,
    ownerJids: ['15550001111@s.whatsapp.net'],
    logger: testLogger,
  };
  return {
    fake,
    contactsRepository,
    messagesRepository,
    mediaArchiveRepository,
    auditRepository,
    ownerInbox,
    sender,
    contact,
    deps,
  };
}

describe('handlePrivateDeletedMessage', () => {
  it('does nothing when privateDeletedMessageArchiveEnabled is false (safe default)', async () => {
    const { deps, auditRepository } = await setupPrivate();
    await handlePrivateDeletedMessage(
      { remoteJid: 'alice@s.whatsapp.net', id: 'MSG1', participant: undefined },
      'alice@s.whatsapp.net',
      deps,
    );
    const events = await auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'message.deleted')).toBeUndefined();
  });

  it('marks a previously-stored private message as deleted when archiving is enabled', async () => {
    const { contact, deps, contactsRepository, messagesRepository, fake } = await setupPrivate();
    await contactsRepository.updateSettings(contact.id, {
      privateDeletedMessageArchiveEnabled: true,
    });
    await messagesRepository.store(
      {
        accountId: 'acct-1',
        chatJid: 'alice@s.whatsapp.net',
        context: 'private',
        groupJid: undefined,
        whatsappMessageId: 'MSG1',
        senderJid: 'alice@s.whatsapp.net',
        fromMe: false,
        timestamp: new Date().toISOString(),
        messageType: 'conversation',
        text: 'hello',
        quotedWhatsappMessageId: undefined,
        quotedParticipant: undefined,
      },
      { contactId: contact.id },
    );

    await handlePrivateDeletedMessage(
      { remoteJid: 'alice@s.whatsapp.net', id: 'MSG1', participant: undefined },
      'alice@s.whatsapp.net',
      deps,
    );

    const row = fake.rawRows('whatsapp_messages').find((r) => r.whatsapp_message_id === 'MSG1');
    expect(row?.deleted).toBe(true);
  });

  it('the default alert mode (archive_only) never writes to the inbox or notifies', async () => {
    const { contact, deps, contactsRepository, ownerInbox, sender } = await setupPrivate();
    await contactsRepository.updateSettings(contact.id, {
      privateDeletedMessageArchiveEnabled: true,
    });

    await handlePrivateDeletedMessage(
      { remoteJid: 'alice@s.whatsapp.net', id: 'MSG1', participant: undefined },
      'alice@s.whatsapp.net',
      deps,
    );

    expect(await ownerInbox.list('acct-1')).toHaveLength(0);
    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('"both" alert mode writes an inbox item and notifies, naming the contact', async () => {
    const { contact, deps, contactsRepository, ownerInbox, sender } = await setupPrivate();
    await contactsRepository.updateSettings(contact.id, {
      privateDeletedMessageArchiveEnabled: true,
      deletedMessageAlertMode: 'both',
    });

    await handlePrivateDeletedMessage(
      { remoteJid: 'alice@s.whatsapp.net', id: 'MSG1', participant: undefined },
      'alice@s.whatsapp.net',
      deps,
    );

    const items = await ownerInbox.list('acct-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'deleted_message', contactId: contact.id });
    expect(sender.sendTextMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Alice'),
    );
  });

  it('links already-archived media to the deletion', async () => {
    const { contact, deps, contactsRepository, mediaArchiveRepository, auditRepository } =
      await setupPrivate();
    await contactsRepository.updateSettings(contact.id, {
      privateDeletedMessageArchiveEnabled: true,
    });
    await mediaArchiveRepository.record({
      accountId: 'acct-1',
      groupId: undefined,
      contactId: contact.id,
      whatsappMessageId: 'MSG1',
      senderJid: 'alice@s.whatsapp.net',
      isViewOnce: false,
      storagePath: 'acct-1/contact-x/MSG1',
      mimeType: 'image/jpeg',
      fileSizeBytes: 1234,
      sha256: undefined,
    });

    await handlePrivateDeletedMessage(
      { remoteJid: 'alice@s.whatsapp.net', id: 'MSG1', participant: undefined },
      'alice@s.whatsapp.net',
      deps,
    );

    const events = await auditRepository.listRecent();
    const deletedEvent = events.find((e) => e.eventType === 'message.deleted');
    expect(deletedEvent?.detail).toMatchObject({ hasArchivedMedia: true });
  });

  it('does nothing for an undiscovered contact (never throws)', async () => {
    const { deps } = await setupPrivate();
    await expect(
      handlePrivateDeletedMessage(
        { remoteJid: 'unknown@s.whatsapp.net', id: 'MSG1', participant: undefined },
        'unknown@s.whatsapp.net',
        deps,
      ),
    ).resolves.not.toThrow();
  });
});
