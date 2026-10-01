import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../db/auditRepository';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { RulesRepository } from '../db/rulesRepository';
import { RuleStateRepository } from '../db/ruleStateRepository';
import type { NormalizedMessageEvent } from '../whatsapp/events/messageNormalizer';
import type { MessageSender } from './actionEngine';
import { DeterministicResponseClassifier } from './classifiers/responseClassifier';
import { RuleEngine, type RuleEngineDeps } from './ruleEngine';

const testLogger = pino({ level: 'silent' });

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

function buildEngine(
  fake: FakeSupabaseClient,
  sender: MessageSender,
): { engine: RuleEngine; deps: RuleEngineDeps } {
  const deps: RuleEngineDeps = {
    rulesRepository: new RulesRepository(fake as unknown as SupabaseClient),
    ruleStateRepository: new RuleStateRepository(fake as unknown as SupabaseClient),
    auditRepository: new AuditRepository(fake as unknown as SupabaseClient),
    classifier: new DeterministicResponseClassifier(),
    sender,
    ownerJids: [],
    logger: testLogger,
  };
  return { engine: new RuleEngine(deps), deps };
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
      let processA: { engine: RuleEngine; deps: RuleEngineDeps } | undefined = buildEngine(
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
});
