import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ContactsRepository } from '../db/contactsRepository';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import { GroupsRepository } from '../db/groupsRepository';
import { RulesRepository } from '../db/rulesRepository';
import { simulateMessage } from './ruleSimulator';

const testLogger = pino({ level: 'silent' });

function setup() {
  const fake = new FakeSupabaseClient();
  const supabase = fake as unknown as SupabaseClient;
  return {
    fake,
    supabase,
    groupsRepository: new GroupsRepository(supabase),
    contactsRepository: new ContactsRepository(supabase),
    rulesRepository: new RulesRepository(supabase),
  };
}

describe('simulateMessage', () => {
  it('reports a matching auto_reply rule and exactly what it would send, never actually sending', async () => {
    const { supabase, groupsRepository, rulesRepository } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await groupsRepository.updateSettings(group.id, { autoReplyEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    const outcome = await simulateMessage(supabase, [], testLogger, {
      groupId: group.id,
      senderJid: 'alice@s.whatsapp.net',
      text: 'what are your hours?',
    });

    expect(outcome.rules).toHaveLength(1);
    expect(outcome.rules[0]).toMatchObject({
      ruleName: 'Hours auto-reply',
      triggerType: 'auto_reply',
      matched: 'yes',
      wouldHaveActed: 'send message: "We are open 9-5."',
    });
  });

  it('reports "no" for a rule whose phrases do not match', async () => {
    const { supabase, groupsRepository, rulesRepository } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await groupsRepository.updateSettings(group.id, { autoReplyEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    const outcome = await simulateMessage(supabase, [], testLogger, {
      groupId: group.id,
      senderJid: 'alice@s.whatsapp.net',
      text: 'completely unrelated message',
    });

    expect(outcome.rules[0]).toMatchObject({ matched: 'no' });
  });

  it('never actually sends anything, even for a matching rule', async () => {
    const { supabase, groupsRepository, rulesRepository } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await groupsRepository.updateSettings(group.id, { autoReplyEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    // No sender is wired in at all (simulateMessage never takes one) — if it
    // ever tried to send for real, this would throw inside RuleEngine's
    // action-execution path and the test would fail with an unhandled error.
    await expect(
      simulateMessage(supabase, [], testLogger, {
        groupId: group.id,
        senderJid: 'alice@s.whatsapp.net',
        text: 'what are your hours?',
      }),
    ).resolves.toBeDefined();
  });

  it('never persists any real state: a second identical simulation produces the same result', async () => {
    const { supabase, groupsRepository, rulesRepository } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await groupsRepository.updateSettings(group.id, { autoReplyEnabled: true });
    await rulesRepository.create({
      groupId: group.id,
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 60,
      },
    });

    const input = {
      groupId: group.id,
      senderJid: 'alice@s.whatsapp.net',
      text: 'what are your hours?',
    };
    const first = await simulateMessage(supabase, [], testLogger, input);
    const second = await simulateMessage(supabase, [], testLogger, input);

    expect(first.rules[0]?.matched).toBe('yes');
    // If cooldown state leaked between calls, the second call would show
    // "cooldown_active" instead of the clean "Qualifies." result.
    expect(second.rules[0]?.matched).toBe('yes');
    expect(second.rules[0]?.reason).toBe('Qualifies.');
  });

  it('reports distinct-responder count and threshold for response_threshold rules', async () => {
    const { supabase, groupsRepository, rulesRepository } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await rulesRepository.create({
      groupId: group.id,
      name: 'Five people congratulate',
      triggerType: 'response_threshold',
      config: {
        targetMessageMatch: 'quoted',
        qualify: { mode: 'contains', phrases: ['congrats'] },
        threshold: 5,
        action: { type: 'SEND_MESSAGE', message: 'Thanks everyone!' },
        cooldownSeconds: 0,
      },
    });

    const outcome = await simulateMessage(supabase, [], testLogger, {
      groupId: group.id,
      senderJid: 'alice@s.whatsapp.net',
      text: 'congrats!!',
      quotedWhatsappMessageId: 'TARGET1',
    });

    expect(outcome.rules[0]).toMatchObject({
      matched: 'yes',
      distinctResponders: 1,
      threshold: 5,
    });
  });

  it('flags AI-based rules as not simulated, never making a real AI call', async () => {
    const { supabase, groupsRepository, rulesRepository } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await groupsRepository.updateSettings(group.id, {
      autoReplyEnabled: true,
      aiEnabled: true,
      aiAutoReplyEnabled: true,
      aiSemanticClassificationEnabled: true,
    });
    await rulesRepository.create({
      groupId: group.id,
      name: 'AI Q&A',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'ai', aiInstructions: 'asks about pricing' },
        action: { type: 'AI_REPLY' },
        cooldownSeconds: 0,
      },
    });

    const outcome = await simulateMessage(supabase, [], testLogger, {
      groupId: group.id,
      senderJid: 'alice@s.whatsapp.net',
      text: 'how much does it cost?',
    });

    expect(outcome.rules[0]).toMatchObject({ matched: 'ai_not_simulated' });
  });

  it('adds a note when Auto-Reply is off, explaining the silent suppression', async () => {
    const { supabase, groupsRepository, rulesRepository } = setup();
    const group = await groupsRepository.upsertDiscoveredGroup('acct-1', 'group@g.us', 'Team Chat');
    await rulesRepository.create({
      groupId: group.id,
      name: 'Hours auto-reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    const outcome = await simulateMessage(supabase, [], testLogger, {
      groupId: group.id,
      senderJid: 'alice@s.whatsapp.net',
      text: 'what are your hours?',
    });

    expect(outcome.notes.some((n) => n.includes('Auto-Reply is OFF'))).toBe(true);
    expect(outcome.rules[0]?.matched).toBe('no');
  });

  it('works for private contacts the same way it works for groups', async () => {
    const { supabase, contactsRepository, rulesRepository } = setup();
    const contact = await contactsRepository.upsertDiscoveredContact(
      'acct-1',
      'contact@s.whatsapp.net',
      'A Contact',
    );
    await contactsRepository.updateSettings(contact.id, { privateAutoReplyEnabled: true });
    await rulesRepository.createForContact({
      contactId: contact.id,
      name: 'Hours reply',
      triggerType: 'auto_reply',
      config: {
        qualify: { classifier: 'deterministic', mode: 'contains', phrases: ['hours'] },
        action: { type: 'SEND_MESSAGE', message: 'We are open 9-5.' },
        cooldownSeconds: 0,
      },
    });

    const outcome = await simulateMessage(supabase, [], testLogger, {
      contactId: contact.id,
      senderJid: 'contact@s.whatsapp.net',
      text: 'what are your hours?',
    });

    expect(outcome.rules[0]).toMatchObject({ matched: 'yes' });
  });

  it('rejects when both groupId and contactId are given, or neither', async () => {
    const { supabase } = setup();
    await expect(
      simulateMessage(supabase, [], testLogger, { senderJid: 'a@s.whatsapp.net', text: 'hi' }),
    ).rejects.toThrow();
    await expect(
      simulateMessage(supabase, [], testLogger, {
        groupId: 'g1',
        contactId: 'c1',
        senderJid: 'a@s.whatsapp.net',
        text: 'hi',
      }),
    ).rejects.toThrow();
  });
});
