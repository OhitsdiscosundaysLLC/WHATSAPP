import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../db/auditRepository';
import { DEFAULT_CONTACT_SETTINGS, type ContactSettings } from '../db/contactsRepository';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { DEFAULT_GROUP_SETTINGS, type GroupSettings } from '../db/groupsRepository';
import { ModerationStateRepository } from '../db/moderationStateRepository';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import { PendingApprovalsRepository } from '../db/pendingApprovalsRepository';
import { RulesRepository } from '../db/rulesRepository';
import { RuleStateRepository } from '../db/ruleStateRepository';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';
import type { MessageSender } from './actionEngine';
import { DeterministicResponseClassifier } from './classifiers/responseClassifier';
import { RuleEngine, type RuleEngineDeps } from './ruleEngine';

const testLogger = pino({ level: 'silent' });

/**
 * response_threshold evaluation doesn't read group_settings at all (only
 * src/whatsapp/events/eventPipeline.ts's bot_enabled gate does, before
 * ever calling evaluate()) — this fixture exists purely to satisfy
 * evaluate()'s now-required third parameter, added in Phase 6+ for
 * auto_reply/moderation. Its exact values are irrelevant to every test in
 * this describe block.
 */
const DEFAULT_SETTINGS: GroupSettings = {
  ...DEFAULT_GROUP_SETTINGS,
  groupId: 'group-1',
  updatedAt: new Date().toISOString(),
};

const FIVE_PERSON_CONFIG = {
  targetMessageMatch: 'quoted' as const,
  qualify: { mode: 'contains' as const, phrases: ['congrat', 'noted sir', 'okay sir'] },
  threshold: 5,
  action: { type: 'SEND_MESSAGE' as const, message: 'Thanks everyone for the congratulations!' },
  cooldownSeconds: 0,
};

function responseEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    accountId: 'acct-1',
    chatJid: 'group@g.us',
    context: 'group',
    groupJid: 'group@g.us',
    whatsappMessageId: `MSG-${Math.random().toString(36).slice(2)}`,
    senderJid: 'sender@s.whatsapp.net',
    fromMe: false,
    timestamp: new Date().toISOString(),
    messageType: 'extendedTextMessage',
    text: 'Congrats sir',
    quotedWhatsappMessageId: 'ANNOUNCEMENT_MSG',
    quotedParticipant: 'poster@s.whatsapp.net',
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

interface TestEngine {
  evaluate(event: NormalizedMessageEvent, groupId: string, settings?: GroupSettings): Promise<void>;
}

function buildEngine(
  fake: FakeSupabaseClient,
  sender: MessageSender,
): { engine: TestEngine; deps: RuleEngineDeps } {
  const deps: RuleEngineDeps = {
    rulesRepository: new RulesRepository(fake as unknown as SupabaseClient),
    ruleStateRepository: new RuleStateRepository(fake as unknown as SupabaseClient),
    moderationStateRepository: new ModerationStateRepository(fake as unknown as SupabaseClient),
    auditRepository: new AuditRepository(fake as unknown as SupabaseClient),
    ownerInbox: new OwnerInboxRepository(fake as unknown as SupabaseClient),
    pendingApprovals: new PendingApprovalsRepository(fake as unknown as SupabaseClient),
    classifier: new DeterministicResponseClassifier(),
    sender,
    moderationCapabilities: {
      deleteMessage: vi.fn(async () => {}),
      removeParticipant: vi.fn(async () => {}),
    },
    ai: undefined,
    ownerJids: [],
    logger: testLogger,
  };
  const realEngine = new RuleEngine(deps);
  const engine: TestEngine = {
    evaluate: (event, groupId, settings = DEFAULT_SETTINGS) =>
      realEngine.evaluate(event, groupId, settings),
  };
  return { engine, deps };
}

describe('RuleEngine — response_threshold ("N distinct people respond")', () => {
  it('fires exactly once, with exactly one message, when the threshold is reached by distinct responders', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    const rule = await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });
    void rule;

    const responders = ['alice', 'bob', 'carol', 'dave', 'erin'];
    for (const name of responders) {
      await engine.evaluate(
        responseEvent({ senderJid: `${name}@s.whatsapp.net`, text: 'Congrats sir' }),
        'group-1',
      );
    }

    expect(sender.sentTo).toHaveLength(1);
    expect(sender.sentTo[0]).toEqual({
      jid: 'group@g.us',
      text: 'Thanks everyone for the congratulations!',
    });
  });

  it('does NOT reply individually to each person — only one send for the whole threshold', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });

    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await engine.evaluate(
        responseEvent({ senderJid: `${name}@s.whatsapp.net`, text: 'Congrats sir' }),
        'group-1',
      );
    }

    // 7 qualifying responders, threshold 5 — still exactly one send, not seven.
    expect(sender.sentTo).toHaveLength(1);
  });

  it('five responses from the SAME person never reaches the threshold (distinct senders only)', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });

    for (let i = 0; i < 5; i++) {
      await engine.evaluate(
        responseEvent({ senderJid: 'same-person@s.whatsapp.net', text: 'Congrats sir' }),
        'group-1',
      );
    }

    expect(sender.sentTo).toHaveLength(0);
  });

  it('a non-qualifying message never counts, even from a distinct sender', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });

    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      await engine.evaluate(
        responseEvent({ senderJid: `${name}@s.whatsapp.net`, text: 'Congrats sir' }),
        'group-1',
      );
    }
    // A 5th distinct sender, but the text doesn't qualify.
    await engine.evaluate(
      responseEvent({ senderJid: 'erin@s.whatsapp.net', text: 'What time is it?' }),
      'group-1',
    );

    expect(sender.sentTo).toHaveLength(0);
  });

  it("responses quoting a DIFFERENT message never count toward this target's threshold", async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });

    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      await engine.evaluate(
        responseEvent({
          senderJid: `${name}@s.whatsapp.net`,
          text: 'Congrats sir',
          quotedWhatsappMessageId: 'ANNOUNCEMENT_A',
        }),
        'group-1',
      );
    }
    // 5th response, same qualifying text, but quoting an unrelated message.
    await engine.evaluate(
      responseEvent({
        senderJid: 'erin@s.whatsapp.net',
        text: 'Congrats sir',
        quotedWhatsappMessageId: 'UNRELATED_MESSAGE',
      }),
      'group-1',
    );

    expect(sender.sentTo).toHaveLength(0);
  });

  it('a message with no quoted message at all cannot qualify (requires a reply)', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });

    await engine.evaluate(
      responseEvent({
        senderJid: 'alice@s.whatsapp.net',
        text: 'Congrats sir',
        quotedWhatsappMessageId: undefined,
      }),
      'group-1',
    );

    expect(sender.sentTo).toHaveLength(0);
  });

  it('fires once even if more qualifying responses keep arriving afterward', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });

    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await engine.evaluate(
        responseEvent({ senderJid: `${name}@s.whatsapp.net`, text: 'Congrats sir' }),
        'group-1',
      );
    }
    expect(sender.sentTo).toHaveLength(1);

    // More responses after the fire — must not trigger a second send.
    await engine.evaluate(
      responseEvent({ senderJid: 'f@s.whatsapp.net', text: 'Congrats sir' }),
      'group-1',
    );
    await engine.evaluate(
      responseEvent({ senderJid: 'g@s.whatsapp.net', text: 'Congrats sir' }),
      'group-1',
    );

    expect(sender.sentTo).toHaveLength(1);
  });

  it('a second, unrelated announcement in the same group fires independently', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: { ...FIVE_PERSON_CONFIG, cooldownSeconds: 0 },
    });

    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await engine.evaluate(
        responseEvent({
          senderJid: `${name}@s.whatsapp.net`,
          text: 'Congrats sir',
          quotedWhatsappMessageId: 'ANNOUNCEMENT_1',
        }),
        'group-1',
      );
    }
    for (const name of ['f', 'g', 'h', 'i', 'j']) {
      await engine.evaluate(
        responseEvent({
          senderJid: `${name}@s.whatsapp.net`,
          text: 'Congrats sir',
          quotedWhatsappMessageId: 'ANNOUNCEMENT_2',
        }),
        'group-1',
      );
    }

    expect(sender.sentTo).toHaveLength(2);
  });

  it('respects a configured cooldown — a second announcement fired too soon is skipped, not sent', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: { ...FIVE_PERSON_CONFIG, cooldownSeconds: 3600 },
    });

    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await engine.evaluate(
        responseEvent({
          senderJid: `${name}@s.whatsapp.net`,
          text: 'Congrats sir',
          quotedWhatsappMessageId: 'ANNOUNCEMENT_1',
        }),
        'group-1',
      );
    }
    expect(sender.sentTo).toHaveLength(1);

    for (const name of ['f', 'g', 'h', 'i', 'j']) {
      await engine.evaluate(
        responseEvent({
          senderJid: `${name}@s.whatsapp.net`,
          text: 'Congrats sir',
          quotedWhatsappMessageId: 'ANNOUNCEMENT_2',
        }),
        'group-1',
      );
    }

    // Still just the one send from the first announcement — cooldown blocked the second.
    expect(sender.sentTo).toHaveLength(1);
  });

  it(
    'RESTART SIMULATION: 3 of 5 distinct responders recorded, process restarts, a brand-new ' +
      'RuleEngine (sharing only the database) sees the existing progress and the 4th/5th ' +
      'responses complete the threshold and fire',
    async () => {
      const fake = new FakeSupabaseClient();
      const sender = fakeSender();

      // ---- PROCESS A ----
      let processA: { engine: TestEngine; deps: RuleEngineDeps } | undefined = buildEngine(
        fake,
        sender,
      );
      await processA.deps.rulesRepository.create({
        groupId: 'group-1',
        name: 'Five people congratulate',
        triggerType: 'response_threshold',
        config: FIVE_PERSON_CONFIG,
      });
      for (const name of ['alice', 'bob', 'carol']) {
        await processA.engine.evaluate(
          responseEvent({ senderJid: `${name}@s.whatsapp.net`, text: 'Congrats sir' }),
          'group-1',
        );
      }
      expect(sender.sentTo).toHaveLength(0); // only 3 of 5 so far

      // Simulate the process dying — drop every reference to PROCESS A.
      processA = undefined;

      // ---- PROCESS B: freshly constructed, shares only `fake` (the DB) ----
      const processB = buildEngine(fake, sender);
      for (const name of ['dave', 'erin']) {
        await processB.engine.evaluate(
          responseEvent({ senderJid: `${name}@s.whatsapp.net`, text: 'Congrats sir' }),
          'group-1',
        );
      }

      expect(sender.sentTo).toHaveLength(1);
    },
  );

  it('an unrelated second group with its own rule fires independently and is unaffected', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Group 1 rule',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });
    await deps.rulesRepository.create({
      groupId: 'group-2',
      name: 'Group 2 rule',
      triggerType: 'response_threshold',
      config: { ...FIVE_PERSON_CONFIG, threshold: 2 },
    });

    // Only 2 responders in group-1 (below its threshold of 5).
    for (const name of ['a', 'b']) {
      await engine.evaluate(
        responseEvent({
          senderJid: `${name}@s.whatsapp.net`,
          groupJid: 'g1@g.us',
          chatJid: 'g1@g.us',
          text: 'Congrats sir',
        }),
        'group-1',
      );
    }
    // 2 responders in group-2 (meets its threshold of 2).
    for (const name of ['c', 'd']) {
      await engine.evaluate(
        responseEvent({
          senderJid: `${name}@s.whatsapp.net`,
          groupJid: 'g2@g.us',
          chatJid: 'g2@g.us',
          text: 'Congrats sir',
        }),
        'group-2',
      );
    }

    expect(sender.sentTo).toHaveLength(1);
    expect(sender.sentTo[0]?.jid).toBe('g2@g.us');
  });

  it('a disabled rule is never evaluated', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    const rule = await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: FIVE_PERSON_CONFIG,
    });
    await deps.rulesRepository.setEnabled(rule.id, false);

    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await engine.evaluate(
        responseEvent({ senderJid: `${name}@s.whatsapp.net`, text: 'Congrats sir' }),
        'group-1',
      );
    }

    expect(sender.sentTo).toHaveLength(0);
  });

  it("never fires off the bot's own outgoing message", async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: { ...FIVE_PERSON_CONFIG, threshold: 1 },
    });

    await engine.evaluate(responseEvent({ fromMe: true, text: 'Congrats sir' }), 'group-1');

    expect(sender.sentTo).toHaveLength(0);
  });

  it('records an audit trail explaining why the rule fired', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: { ...FIVE_PERSON_CONFIG, threshold: 1 },
    });

    await engine.evaluate(
      responseEvent({ senderJid: 'alice@s.whatsapp.net', text: 'Congrats sir' }),
      'group-1',
    );

    const events = await deps.auditRepository.listRecent();
    const firedEvent = events.find((e) => e.eventType === 'rule.fired');
    expect(firedEvent).toBeDefined();
    expect(firedEvent?.detail).toMatchObject({ ruleName: 'Five people congratulate' });

    const actions = await deps.auditRepository.listRecentActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ actionType: 'SEND_MESSAGE', status: 'success' });
  });

  it('Dry Run: threshold reached never actually sends, but is logged as "would have"', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: { ...FIVE_PERSON_CONFIG, threshold: 1 },
    });

    await engine.evaluate(
      responseEvent({ senderJid: 'alice@s.whatsapp.net', text: 'Congrats sir' }),
      'group-1',
      { ...DEFAULT_SETTINGS, dryRunEnabled: true },
    );

    expect(sender.sentTo).toHaveLength(0);
    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ status: 'skipped' });
    expect(actions[0]?.detail).toMatchObject({ reason: 'dry_run' });
    const events = await deps.auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'rule.dry_run')).toBeTruthy();
    expect(events.find((e) => e.eventType === 'rule.fired')).toBeFalsy();
  });
});

// ---------------------------------------------------------------------
// auto_reply (Phase 6+)
// ---------------------------------------------------------------------

function autoReplyEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    accountId: 'acct-1',
    chatJid: 'group@g.us',
    context: 'group',
    groupJid: 'group@g.us',
    whatsappMessageId: `MSG-${Math.random().toString(36).slice(2)}`,
    senderJid: 'sender@s.whatsapp.net',
    fromMe: false,
    timestamp: new Date().toISOString(),
    messageType: 'conversation',
    text: 'what are your hours?',
    quotedWhatsappMessageId: undefined,
    quotedParticipant: undefined,
    ...overrides,
  };
}

function settingsWith(overrides: Partial<GroupSettings>): GroupSettings {
  return {
    ...DEFAULT_GROUP_SETTINGS,
    groupId: 'group-1',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildFullEngine(
  fake: FakeSupabaseClient,
  sender: MessageSender,
  ai: RuleEngineDeps['ai'] = undefined,
): { engine: RuleEngine; deps: RuleEngineDeps } {
  const deps: RuleEngineDeps = {
    rulesRepository: new RulesRepository(fake as unknown as SupabaseClient),
    ruleStateRepository: new RuleStateRepository(fake as unknown as SupabaseClient),
    moderationStateRepository: new ModerationStateRepository(fake as unknown as SupabaseClient),
    auditRepository: new AuditRepository(fake as unknown as SupabaseClient),
    ownerInbox: new OwnerInboxRepository(fake as unknown as SupabaseClient),
    pendingApprovals: new PendingApprovalsRepository(fake as unknown as SupabaseClient),
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
  return { engine: new RuleEngine(deps), deps };
}

describe('RuleEngine — auto_reply', () => {
  it('does NOT reply when autoReplyEnabled is false, even with a matching deterministic rule', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(autoReplyEvent(), 'group-1', settingsWith({ autoReplyEnabled: false }));
    expect(sender.sentTo).toHaveLength(0);
  });

  it('replies deterministically when autoReplyEnabled is true and the message matches', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(autoReplyEvent(), 'group-1', settingsWith({ autoReplyEnabled: true }));
    expect(sender.sentTo).toEqual([{ jid: 'group@g.us', text: 'We are open 9-5.' }]);
  });

  it('does not reply to every message just because auto-reply is on — only to qualifying ones', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent({ text: 'totally unrelated message' }),
      'group-1',
      settingsWith({ autoReplyEnabled: true }),
    );
    expect(sender.sentTo).toHaveLength(0);
  });

  it('respects cooldownSeconds — a second qualifying message too soon is skipped', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 3600,
      },
    });

    const settings = settingsWith({ autoReplyEnabled: true });
    await engine.evaluate(autoReplyEvent(), 'group-1', settings);
    await engine.evaluate(
      autoReplyEvent({ senderJid: 'other@s.whatsapp.net' }),
      'group-1',
      settings,
    );
    expect(sender.sentTo).toHaveLength(1);
  });

  it('an AI-classifier rule never calls AI unless ALL THREE group gates are true', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const classify = vi.fn().mockResolvedValue(true);
    const { engine, deps } = buildFullEngine(fake, sender, {
      service: { classify, generateReply: vi.fn() } as never,
      usageRepository: {
        getLastSuccessfulAt: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessful: vi.fn().mockResolvedValue(0),
      } as never,
    });
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'AI hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'ai', aiInstructions: 'asks about hours' },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    // Only aiEnabled true — missing aiAutoReplyEnabled and aiSemanticClassificationEnabled.
    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({ autoReplyEnabled: true, aiEnabled: true }),
    );
    expect(classify).not.toHaveBeenCalled();
    expect(sender.sentTo).toHaveLength(0);
  });

  it('an AI-classifier rule calls AI and replies once every gate is explicitly on', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const classify = vi.fn().mockResolvedValue(true);
    const { engine, deps } = buildFullEngine(fake, sender, {
      service: { classify, generateReply: vi.fn() } as never,
      usageRepository: {
        getLastSuccessfulAt: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessful: vi.fn().mockResolvedValue(0),
      } as never,
    });
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'AI hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'ai', aiInstructions: 'asks about hours' },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({
        autoReplyEnabled: true,
        aiEnabled: true,
        aiAutoReplyEnabled: true,
        aiSemanticClassificationEnabled: true,
      }),
    );
    expect(classify).toHaveBeenCalled();
    expect(sender.sentTo).toEqual([{ jid: 'group@g.us', text: 'We are open 9-5.' }]);
  });

  it('AI_REPLY action generates the reply text via AIService and sends exactly that text', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const generateReply = vi.fn().mockResolvedValue('Our hours are 9am to 5pm, Monday to Friday.');
    const { engine, deps } = buildFullEngine(fake, sender, {
      service: { classify: vi.fn(), generateReply } as never,
      usageRepository: {
        getLastSuccessfulAt: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessful: vi.fn().mockResolvedValue(0),
      } as never,
    });
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'AI hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'AI_REPLY' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({
        autoReplyEnabled: true,
        aiEnabled: true,
        aiAutoReplyEnabled: true,
        aiSemanticClassificationEnabled: true,
      }),
    );
    expect(generateReply).toHaveBeenCalled();
    expect(sender.sentTo).toEqual([
      { jid: 'group@g.us', text: 'Our hours are 9am to 5pm, Monday to Friday.' },
    ]);
  });

  it('AI_REPLY generation failure never crashes, is audited as failed, and reaches the Owner Inbox', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const generateReply = vi.fn().mockRejectedValue(new Error('OpenAI request timed out'));
    const { engine, deps } = buildFullEngine(fake, sender, {
      service: { classify: vi.fn(), generateReply } as never,
      usageRepository: {
        getLastSuccessfulAt: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessful: vi.fn().mockResolvedValue(0),
      } as never,
    });
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'AI hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'AI_REPLY' },
        cooldownSeconds: 0,
      },
    });

    await expect(
      engine.evaluate(
        autoReplyEvent(),
        'group-1',
        settingsWith({
          autoReplyEnabled: true,
          aiEnabled: true,
          aiAutoReplyEnabled: true,
          aiSemanticClassificationEnabled: true,
        }),
      ),
    ).resolves.not.toThrow();

    expect(sender.sentTo).toHaveLength(0);
    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ actionType: 'AI_REPLY', status: 'failed' });
    const items = await deps.ownerInbox.list('acct-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'ai_failure', groupId: 'group-1' });
  });

  it('skips (never crashes) when AI is required but OPENAI_API_KEY is not configured', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender, undefined);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'AI hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'ai', aiInstructions: 'asks about hours' },
        action: { type: 'SEND_MESSAGE', message: 'fallback' },
        cooldownSeconds: 0,
      },
    });

    await expect(
      engine.evaluate(
        autoReplyEvent(),
        'group-1',
        settingsWith({
          autoReplyEnabled: true,
          aiEnabled: true,
          aiAutoReplyEnabled: true,
          aiSemanticClassificationEnabled: true,
        }),
      ),
    ).resolves.not.toThrow();
    expect(sender.sentTo).toHaveLength(0);
  });

  it('respects the AI rate-limit policy — no AI call and no reply when the limit is hit', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const classify = vi.fn().mockResolvedValue(true);
    const { engine, deps } = buildFullEngine(fake, sender, {
      service: { classify, generateReply: vi.fn() } as never,
      usageRepository: {
        getLastSuccessfulAt: vi.fn().mockResolvedValue(undefined),
        countRecentSuccessful: vi.fn().mockResolvedValue(10),
      } as never,
    });
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'AI hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'ai', aiInstructions: 'asks about hours' },
        action: { type: 'SEND_MESSAGE', message: 'fallback' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({
        autoReplyEnabled: true,
        aiEnabled: true,
        aiAutoReplyEnabled: true,
        aiSemanticClassificationEnabled: true,
        aiMaxResponsesPerHour: 1,
      }),
    );
    expect(classify).not.toHaveBeenCalled();
    expect(sender.sentTo).toHaveLength(0);
  });

  it('group isolation: auto-reply enabled in one group never fires for another group’s identical rule setup', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-2',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    // Evaluate against group-1 (different group, no rule there), with auto-reply enabled.
    await engine.evaluate(autoReplyEvent(), 'group-1', settingsWith({ autoReplyEnabled: true }));
    expect(sender.sentTo).toHaveLength(0);
  });

  it('neverAutoReply overrides a matching, otherwise-firing auto_reply rule unconditionally', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({ autoReplyEnabled: true, neverAutoReply: true }),
    );
    expect(sender.sentTo).toHaveLength(0);
  });

  it('Human Takeover suppresses a matching auto_reply rule while active, and is audited', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });
    const takeoverUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({ autoReplyEnabled: true, humanTakeoverUntil: takeoverUntil }),
    );

    expect(sender.sentTo).toHaveLength(0);
    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ status: 'skipped' });
    expect(actions[0]?.detail).toMatchObject({ reason: 'human_takeover_active' });
  });

  it('an expired Human Takeover no longer suppresses auto_reply', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });
    const expiredTakeover = new Date(Date.now() - 60 * 1000).toISOString();

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({ autoReplyEnabled: true, humanTakeoverUntil: expiredTakeover }),
    );

    expect(sender.sentTo).toEqual([{ jid: 'group@g.us', text: 'We are open 9-5.' }]);
  });

  it('Quiet Hours suppresses a matching auto_reply rule while inside the window, and is audited', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });
    // A window covering every minute of every day — deterministically "always on" for this test.
    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({
        autoReplyEnabled: true,
        quietHoursEnabled: true,
        quietHoursTimezone: 'UTC',
        quietHoursDays: [],
        quietHoursStartMinutes: 0,
        quietHoursEndMinutes: 1439,
      }),
    );

    expect(sender.sentTo).toHaveLength(0);
    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ status: 'skipped' });
    expect(actions[0]?.detail).toMatchObject({ reason: 'quiet_hours' });
  });

  it('Dry Run: a qualifying message never actually sends, but is logged as "would have"', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({ autoReplyEnabled: true, dryRunEnabled: true }),
    );

    expect(sender.sentTo).toHaveLength(0);
    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ status: 'skipped' });
    expect(actions[0]?.detail).toMatchObject({
      reason: 'dry_run',
      wouldHaveActed: 'send message: "We are open 9-5."',
    });
    const events = await deps.auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'rule.dry_run')).toBeTruthy();
    expect(events.find((e) => e.eventType === 'rule.fired')).toBeFalsy();
  });

  it('Approval Before Send: a qualifying message is held as a pending approval, never sent directly', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({ autoReplyEnabled: true, approvalRequired: true }),
    );

    expect(sender.sentTo).toHaveLength(0);
    const approvals = await deps.pendingApprovals.list('acct-1');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      status: 'pending',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'We are open 9-5.',
    });

    const inboxItems = await deps.ownerInbox.list('acct-1');
    expect(inboxItems.find((i) => i.category === 'pending_approval')).toBeTruthy();
    const events = await deps.auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'approval.pending')).toBeTruthy();
    expect(events.find((e) => e.eventType === 'rule.fired')).toBeFalsy();
  });

  it('Dry Run takes precedence over Approval Before Send: neither a send nor a pending approval is created', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent(),
      'group-1',
      settingsWith({ autoReplyEnabled: true, approvalRequired: true, dryRunEnabled: true }),
    );

    expect(sender.sentTo).toHaveLength(0);
    expect(await deps.pendingApprovals.list('acct-1')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// moderation (Phase 6+)
// ---------------------------------------------------------------------

function moderationEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    accountId: 'acct-1',
    chatJid: 'group@g.us',
    context: 'group',
    groupJid: 'group@g.us',
    whatsappMessageId: `MSG-${Math.random().toString(36).slice(2)}`,
    senderJid: 'spammer@s.whatsapp.net',
    fromMe: false,
    timestamp: new Date().toISOString(),
    messageType: 'conversation',
    text: 'this has a bad word in it',
    quotedWhatsappMessageId: undefined,
    quotedParticipant: undefined,
    ...overrides,
  };
}

describe('RuleEngine — moderation', () => {
  it('does nothing when moderationEnabled is false (safe default)', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'WARN', message: 'Please watch your language.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(moderationEvent(), 'group-1', settingsWith({ moderationEnabled: false }));
    expect(sender.sentTo).toHaveLength(0);
  });

  it('WARN fires on a banned phrase when moderationEnabled is true', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'WARN', message: 'Please watch your language.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(moderationEvent(), 'group-1', settingsWith({ moderationEnabled: true }));
    expect(sender.sentTo).toEqual([{ jid: 'group@g.us', text: 'Please watch your language.' }]);
  });

  it('neverModerate overrides a matching, otherwise-firing moderation rule unconditionally', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'WARN', message: 'Please watch your language.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      moderationEvent(),
      'group-1',
      settingsWith({ moderationEnabled: true, neverModerate: true }),
    );
    expect(sender.sentTo).toHaveLength(0);
  });

  it('DELETE_MESSAGE is never executed unless moderationDestructiveActionsEnabled is explicitly true', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'DELETE_MESSAGE' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      moderationEvent(),
      'group-1',
      settingsWith({ moderationEnabled: true, moderationDestructiveActionsEnabled: false }),
    );
    expect(deps.moderationCapabilities.deleteMessage).not.toHaveBeenCalled();

    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ status: 'skipped' });
  });

  it('DELETE_MESSAGE executes once moderationDestructiveActionsEnabled is true', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'DELETE_MESSAGE' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      moderationEvent(),
      'group-1',
      settingsWith({ moderationEnabled: true, moderationDestructiveActionsEnabled: true }),
    );
    expect(deps.moderationCapabilities.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('respects cooldownSeconds between fires', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'WARN', message: 'warned' },
        cooldownSeconds: 3600,
      },
    });

    const settings = settingsWith({ moderationEnabled: true });
    await engine.evaluate(moderationEvent(), 'group-1', settings);
    await engine.evaluate(
      moderationEvent({ senderJid: 'another-spammer@s.whatsapp.net' }),
      'group-1',
      settings,
    );
    expect(sender.sentTo).toHaveLength(1);
  });

  it('records an audit trail with the violation type', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'LOG_ONLY' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(moderationEvent(), 'group-1', settingsWith({ moderationEnabled: true }));

    const events = await deps.auditRepository.listRecent();
    const firedEvent = events.find((e) => e.eventType === 'moderation.fired');
    expect(firedEvent?.detail).toMatchObject({ violationType: 'banned_phrase' });
  });

  it('records an Owner Inbox item when a moderation rule fires', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'WARN', message: 'Please watch your language.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(moderationEvent(), 'group-1', settingsWith({ moderationEnabled: true }));

    const items = await deps.ownerInbox.list('acct-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'moderation', groupId: 'group-1' });
  });

  it('a clean message never triggers moderation', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'WARN', message: 'warned' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      moderationEvent({ text: 'hello, nice to meet you' }),
      'group-1',
      settingsWith({ moderationEnabled: true }),
    );
    expect(sender.sentTo).toHaveLength(0);
  });

  it('Dry Run: DELETE_MESSAGE never actually deletes, but is logged as "would have"', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'No bad words',
      triggerType: 'moderation',
      config: {
        qualify: {
          bannedPhrases: ['bad word'],
          spamRepeatThreshold: 0,
          spamWindowSeconds: 30,
          detectLinks: false,
        },
        action: { type: 'DELETE_MESSAGE' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      moderationEvent(),
      'group-1',
      settingsWith({
        moderationEnabled: true,
        moderationDestructiveActionsEnabled: true,
        dryRunEnabled: true,
      }),
    );

    expect(deps.moderationCapabilities.deleteMessage).not.toHaveBeenCalled();
    const actions = await deps.auditRepository.listRecentActions();
    expect(actions[0]).toMatchObject({ status: 'skipped' });
    expect(actions[0]?.detail).toMatchObject({ reason: 'dry_run' });
    const events = await deps.auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'moderation.dry_run')).toBeTruthy();
    expect(events.find((e) => e.eventType === 'moderation.fired')).toBeFalsy();
  });
});

describe('RuleEngine — escalation', () => {
  it('fires on a matching phrase: notifies the owner, records an Owner Inbox item, and audits', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    deps.ownerJids.push('15550001111@s.whatsapp.net');
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Refund escalation',
      triggerType: 'escalation',
      config: {
        qualify: { mode: 'contains', phrases: ['refund'] },
        action: {
          category: 'refund',
          notifyOwner: true,
          createInboxItem: true,
          suppressAutoReply: true,
        },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent({ text: 'I want a refund please' }),
      'group-1',
      settingsWith({}),
    );

    expect(sender.sentTo).toHaveLength(1);
    expect(sender.sentTo[0]!.jid).toBe('15550001111@s.whatsapp.net');
    const items = await deps.ownerInbox.list('acct-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'rule_fired' });
    expect(items[0]!.title).toContain('refund');
    const events = await deps.auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'escalation.fired')).toBeTruthy();
  });

  it('suppressAutoReply prevents an otherwise-matching auto_reply rule from firing on the same message', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Refund escalation',
      triggerType: 'escalation',
      config: {
        qualify: { mode: 'contains', phrases: ['refund'] },
        action: {
          category: 'refund',
          notifyOwner: false,
          createInboxItem: false,
          suppressAutoReply: true,
        },
        cooldownSeconds: 0,
      },
    });
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Generic auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['refund'] },
        action: { type: 'SEND_MESSAGE', message: 'We will get back to you.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent({ text: 'I want a refund please' }),
      'group-1',
      settingsWith({ autoReplyEnabled: true }),
    );

    expect(sender.sentTo).toHaveLength(0);
  });

  it('suppressAutoReply: false lets a matching auto_reply rule still fire', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Refund escalation',
      triggerType: 'escalation',
      config: {
        qualify: { mode: 'contains', phrases: ['refund'] },
        action: {
          category: 'refund',
          notifyOwner: false,
          createInboxItem: false,
          suppressAutoReply: false,
        },
        cooldownSeconds: 0,
      },
    });
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Generic auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['refund'] },
        action: { type: 'SEND_MESSAGE', message: 'We will get back to you.' },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent({ text: 'I want a refund please' }),
      'group-1',
      settingsWith({ autoReplyEnabled: true }),
    );

    expect(sender.sentTo).toEqual([{ jid: 'group@g.us', text: 'We will get back to you.' }]);
  });

  it('Dry Run: never notifies/records an inbox item, logs "would have" instead', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    deps.ownerJids.push('15550001111@s.whatsapp.net');
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Refund escalation',
      triggerType: 'escalation',
      config: {
        qualify: { mode: 'contains', phrases: ['refund'] },
        action: {
          category: 'refund',
          notifyOwner: true,
          createInboxItem: true,
          suppressAutoReply: true,
        },
        cooldownSeconds: 0,
      },
    });

    await engine.evaluate(
      autoReplyEvent({ text: 'I want a refund please' }),
      'group-1',
      settingsWith({ dryRunEnabled: true }),
    );

    expect(sender.sentTo).toHaveLength(0);
    expect(await deps.ownerInbox.list('acct-1')).toHaveLength(0);
    const events = await deps.auditRepository.listRecent();
    expect(events.find((e) => e.eventType === 'escalation.dry_run')).toBeTruthy();
    expect(events.find((e) => e.eventType === 'escalation.fired')).toBeFalsy();
  });

  it('respects cooldownSeconds between fires', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    deps.ownerJids.push('15550001111@s.whatsapp.net');
    await deps.rulesRepository.create({
      groupId: 'group-1',
      name: 'Refund escalation',
      triggerType: 'escalation',
      config: {
        qualify: { mode: 'contains', phrases: ['refund'] },
        action: {
          category: 'refund',
          notifyOwner: true,
          createInboxItem: false,
          suppressAutoReply: false,
        },
        cooldownSeconds: 3600,
      },
    });

    await engine.evaluate(
      autoReplyEvent({ text: 'refund please', senderJid: 'a@s.whatsapp.net' }),
      'group-1',
      settingsWith({}),
    );
    await engine.evaluate(
      autoReplyEvent({ text: 'refund please', senderJid: 'b@s.whatsapp.net' }),
      'group-1',
      settingsWith({}),
    );

    expect(sender.sentTo).toHaveLength(1);
  });

  it('works for private contacts too (unlike moderation, which is group-only)', async () => {
    const fake = new FakeSupabaseClient();
    const sender = fakeSender();
    const { engine, deps } = buildFullEngine(fake, sender);
    deps.ownerJids.push('15550001111@s.whatsapp.net');
    await deps.rulesRepository.createForContact({
      contactId: 'contact-row-1',
      name: 'Refund escalation',
      triggerType: 'escalation',
      config: {
        qualify: { mode: 'contains', phrases: ['refund'] },
        action: {
          category: 'refund',
          notifyOwner: true,
          createInboxItem: true,
          suppressAutoReply: true,
        },
        cooldownSeconds: 0,
      },
    });

    const privateEvent: NormalizedMessageEvent = {
      accountId: 'acct-1',
      chatJid: 'contact@s.whatsapp.net',
      context: 'private',
      groupJid: undefined,
      whatsappMessageId: 'MSG1',
      senderJid: 'contact@s.whatsapp.net',
      fromMe: false,
      timestamp: new Date().toISOString(),
      messageType: 'conversation',
      text: 'I need a refund',
      quotedWhatsappMessageId: undefined,
      quotedParticipant: undefined,
    };

    const contactSettings: ContactSettings = {
      ...DEFAULT_CONTACT_SETTINGS,
      contactId: 'contact-row-1',
      updatedAt: new Date().toISOString(),
    };
    await engine.evaluatePrivate(privateEvent, 'contact-row-1', contactSettings);

    expect(sender.sentTo).toHaveLength(1);
    const items = await deps.ownerInbox.list('acct-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'rule_fired', contactId: 'contact-row-1' });
  });
});
