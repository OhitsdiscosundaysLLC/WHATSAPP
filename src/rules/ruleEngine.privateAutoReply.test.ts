import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../db/auditRepository';
import {
  ContactsRepository,
  DEFAULT_CONTACT_SETTINGS,
  type ContactSettings,
} from '../db/contactsRepository';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { ModerationStateRepository } from '../db/moderationStateRepository';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import { RulesRepository } from '../db/rulesRepository';
import { RuleStateRepository } from '../db/ruleStateRepository';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';
import type { MessageSender } from './actionEngine';
import { DeterministicResponseClassifier } from './classifiers/responseClassifier';
import { RuleEngine, type RuleEngineDeps } from './ruleEngine';

const testLogger = pino({ level: 'silent' });

function privateEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    accountId: 'acct-1',
    chatJid: 'contact@s.whatsapp.net',
    context: 'private',
    groupJid: undefined,
    whatsappMessageId: `MSG-${Math.random().toString(36).slice(2)}`,
    senderJid: 'contact@s.whatsapp.net',
    fromMe: false,
    timestamp: new Date().toISOString(),
    messageType: 'conversation',
    text: 'what are your hours?',
    quotedWhatsappMessageId: undefined,
    quotedParticipant: undefined,
    ...overrides,
  };
}

function fakeSender(): MessageSender & { sentTo: Array<{ jid: string; text: string }> } {
  const sentTo: Array<{ jid: string; text: string }> = [];
  return {
    sentTo,
    sendTextMessage: vi.fn(async (jid: string, text: string) => {
      sentTo.push({ jid, text });
    }),
  };
}

function settingsWith(overrides: Partial<ContactSettings> = {}): ContactSettings {
  return {
    ...DEFAULT_CONTACT_SETTINGS,
    contactId: 'contact-row-1',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildEngine(
  fake: FakeSupabaseClient,
  sender: MessageSender,
  ai: RuleEngineDeps['ai'] = undefined,
): { engine: RuleEngine; deps: RuleEngineDeps; contactsRepository: ContactsRepository } {
  const deps: RuleEngineDeps = {
    rulesRepository: new RulesRepository(fake as unknown as SupabaseClient),
    ruleStateRepository: new RuleStateRepository(fake as unknown as SupabaseClient),
    moderationStateRepository: new ModerationStateRepository(fake as unknown as SupabaseClient),
    auditRepository: new AuditRepository(fake as unknown as SupabaseClient),
    ownerInbox: new OwnerInboxRepository(fake as unknown as SupabaseClient),
    classifier: new DeterministicResponseClassifier(),
    sender,
    moderationCapabilities: {
      deleteMessage: vi.fn(async () => {}),
      removeParticipant: vi.fn(async () => {}),
    },
    ai,
    ownerJids: [],
    logger: testLogger,
  };
  return {
    engine: new RuleEngine(deps),
    deps,
    contactsRepository: new ContactsRepository(fake as unknown as SupabaseClient),
  };
}

describe('RuleEngine — private (contact) auto_reply', () => {
  it('does NOT reply when privateAutoReplyEnabled is false, even with a matching deterministic rule', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluatePrivate(
      privateEvent(),
      'contact-row-1',
      settingsWith({ privateAutoReplyEnabled: false }),
    );
    expect(sender.sentTo).toHaveLength(0);
  });

  it('replies with the deterministic message when privateAutoReplyEnabled is true and the rule matches', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluatePrivate(
      privateEvent(),
      'contact-row-1',
      settingsWith({ privateAutoReplyEnabled: true }),
    );
    expect(sender.sentTo).toEqual([{ jid: 'contact@s.whatsapp.net', text: 'We are open 9-5.' }]);
  });

  it('AI-powered qualify/reply is skipped unless all three private AI gates are true', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const classify = vi.fn().mockResolvedValue(true);
    const { engine, deps } = buildEngine(fake, sender, {
      service: { classify, generateReply: vi.fn() } as never,
      usageRepository: {
        getLastSuccessfulAtForContact: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessfulForContact: vi.fn().mockResolvedValue(0),
      } as never,
    });
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'AI hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'ai', aiInstructions: 'asks about hours' },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    // Only privateAutoReplyEnabled true — the other two AI gates are off.
    await engine.evaluatePrivate(
      privateEvent(),
      'contact-row-1',
      settingsWith({ privateAutoReplyEnabled: true }),
    );
    expect(classify).not.toHaveBeenCalled();
    expect(sender.sentTo).toHaveLength(0);
  });

  it('fires the AI-powered reply once all three private AI gates are true', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const classify = vi.fn().mockResolvedValue(true);
    const { engine, deps } = buildEngine(fake, sender, {
      service: { classify, generateReply: vi.fn() } as never,
      usageRepository: {
        getLastSuccessfulAtForContact: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessfulForContact: vi.fn().mockResolvedValue(0),
      } as never,
    });
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'AI hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'ai', aiInstructions: 'asks about hours' },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluatePrivate(
      privateEvent(),
      'contact-row-1',
      settingsWith({
        privateAutoReplyEnabled: true,
        privateAiEnabled: true,
        privateAiAutoReplyEnabled: true,
        privateAiSemanticClassificationEnabled: true,
      }),
    );
    expect(classify).toHaveBeenCalled();
    expect(sender.sentTo).toEqual([{ jid: 'contact@s.whatsapp.net', text: 'We are open 9-5.' }]);
  });

  it('respects the rule cooldown — a second qualifying message within the window does not fire again', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 3600,
      },
    });

    const settings = settingsWith({ privateAutoReplyEnabled: true });
    await engine.evaluatePrivate(privateEvent(), 'contact-row-1', settings);
    await engine.evaluatePrivate(privateEvent(), 'contact-row-1', settings);
    expect(sender.sentTo).toHaveLength(1);
  });

  it('a rule for contact A never fires when evaluating contact B (isolation)', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.createForContact({
      contactId: 'contact-A',
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluatePrivate(
      privateEvent({ chatJid: 'b@s.whatsapp.net', senderJid: 'b@s.whatsapp.net' }),
      'contact-B',
      settingsWith({ contactId: 'contact-B', privateAutoReplyEnabled: true }),
    );
    expect(sender.sentTo).toHaveLength(0);
  });

  it('never evaluates for a fromMe (outgoing) or group-context event', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });
    const settings = settingsWith({ privateAutoReplyEnabled: true });

    await engine.evaluatePrivate(privateEvent({ fromMe: true }), 'contact-row-1', settings);
    await engine.evaluatePrivate(
      privateEvent({ context: 'group', groupJid: 'g@g.us' }),
      'contact-row-1',
      settings,
    );
    expect(sender.sentTo).toHaveLength(0);
  });

  it('Dry Run: a qualifying DM never actually sends, but is logged as "would have"', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluatePrivate(
      privateEvent(),
      'contact-row-1',
      settingsWith({ privateAutoReplyEnabled: true, dryRunEnabled: true }),
    );

    expect(sender.sentTo).toHaveLength(0);
    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ status: 'skipped' });
    expect(actions[0]?.detail).toMatchObject({ reason: 'dry_run' });
    const events = await deps.auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'rule.dry_run')).toBeTruthy();
  });
});
