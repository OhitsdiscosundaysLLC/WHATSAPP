import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../db/auditRepository';
import { ContactsRepository, type WhatsAppContact } from '../../db/contactsRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { IdentityMapRepository } from '../../db/identityMapRepository';
import { RulesRepository } from '../../db/rulesRepository';
import type { NormalizedMessageEvent } from '../events/messageNormalizer';
import { tryHandlePrivateCommand, type PrivateCommandHandlerDeps } from './privateCommandHandler';

const testLogger = pino({ level: 'silent' });

function baseEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    accountId: 'acct-1',
    chatJid: 'contact@s.whatsapp.net',
    context: 'private',
    groupJid: undefined,
    whatsappMessageId: 'MSG1',
    senderJid: 'owner@s.whatsapp.net',
    fromMe: false,
    timestamp: new Date().toISOString(),
    messageType: 'conversation',
    text: '.status',
    quotedWhatsappMessageId: undefined,
    quotedParticipant: undefined,
    ...overrides,
  };
}

async function setup(ownerNumbers: string[] = ['15550001111'], adminNumbers: string[] = []) {
  const fake = new FakeSupabaseClient();
  const contactsRepository = new ContactsRepository(fake as unknown as SupabaseClient);
  const rulesRepository = new RulesRepository(fake as unknown as SupabaseClient);
  const auditRepository = new AuditRepository(fake as unknown as SupabaseClient);
  const sender = { sendTextMessage: vi.fn(async () => {}) };
  const contact = await contactsRepository.upsertDiscoveredContact(
    'acct-1',
    'contact@s.whatsapp.net',
    undefined,
  );
  const deps: PrivateCommandHandlerDeps = {
    contactsRepository,
    rulesRepository,
    auditRepository,
    identityMapRepository: new IdentityMapRepository(fake as unknown as SupabaseClient),
    sender,
    ai: undefined,
    ownerNumbers,
    adminNumbers,
    logger: testLogger,
  };
  return { fake, contactsRepository, rulesRepository, auditRepository, sender, contact, deps };
}

function tryHandle(
  event: NormalizedMessageEvent,
  contact: WhatsAppContact,
  deps: PrivateCommandHandlerDeps,
): Promise<boolean> {
  return tryHandlePrivateCommand(
    event,
    contact,
    { primary: event.senderJid, phoneJid: undefined, lidJid: undefined },
    deps,
  );
}

describe('tryHandlePrivateCommand — authorization', () => {
  it('a random contact sending ".ai on" is NOT treated as a command at all', async () => {
    const { contact, deps } = await setup(['15550001111'], []);
    const handled = await tryHandle(
      baseEvent({ senderJid: 'random@s.whatsapp.net', text: '.ai on' }),
      contact,
      deps,
    );
    expect(handled).toBe(false);
    expect(deps.sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('a random contact cannot enable private AI for themselves — settings remain untouched', async () => {
    const { contact, deps, contactsRepository } = await setup(['15550001111'], []);
    await tryHandle(
      baseEvent({ senderJid: 'random@s.whatsapp.net', text: '.ai on' }),
      contact,
      deps,
    );
    const settings = await contactsRepository.ensureSettings(contact.id);
    expect(settings.privateAiEnabled).toBe(false);
  });

  it('the owner can enable private AI for a chat', async () => {
    const { contact, deps, contactsRepository } = await setup(['15550001111'], []);
    const handled = await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai on' }),
      contact,
      deps,
    );
    expect(handled).toBe(true);
    const settings = await contactsRepository.ensureSettings(contact.id);
    expect(settings.privateAiEnabled).toBe(true);
  });

  it('a configured admin can also enable private monitoring', async () => {
    const { contact, deps, contactsRepository } = await setup(['15550001111'], ['15559998888']);
    await tryHandle(
      baseEvent({ senderJid: '15559998888@s.whatsapp.net', text: '.monitor on' }),
      contact,
      deps,
    );
    const settings = await contactsRepository.ensureSettings(contact.id);
    expect(settings.privateMonitoringEnabled).toBe(true);
  });

  it('a message not starting with "." is never treated as a command', async () => {
    const { contact, deps } = await setup();
    const handled = await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: 'ai on' }),
      contact,
      deps,
    );
    expect(handled).toBe(false);
  });
});

describe('tryHandlePrivateCommand — toggles', () => {
  it('.autoreply on/off toggles privateAutoReplyEnabled for this contact only', async () => {
    const { contact, deps, contactsRepository } = await setup();
    await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.autoreply on' }),
      contact,
      deps,
    );
    expect((await contactsRepository.ensureSettings(contact.id)).privateAutoReplyEnabled).toBe(
      true,
    );
    await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.autoreply off' }),
      contact,
      deps,
    );
    expect((await contactsRepository.ensureSettings(contact.id)).privateAutoReplyEnabled).toBe(
      false,
    );
  });

  it('toggling one contact never affects another contact (isolation)', async () => {
    const { deps, contactsRepository } = await setup();
    const contactB = await contactsRepository.upsertDiscoveredContact(
      'acct-1',
      'b@s.whatsapp.net',
      undefined,
    );

    await tryHandle(
      baseEvent({
        senderJid: '15550001111@s.whatsapp.net',
        text: '.ai on',
        chatJid: 'b@s.whatsapp.net',
      }),
      contactB,
      deps,
    );

    expect((await contactsRepository.ensureSettings(contactB.id)).privateAiEnabled).toBe(true);
    const original = await contactsRepository.getByJid('acct-1', 'contact@s.whatsapp.net');
    expect((await contactsRepository.ensureSettings(original!.id)).privateAiEnabled).toBe(false);
  });
});

describe('tryHandlePrivateCommand — .ai <question>', () => {
  it('replies that AI is not enabled when private AI is off', async () => {
    const { contact, deps } = await setup();
    await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai what are your hours?' }),
      contact,
      deps,
    );
    expect(deps.sender.sendTextMessage).toHaveBeenCalledWith(
      'contact@s.whatsapp.net',
      expect.stringContaining('not enabled'),
    );
  });

  it('calls AIService.generateReply when private AI is enabled and configured', async () => {
    const { contact, deps, contactsRepository } = await setup();
    await contactsRepository.updateSettings(contact.id, { privateAiEnabled: true });
    const generateReply = vi.fn().mockResolvedValue('We are open 9-5.');
    deps.ai = {
      service: { generateReply } as never,
      usageRepository: {
        getLastSuccessfulAtForContact: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessfulForContact: vi.fn().mockResolvedValue(0),
      } as never,
    };

    await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai what are your hours?' }),
      contact,
      deps,
    );

    expect(generateReply).toHaveBeenCalled();
    expect(deps.sender.sendTextMessage).toHaveBeenCalledWith(
      'contact@s.whatsapp.net',
      'We are open 9-5.',
    );
  });
});

describe('tryHandlePrivateCommand — .status / .help', () => {
  it('.status gives a quick summary', async () => {
    const { contact, deps } = await setup();
    await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.status' }),
      contact,
      deps,
    );
    expect(deps.sender.sendTextMessage).toHaveBeenCalled();
  });

  it('.help lists available commands', async () => {
    const { contact, deps } = await setup();
    await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.help' }),
      contact,
      deps,
    );
    const [, message] = (deps.sender.sendTextMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toContain('.ai on|off');
  });
});

describe('tryHandlePrivateCommand — auditing', () => {
  it('logs every executed private command to the audit trail, scoped to the contact', async () => {
    const { contact, deps, auditRepository } = await setup();
    await tryHandle(
      baseEvent({ senderJid: '15550001111@s.whatsapp.net', text: '.ai on' }),
      contact,
      deps,
    );
    const events = await auditRepository.listRecent();
    const commandEvent = events.find((e) => e.eventType === 'command.executed');
    expect(commandEvent).toBeDefined();
    expect(commandEvent?.contactId).toBe(contact.id);
    expect(commandEvent?.detail).toMatchObject({ command: 'ai', args: 'on', scope: 'private' });
  });
});
