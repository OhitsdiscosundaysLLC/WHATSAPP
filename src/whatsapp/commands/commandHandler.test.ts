import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AdminsRepository } from '../../db/adminsRepository';
import { AuditRepository } from '../../db/auditRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { GroupsRepository } from '../../db/groupsRepository';
import { IdentityMapRepository } from '../../db/identityMapRepository';
import { RulesRepository } from '../../db/rulesRepository';
import type { WhatsAppGroup } from '../../db/groupsRepository';
import type { NormalizedMessageEvent } from '../events/messageNormalizer';
import {
  tryHandleCommand as tryHandleCommandReal,
  type CommandHandlerDeps,
} from './commandHandler';

const testLogger = pino({ level: 'silent' });

/**
 * Every test in this file authorizes purely via the sender's primary JID
 * (an @s.whatsapp.net form), which is exactly what identityCandidates.primary
 * carries when a message has no @lid forms attached — so inferring it from
 * event.senderJid here keeps every existing call site unchanged.
 * identityResolver.ts's own tests cover the @lid-specific resolution paths.
 */
function tryHandleCommand(
  event: NormalizedMessageEvent,
  group: WhatsAppGroup,
  deps: CommandHandlerDeps,
): Promise<boolean> {
  return tryHandleCommandReal(
    event,
    group,
    { primary: event.senderJid, phoneJid: undefined, lidJid: undefined },
    deps,
  );
}

function baseEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    accountId: 'acct-1',
    chatJid: 'group@g.us',
    context: 'group',
    groupJid: 'group@g.us',
    whatsappMessageId: 'MSG1',
    senderJid: 'owner@s.whatsapp.net',
    fromMe: false,
    timestamp: new Date().toISOString(),
    messageType: 'conversation',
    text: '.bot on',
    quotedWhatsappMessageId: undefined,
    quotedParticipant: undefined,
    ...overrides,
  };
}

async function setup(ownerNumbers: string[] = ['15550001111'], adminNumbers: string[] = []) {
  const fake = new FakeSupabaseClient();
  const groupsRepository = new GroupsRepository(fake as unknown as SupabaseClient);
  const rulesRepository = new RulesRepository(fake as unknown as SupabaseClient);
  const auditRepository = new AuditRepository(fake as unknown as SupabaseClient);
  const sender = { sendTextMessage: vi.fn(async () => {}) };
  const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team');
  const deps: CommandHandlerDeps = {
    groupsRepository,
    rulesRepository,
    auditRepository,
    identityMapRepository: new IdentityMapRepository(fake as unknown as SupabaseClient),
    sender,
    ai: undefined,
    ownerNumbers,
    adminNumbers,
    logger: testLogger,
  };
  return { fake, groupsRepository, rulesRepository, auditRepository, sender, group, deps };
}

describe('tryHandleCommand — authorization', () => {
  it('a non-owner/non-admin sending ".bot on" is NOT treated as a command at all', async () => {
    const { group, deps } = await setup(['15550001111'], []);
    const handled = await tryHandleCommand(
      baseEvent({ senderJid: 'random-participant@s.whatsapp.net', text: '.bot on' }),
      group,
      deps,
    );
    expect(handled).toBe(false);
    expect(deps.sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('a non-owner cannot enable the bot — settings remain untouched', async () => {
    const { group, deps, groupsRepository } = await setup(['15550001111'], []);
    await tryHandleCommand(
      baseEvent({ senderJid: 'random-participant@s.whatsapp.net', text: '.bot on' }),
      group,
      deps,
    );
    const settings = await groupsRepository.ensureSettings(group.id);
    expect(settings.botEnabled).toBe(false);
  });

  it('the owner can enable the bot', async () => {
    const { group, deps, groupsRepository } = await setup(['15550001111'], []);
    const handled = await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.bot on' }),
      group,
      deps,
    );
    expect(handled).toBe(true);
    const settings = await groupsRepository.ensureSettings(group.id);
    expect(settings.botEnabled).toBe(true);
  });

  it('a configured admin can also enable the bot', async () => {
    const { group, deps, groupsRepository } = await setup(['15550001111'], ['15559998888']);
    await tryHandleCommand(
      baseEvent({ senderJid: '15559998888@s.whatsapp.net', text: '.bot on' }),
      group,
      deps,
    );
    const settings = await groupsRepository.ensureSettings(group.id);
    expect(settings.botEnabled).toBe(true);
  });

  it('a message not starting with "." is never treated as a command', async () => {
    const { group, deps } = await setup();
    const handled = await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: 'bot on' }),
      group,
      deps,
    );
    expect(handled).toBe(false);
  });

  it('an unrecognized dot-command is not treated as a command', async () => {
    const { group, deps } = await setup();
    const handled = await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.notacommand' }),
      group,
      deps,
    );
    expect(handled).toBe(false);
  });
});

describe('tryHandleCommand — dashboard-managed (DB) admins', () => {
  it('a number added via AdminsRepository can run commands, merged with env ADMIN_WHATSAPP_NUMBERS', async () => {
    const { group, deps, fake, groupsRepository } = await setup(['15550001111'], ['15559990000']);
    const adminsRepository = new AdminsRepository(fake as unknown as SupabaseClient);
    await adminsRepository.add('acct-1', '15557778888', 'Dashboard-added admin');
    deps.adminsRepository = adminsRepository;

    const handled = await tryHandleCommand(
      baseEvent({ senderJid: '15557778888@s.whatsapp.net', text: '.bot on' }),
      group,
      deps,
    );
    expect(handled).toBe(true);
    expect((await groupsRepository.ensureSettings(group.id)).botEnabled).toBe(true);
  });

  it('a number not in env nor DB admins still cannot run commands even when adminsRepository is wired', async () => {
    const { group, deps, fake } = await setup(['15550001111'], []);
    deps.adminsRepository = new AdminsRepository(fake as unknown as SupabaseClient);

    const handled = await tryHandleCommand(
      baseEvent({ senderJid: 'random@s.whatsapp.net', text: '.bot on' }),
      group,
      deps,
    );
    expect(handled).toBe(false);
  });
});

describe('tryHandleCommand — .bot / .ai toggles', () => {
  it('.bot off disables the bot for this group only', async () => {
    const { group, deps, groupsRepository } = await setup();
    await groupsRepository.updateSettings(group.id, { botEnabled: true });
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.bot off' }),
      group,
      deps,
    );
    const settings = await groupsRepository.ensureSettings(group.id);
    expect(settings.botEnabled).toBe(false);
  });

  it('.bot on inside Group A never affects Group B', async () => {
    const { deps, groupsRepository } = await setup();
    const groupB = await groupsRepository.upsertDiscoveredGroup('acct-1', 'b@g.us', 'Group B');
    const groupA = await groupsRepository.upsertDiscoveredGroup('acct-1', 'a@g.us', 'Group A');

    await tryHandleCommand(
      baseEvent({
        senderJid: '15550001111@s.whatsapp.net',
        text: '.bot on',
        groupJid: 'a@g.us',
        chatJid: 'a@g.us',
      }),
      groupA,
      deps,
    );

    expect((await groupsRepository.ensureSettings(groupA.id)).botEnabled).toBe(true);
    expect((await groupsRepository.ensureSettings(groupB.id)).botEnabled).toBe(false);
  });

  it('.ai on/off toggles aiEnabled', async () => {
    const { group, deps, groupsRepository } = await setup();
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai on' }),
      group,
      deps,
    );
    expect((await groupsRepository.ensureSettings(group.id)).aiEnabled).toBe(true);
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai off' }),
      group,
      deps,
    );
    expect((await groupsRepository.ensureSettings(group.id)).aiEnabled).toBe(false);
  });
});

describe('tryHandleCommand — .ai <question>', () => {
  it('replies that AI is not enabled when ai_enabled is false', async () => {
    const { group, deps } = await setup();
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai what are your hours?' }),
      group,
      deps,
    );
    expect(deps.sender.sendTextMessage).toHaveBeenCalledWith(
      'group@g.us',
      expect.stringContaining('not enabled'),
    );
  });

  it('calls AIService.generateReply when AI is enabled and configured', async () => {
    const { group, deps, groupsRepository } = await setup();
    await groupsRepository.updateSettings(group.id, { aiEnabled: true });
    const generateReply = vi.fn().mockResolvedValue('We are open 9-5.');
    deps.ai = {
      service: { generateReply } as never,
      usageRepository: {
        getLastSuccessfulAt: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessful: vi.fn().mockResolvedValue(0),
      } as never,
    };

    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai what are your hours?' }),
      group,
      deps,
    );

    expect(generateReply).toHaveBeenCalled();
    expect(deps.sender.sendTextMessage).toHaveBeenCalledWith('group@g.us', 'We are open 9-5.');
  });
});

describe('tryHandleCommand — .rules / .settings / .status / .help', () => {
  it('.rules lists configured rules concisely', async () => {
    const { group, deps, rulesRepository } = await setup();
    await rulesRepository.create({
      groupId: group.id,
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 5,
        action: { type: 'SEND_MESSAGE', message: 'Thanks!' },
        cooldownSeconds: 0,
      },
    });

    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.rules' }),
      group,
      deps,
    );

    const [, message] = (deps.sender.sendTextMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toContain('Five people congratulate');
    expect(message).toContain('threshold 5');
  });

  it('.settings summarizes current configuration', async () => {
    const { group, deps, groupsRepository } = await setup();
    await groupsRepository.updateSettings(group.id, { botEnabled: true, monitoringEnabled: true });
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.settings' }),
      group,
      deps,
    );
    const [, message] = (deps.sender.sendTextMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toContain('Bot: ON');
    expect(message).toContain('Monitoring: ON');
    expect(message).toContain('AI: OFF');
  });

  it('.status gives a quick summary', async () => {
    const { group, deps } = await setup();
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.status' }),
      group,
      deps,
    );
    expect(deps.sender.sendTextMessage).toHaveBeenCalled();
  });

  it('.help lists available commands', async () => {
    const { group, deps } = await setup();
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.help' }),
      group,
      deps,
    );
    const [, message] = (deps.sender.sendTextMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toContain('.bot on|off');
  });
});

describe('tryHandleCommand — auditing', () => {
  it('logs every executed command to the audit trail', async () => {
    const { group, deps, auditRepository } = await setup();
    await tryHandleCommand(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.bot on' }),
      group,
      deps,
    );
    const events = await auditRepository.listRecent();
    const commandEvent = events.find((e) => e.eventType === 'command.executed');
    expect(commandEvent).toBeDefined();
    expect(commandEvent?.detail).toMatchObject({ command: 'bot', args: 'on' });
  });
});
