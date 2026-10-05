import type { SupabaseClient } from '@supabase/supabase-js';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AccountSettingsRepository } from '../../db/accountSettingsRepository';
import { AuditRepository } from '../../db/auditRepository';
import { ContactsRepository } from '../../db/contactsRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { GroupsRepository } from '../../db/groupsRepository';
import { IdentityMapRepository } from '../../db/identityMapRepository';
import { MediaArchiveRepository } from '../../db/mediaArchiveRepository';
import { MessagesRepository } from '../../db/messagesRepository';
import { ModerationStateRepository } from '../../db/moderationStateRepository';
import { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import { OwnerInboxRepository } from '../../db/ownerInboxRepository';
import { PendingApprovalsRepository } from '../../db/pendingApprovalsRepository';
import { RulesRepository } from '../../db/rulesRepository';
import { RuleStateRepository } from '../../db/ruleStateRepository';
import { DeterministicResponseClassifier } from '../../rules/classifiers/responseClassifier';
import { RuleEngine } from '../../rules/ruleEngine';
import { EventPipeline } from './eventPipeline';

const { downloadMediaMessageMock } = vi.hoisted(() => ({
  downloadMediaMessageMock: vi.fn<(...args: unknown[]) => Promise<Buffer>>(),
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, downloadMediaMessage: downloadMediaMessageMock };
});

const testLogger = pino({ level: 'silent' });
const ACCOUNT_ID = 'acct-1';

function waGroupMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: 'group@g.us',
      fromMe: false,
      id: 'MSG1',
      participant: 'sender@s.whatsapp.net',
    },
    message: { conversation: 'hello' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  } as WAMessage;
}

function setup() {
  const fake = new FakeSupabaseClient();
  fake.defineUniqueConstraint('whatsapp_processed_events', [
    'account_id',
    'chat_jid',
    'whatsapp_message_id',
  ]);
  const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);
  const contactsRepository = new ContactsRepository(fake as unknown as SupabaseClient);
  const messagesRepository = new MessagesRepository(fake as unknown as SupabaseClient);
  const rulesRepository = new RulesRepository(fake as unknown as SupabaseClient);
  const auditRepository = new AuditRepository(fake as unknown as SupabaseClient);
  const sender = { sendTextMessage: vi.fn(async () => {}) };
  const notificationCooldowns = new NotificationCooldownRepository(
    fake as unknown as SupabaseClient,
  );
  const mediaArchiveRepository = new MediaArchiveRepository(fake as unknown as SupabaseClient);
  // FakeSupabaseClient only simulates `.from(table)` (Postgres), never
  // Supabase Storage — attach a minimal working `.storage` so the
  // view-once/general-media archive handlers' `.storage.from(bucket).upload()`
  // call succeeds in tests that actually exercise media (most tests here
  // never touch media and never notice this exists).
  const storageUploadMock = vi.fn(async () => ({ error: null as { message: string } | null }));
  const storageFromMock = vi.fn(() => ({ upload: storageUploadMock }));
  (fake as unknown as { storage: unknown }).storage = { from: storageFromMock };
  const ownerInbox = new OwnerInboxRepository(fake as unknown as SupabaseClient);
  const pendingApprovals = new PendingApprovalsRepository(fake as unknown as SupabaseClient);
  const ruleEngine = new RuleEngine({
    rulesRepository,
    ruleStateRepository: new RuleStateRepository(fake as unknown as SupabaseClient),
    moderationStateRepository: new ModerationStateRepository(fake as unknown as SupabaseClient),
    auditRepository,
    ownerInbox,
    pendingApprovals,
    classifier: new DeterministicResponseClassifier(),
    sender,
    moderationCapabilities: {
      deleteMessage: vi.fn(async () => {}),
      removeParticipant: vi.fn(async () => {}),
    },
    ai: undefined,
    ownerJids: [],
    logger: testLogger,
  });
  const identityMapRepository = new IdentityMapRepository(fake as unknown as SupabaseClient);
  const accountSettingsRepository = new AccountSettingsRepository(
    fake as unknown as SupabaseClient,
  );
  const pipeline = new EventPipeline({
    accountId: ACCOUNT_ID,
    groupsRepository,
    contactsRepository,
    messagesRepository,
    identityMapRepository,
    ruleEngine,
    auditRepository,
    accountSettingsRepository,
    deletedMessageHandlerDeps: {
      groupsRepository,
      messagesRepository,
      mediaArchiveRepository,
      auditRepository,
      ownerInbox,
      notificationCooldowns,
      sender,
      ownerJids: [],
      logger: testLogger,
    },
    privateDeletedMessageHandlerDeps: {
      contactsRepository,
      messagesRepository,
      mediaArchiveRepository,
      auditRepository,
      ownerInbox,
      notificationCooldowns,
      sender,
      ownerJids: [],
      logger: testLogger,
    },
    viewOnceHandlerDeps: {
      supabase: fake as unknown as SupabaseClient,
      mediaArchiveRepository,
      auditRepository,
      logger: testLogger,
    },
    mediaArchiveHandlerDeps: {
      supabase: fake as unknown as SupabaseClient,
      mediaArchiveRepository,
      auditRepository,
      logger: testLogger,
    },
    commandHandlerDeps: {
      groupsRepository,
      rulesRepository,
      auditRepository,
      identityMapRepository,
      sender,
      ai: undefined,
      ownerNumbers: [],
      adminNumbers: [],
      logger: testLogger,
    },
    privateCommandHandlerDeps: {
      contactsRepository,
      rulesRepository,
      auditRepository,
      identityMapRepository,
      sender,
      ai: undefined,
      ownerNumbers: [],
      adminNumbers: [],
      logger: testLogger,
    },
    logger: testLogger,
  });
  return {
    fake,
    groupsRepository,
    contactsRepository,
    messagesRepository,
    rulesRepository,
    auditRepository,
    accountSettingsRepository,
    ownerInbox,
    mediaArchiveRepository,
    storageUploadMock,
    pipeline,
    sender,
  };
}

describe('EventPipeline', () => {
  it('a message from an undiscovered group is skipped safely (no throw)', async () => {
    const { pipeline } = setup();
    await expect(pipeline.handleMessage(waGroupMessage(), 'notify')).resolves.not.toThrow();
  });

  it('does not store a message when monitoring is off (safe default)', async () => {
    const { pipeline, groupsRepository, fake } = setup();
    await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');

    await pipeline.handleMessage(waGroupMessage(), 'notify');

    expect(fake.rawRows('whatsapp_messages')).toHaveLength(0);
  });

  it('stores a message when monitoring is explicitly enabled', async () => {
    const { pipeline, groupsRepository, fake } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { monitoringEnabled: true });

    await pipeline.handleMessage(waGroupMessage(), 'notify');

    expect(fake.rawRows('whatsapp_messages')).toHaveLength(1);
  });

  it('does not evaluate rules when bot is off, even if a matching rule exists', async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await rulesRepository.create({
      groupId: group.id,
      name: 'Rule',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 1,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleMessage(
      waGroupMessage({
        message: {
          extendedTextMessage: { text: 'congrats', contextInfo: { stanzaId: 'ANNOUNCEMENT' } },
        },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('evaluates rules when bot is on and the message qualifies', async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Rule',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 1,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleMessage(
      waGroupMessage({
        message: {
          extendedTextMessage: { text: 'congrats', contextInfo: { stanzaId: 'ANNOUNCEMENT' } },
        },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).toHaveBeenCalledWith('group@g.us', 'Thanks!');
  });

  it('idempotency: a redelivered event is processed only once', async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Rule',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 1,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });
    const message = waGroupMessage({
      message: {
        extendedTextMessage: { text: 'congrats', contextInfo: { stanzaId: 'ANNOUNCEMENT' } },
      },
    });

    await pipeline.handleMessage(message, 'notify');
    await pipeline.handleMessage(message, 'notify'); // redelivered

    expect(sender.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("never processes the bot's own outgoing message as an automation trigger", async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Rule',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 1,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleMessage(
      waGroupMessage({
        key: { remoteJid: 'group@g.us', fromMe: true, id: 'MSG-OUT' },
        message: {
          extendedTextMessage: { text: 'congrats', contextInfo: { stanzaId: 'ANNOUNCEMENT' } },
        },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('does not evaluate rules for offline-backlog ("append") messages', async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Rule',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 1,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleMessage(
      waGroupMessage({
        message: {
          extendedTextMessage: { text: 'congrats', contextInfo: { stanzaId: 'ANNOUNCEMENT' } },
        },
      }),
      'append',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('a private message is normalized/dedup-gated but never triggers rule evaluation or storage', async () => {
    const { pipeline, fake, sender } = setup();

    await pipeline.handleMessage(
      waGroupMessage({
        key: { remoteJid: 'someone@s.whatsapp.net', fromMe: false, id: 'MSG-DM' },
        message: { conversation: 'hi' },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
    expect(fake.rawRows('whatsapp_messages')).toHaveLength(0);
  });

  it('Emergency Pause stops rule evaluation in groups, but monitoring/storage still runs', async () => {
    const { pipeline, groupsRepository, rulesRepository, accountSettingsRepository, sender, fake } =
      setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true, monitoringEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Rule',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 1,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });
    await accountSettingsRepository.update(ACCOUNT_ID, { automationPaused: true });

    await pipeline.handleMessage(
      waGroupMessage({
        message: {
          extendedTextMessage: { text: 'congrats', contextInfo: { stanzaId: 'ANNOUNCEMENT' } },
        },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
    expect(fake.rawRows('whatsapp_messages')).toHaveLength(1);
    expect(
      fake
        .rawRows('whatsapp_audit_logs')
        .some((row) => (row as { event_type: string }).event_type === 'automation.paused_skip'),
    ).toBe(true);
  });

  it("group A's settings never affect how messages in group B are handled", async () => {
    const { pipeline, groupsRepository, fake } = setup();
    const groupA = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'a@g.us', 'A');
    await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'b@g.us', 'B');
    await groupsRepository.updateSettings(groupA.id, { monitoringEnabled: true });

    await pipeline.handleMessage(
      waGroupMessage({ key: { remoteJid: 'b@g.us', fromMe: false, id: 'MSG-B' } }),
      'notify',
    );

    expect(fake.rawRows('whatsapp_messages')).toHaveLength(0);
  });
});

function waPrivateMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: 'contact@s.whatsapp.net',
      fromMe: false,
      id: 'MSG1',
    },
    message: { conversation: 'hello' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  } as WAMessage;
}

describe('EventPipeline — private messages', () => {
  it('stores a private message only once privateMonitoringEnabled is explicitly on', async () => {
    const { pipeline, contactsRepository, fake } = setup();

    await pipeline.handleMessage(waPrivateMessage(), 'notify');
    expect(fake.rawRows('whatsapp_messages')).toHaveLength(0);

    const contact = await contactsRepository.getByJid(ACCOUNT_ID, 'contact@s.whatsapp.net');
    await contactsRepository.updateSettings(contact!.id, { privateMonitoringEnabled: true });

    await pipeline.handleMessage(
      waPrivateMessage({ key: { ...waPrivateMessage().key, id: 'MSG2' } }),
      'notify',
    );
    expect(fake.rawRows('whatsapp_messages')).toHaveLength(1);
  });

  it('a blocked contact is never automated for, even with monitoring/auto-reply enabled', async () => {
    const { pipeline, contactsRepository, rulesRepository, fake, sender } = setup();

    // First message discovers the contact.
    await pipeline.handleMessage(waPrivateMessage(), 'notify');
    const contact = await contactsRepository.getByJid(ACCOUNT_ID, 'contact@s.whatsapp.net');
    await contactsRepository.updateSettings(contact!.id, {
      privateMonitoringEnabled: true,
      privateAutoReplyEnabled: true,
    });
    await rulesRepository.createForContact({
      contactId: contact!.id,
      name: 'Hello reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hello'] },
        action: { type: 'SEND_MESSAGE', message: 'Hi there!' },
        cooldownSeconds: 0,
      },
    });
    await contactsRepository.updateContact(contact!.id, { blocked: true });

    await pipeline.handleMessage(
      waPrivateMessage({ key: { remoteJid: 'contact@s.whatsapp.net', fromMe: false, id: 'MSG2' } }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
    // No new message stored either — blocked suppresses monitoring too.
    expect(fake.rawRows('whatsapp_messages')).toHaveLength(0);
  });

  it('auto-replies in a private chat once privateAutoReplyEnabled and a matching rule exist', async () => {
    const { pipeline, contactsRepository, rulesRepository, sender } = setup();

    await pipeline.handleMessage(
      waPrivateMessage({ message: { conversation: 'what are your hours' } }),
      'notify',
    );
    const contact = await contactsRepository.getByJid(ACCOUNT_ID, 'contact@s.whatsapp.net');
    await contactsRepository.updateSettings(contact!.id, { privateAutoReplyEnabled: true });
    await rulesRepository.createForContact({
      contactId: contact!.id,
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleMessage(
      waPrivateMessage({
        key: { remoteJid: 'contact@s.whatsapp.net', fromMe: false, id: 'MSG2' },
        message: { conversation: 'what are your hours' },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).toHaveBeenCalledWith(
      'contact@s.whatsapp.net',
      'We are open 9-5.',
    );
  });

  it('Emergency Pause stops auto-reply in private chats, but monitoring still runs', async () => {
    const {
      pipeline,
      contactsRepository,
      rulesRepository,
      accountSettingsRepository,
      fake,
      sender,
    } = setup();

    await pipeline.handleMessage(
      waPrivateMessage({ message: { conversation: 'what are your hours' } }),
      'notify',
    );
    const contact = await contactsRepository.getByJid(ACCOUNT_ID, 'contact@s.whatsapp.net');
    await contactsRepository.updateSettings(contact!.id, {
      privateMonitoringEnabled: true,
      privateAutoReplyEnabled: true,
    });
    await rulesRepository.createForContact({
      contactId: contact!.id,
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });
    await accountSettingsRepository.update(ACCOUNT_ID, { automationPaused: true });

    await pipeline.handleMessage(
      waPrivateMessage({
        key: { remoteJid: 'contact@s.whatsapp.net', fromMe: false, id: 'MSG2' },
        message: { conversation: 'what are your hours' },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
    expect(fake.rawRows('whatsapp_messages')).toHaveLength(1);
    expect(
      fake
        .rawRows('whatsapp_audit_logs')
        .some((row) => (row as { event_type: string }).event_type === 'automation.paused_skip'),
    ).toBe(true);
  });

  it("contact A's settings never affect how messages from contact B are handled", async () => {
    const { pipeline, contactsRepository, rulesRepository, sender } = setup();

    await pipeline.handleMessage(
      waPrivateMessage({ key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'MSG-A' } }),
      'notify',
    );
    const contactA = await contactsRepository.getByJid(ACCOUNT_ID, 'a@s.whatsapp.net');
    await contactsRepository.updateSettings(contactA!.id, { privateAutoReplyEnabled: true });
    await rulesRepository.createForContact({
      contactId: contactA!.id,
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleMessage(
      waPrivateMessage({
        key: { remoteJid: 'b@s.whatsapp.net', fromMe: false, id: 'MSG-B' },
        message: { conversation: 'what are your hours' },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });
});

describe('EventPipeline — handleParticipantJoined ("Welcome Message" template)', () => {
  it('skips safely for an undiscovered group (no throw)', async () => {
    const { pipeline, sender } = setup();
    await pipeline.handleParticipantJoined('unknown@g.us', 'alice@s.whatsapp.net');
    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('does nothing while bot_enabled is off (safe default)', async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await rulesRepository.create({
      groupId: group.id,
      name: 'Welcome',
      triggerType: 'participant_joined',
      config: { action: { type: 'SEND_MESSAGE', message: 'Welcome!' }, cooldownSeconds: 0 },
    });

    await pipeline.handleParticipantJoined('group@g.us', 'alice@s.whatsapp.net');

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('fires the welcome rule when bot_enabled is on', async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Welcome',
      triggerType: 'participant_joined',
      config: {
        action: { type: 'SEND_MESSAGE', message: 'Welcome, {participant}!' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleParticipantJoined('group@g.us', '15551234567@s.whatsapp.net');

    expect(sender.sendTextMessage).toHaveBeenCalledWith('group@g.us', 'Welcome, 15551234567!');
  });

  it('respects Emergency Pause — automationPaused blocks the welcome message', async () => {
    const { pipeline, groupsRepository, rulesRepository, accountSettingsRepository, sender } =
      setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Welcome',
      triggerType: 'participant_joined',
      config: { action: { type: 'SEND_MESSAGE', message: 'Welcome!' }, cooldownSeconds: 0 },
    });
    await accountSettingsRepository.update(ACCOUNT_ID, { automationPaused: true });

    await pipeline.handleParticipantJoined('group@g.us', 'alice@s.whatsapp.net');

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });
});

describe('EventPipeline — self-sent (fromMe) messages: stored/archived, never a trigger', () => {
  it('stores a self-sent group text message even with monitoring OFF (own content is always recoverable)', async () => {
    const { pipeline, groupsRepository, fake } = setup();
    await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');

    await pipeline.handleMessage(
      waGroupMessage({ key: { remoteJid: 'group@g.us', fromMe: true, id: 'OUT1' } }),
      'notify',
    );

    const rows = fake.rawRows('whatsapp_messages') as Array<{ from_me: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_me).toBe(true);
  });

  it('never stores a self-addressed, non-REVOKE protocolMessage (e.g. a history-sync notification) as if it were real chat content — a real production bug: a fresh pairing emits several of these, self-addressed with fromMe:true, before any real message, and they were being stored as empty "self-sent" rows', async () => {
    const { pipeline, fake } = setup();

    await pipeline.handleMessage(
      waPrivateMessage({
        key: { remoteJid: 'own-lid@lid', fromMe: true, id: 'ACD71E9882DB99B22F69F3AA040CC059' },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
            historySyncNotification: { fileLength: 10 },
          },
        },
      }),
      'notify',
    );

    expect(fake.rawRows('whatsapp_messages')).toHaveLength(0);
  });

  it('never evaluates rules or runs commands for a self-sent group message', async () => {
    const { pipeline, groupsRepository, rulesRepository, sender } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Rule',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 1,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });

    await pipeline.handleMessage(
      waGroupMessage({
        key: { remoteJid: 'group@g.us', fromMe: true, id: 'OUT2' },
        message: {
          extendedTextMessage: { text: 'congrats', contextInfo: { stanzaId: 'ANNOUNCEMENT' } },
        },
      }),
      'notify',
    );

    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('archives a self-sent group image regardless of mediaArchiveEnabled (own content is always recoverable)', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-image-bytes'));
    const { pipeline, groupsRepository, mediaArchiveRepository } = setup();
    await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');

    await pipeline.handleMessage(
      waGroupMessage({
        key: { remoteJid: 'group@g.us', fromMe: true, id: 'OUT3' },
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 100 } },
      }),
      'notify',
    );

    const archived = await mediaArchiveRepository.findByMessageId(ACCOUNT_ID, 'OUT3');
    expect(archived).toMatchObject({ mimeType: 'image/jpeg', isViewOnce: false });
  });

  it('archives a self-sent group view-once image regardless of viewOnceHandlingEnabled', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-view-once-bytes'));
    const { pipeline, groupsRepository, mediaArchiveRepository } = setup();
    await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');

    await pipeline.handleMessage(
      waGroupMessage({
        key: { remoteJid: 'group@g.us', fromMe: true, id: 'OUT4' },
        message: {
          viewOnceMessage: { message: { imageMessage: { mimetype: 'image/png', fileLength: 50 } } },
        },
      }),
      'notify',
    );

    const archived = await mediaArchiveRepository.findByMessageId(ACCOUNT_ID, 'OUT4');
    expect(archived).toMatchObject({ mimeType: 'image/png', isViewOnce: true });
  });

  it('stores a self-sent private message and discovers the contact if new (e.g. "Message Yourself")', async () => {
    const { pipeline, fake } = setup();

    await pipeline.handleMessage(
      waPrivateMessage({ key: { remoteJid: 'self@s.whatsapp.net', fromMe: true, id: 'OUT5' } }),
      'notify',
    );

    const rows = fake.rawRows('whatsapp_messages') as Array<{ from_me: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_me).toBe(true);
    expect(fake.rawRows('whatsapp_contacts')).toHaveLength(1);
  });

  it('a self-sent "delete for everyone" IS still processed (self-sent deletion fix) — the revoke branch runs before the fromMe short-circuit', async () => {
    const { pipeline, groupsRepository, fake } = setup();
    await groupsRepository.upsertDiscoveredGroup(ACCOUNT_ID, 'group@g.us', 'Team');
    // First, the original self-sent message arrives and is stored (via the
    // new handleSelfSentMessage path tested above).
    await pipeline.handleMessage(
      waGroupMessage({ key: { remoteJid: 'group@g.us', fromMe: true, id: 'OUT6' } }),
      'notify',
    );

    const { proto } = await import('@whiskeysockets/baileys');
    await pipeline.handleMessage(
      {
        key: { remoteJid: 'group@g.us', fromMe: true, id: 'REVOKE-OUT6' },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { remoteJid: 'group@g.us', fromMe: true, id: 'OUT6' },
          },
        },
      } as WAMessage,
      'notify',
    );

    const rows = fake.rawRows('whatsapp_messages') as Array<{
      deleted: boolean;
      whatsapp_message_id: string;
    }>;
    const revoked = rows.find((r) => r.whatsapp_message_id === 'OUT6');
    expect(revoked?.deleted).toBe(true);
  });
});

describe('EventPipeline — private incoming view-once (fixes the pre-existing gap: contacts never archived view-once at all)', () => {
  it('archives an incoming private view-once image when mediaArchiveEnabled + privateMonitoringEnabled are both on', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(Buffer.from('fake-view-once-bytes'));
    const { pipeline, contactsRepository, mediaArchiveRepository } = setup();
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'contact@s.whatsapp.net',
      undefined,
    );
    await contactsRepository.updateSettings(contact.id, {
      privateMonitoringEnabled: true,
      mediaArchiveEnabled: true,
    });

    await pipeline.handleMessage(
      waPrivateMessage({
        key: { remoteJid: 'contact@s.whatsapp.net', fromMe: false, id: 'IN1' },
        message: {
          viewOnceMessage: {
            message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 80 } },
          },
        },
      }),
      'notify',
    );

    const archived = await mediaArchiveRepository.findByMessageId(ACCOUNT_ID, 'IN1');
    expect(archived).toMatchObject({ contactId: contact.id, isViewOnce: true });
  });

  it('does not archive an incoming private view-once image when mediaArchiveEnabled is off', async () => {
    const { pipeline, contactsRepository, mediaArchiveRepository } = setup();
    const contact = await contactsRepository.upsertDiscoveredContact(
      ACCOUNT_ID,
      'contact@s.whatsapp.net',
      undefined,
    );
    await contactsRepository.updateSettings(contact.id, { privateMonitoringEnabled: true });

    await pipeline.handleMessage(
      waPrivateMessage({
        key: { remoteJid: 'contact@s.whatsapp.net', fromMe: false, id: 'IN2' },
        message: {
          viewOnceMessage: {
            message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 80 } },
          },
        },
      }),
      'notify',
    );

    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
    expect(await mediaArchiveRepository.findByMessageId(ACCOUNT_ID, 'IN2')).toBeUndefined();
  });
});
