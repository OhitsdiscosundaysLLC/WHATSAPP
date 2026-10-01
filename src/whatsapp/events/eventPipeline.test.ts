import type { SupabaseClient } from '@supabase/supabase-js';
import type { WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../db/auditRepository';
import { ContactsRepository } from '../../db/contactsRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { GroupsRepository } from '../../db/groupsRepository';
import { IdentityMapRepository } from '../../db/identityMapRepository';
import { MediaArchiveRepository } from '../../db/mediaArchiveRepository';
import { MessagesRepository } from '../../db/messagesRepository';
import { ModerationStateRepository } from '../../db/moderationStateRepository';
import { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import { RulesRepository } from '../../db/rulesRepository';
import { RuleStateRepository } from '../../db/ruleStateRepository';
import { DeterministicResponseClassifier } from '../../rules/classifiers/responseClassifier';
import { RuleEngine } from '../../rules/ruleEngine';
import { EventPipeline } from './eventPipeline';

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
  const ruleEngine = new RuleEngine({
    rulesRepository,
    ruleStateRepository: new RuleStateRepository(fake as unknown as SupabaseClient),
    moderationStateRepository: new ModerationStateRepository(fake as unknown as SupabaseClient),
    auditRepository,
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
  const pipeline = new EventPipeline({
    accountId: ACCOUNT_ID,
    groupsRepository,
    contactsRepository,
    messagesRepository,
    identityMapRepository,
    ruleEngine,
    auditRepository,
    deletedMessageHandlerDeps: {
      groupsRepository,
      messagesRepository,
      auditRepository,
      notificationCooldowns,
      sender,
      ownerJids: [],
      logger: testLogger,
    },
    privateDeletedMessageHandlerDeps: {
      contactsRepository,
      messagesRepository,
      auditRepository,
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
