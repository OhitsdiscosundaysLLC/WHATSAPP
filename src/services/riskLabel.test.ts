import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTACT_SETTINGS, type ContactSettings } from '../db/contactsRepository';
import { DEFAULT_GROUP_SETTINGS, type GroupSettings } from '../db/groupsRepository';
import {
  computeRiskLabel,
  contactCapabilitySummary,
  contactRiskLabel,
  groupCapabilitySummary,
  groupRiskLabel,
} from './riskLabel';

function groupSettings(overrides: Partial<GroupSettings> = {}): GroupSettings {
  return {
    groupId: 'g1',
    updatedAt: new Date().toISOString(),
    ...DEFAULT_GROUP_SETTINGS,
    ...overrides,
  };
}

function contactSettings(overrides: Partial<ContactSettings> = {}): ContactSettings {
  return {
    contactId: 'c1',
    updatedAt: new Date().toISOString(),
    ...DEFAULT_CONTACT_SETTINGS,
    ...overrides,
  };
}

describe('computeRiskLabel', () => {
  it('is low with a clear reason when the bot is off', () => {
    const result = computeRiskLabel({
      botEnabled: false,
      monitoringEnabled: false,
      autoReplyEnabled: false,
      aiEnabled: false,
      aiAutoReplyEnabled: false,
      moderationEnabled: false,
      moderationDestructiveActionsEnabled: false,
      approvalRequired: false,
      dryRunEnabled: false,
    });
    expect(result.level).toBe('low');
    expect(result.reasons[0]).toMatch(/bot is off/i);
  });

  it('is low and explicitly idle when the bot is on but nothing else is', () => {
    const result = computeRiskLabel({
      botEnabled: true,
      monitoringEnabled: false,
      autoReplyEnabled: false,
      aiEnabled: false,
      aiAutoReplyEnabled: false,
      moderationEnabled: false,
      moderationDestructiveActionsEnabled: false,
      approvalRequired: false,
      dryRunEnabled: false,
    });
    expect(result.level).toBe('low');
    expect(result.reasons[0]).toMatch(/no monitoring/i);
  });

  it('is medium when auto-reply can send messages', () => {
    const result = computeRiskLabel({
      botEnabled: true,
      monitoringEnabled: true,
      autoReplyEnabled: true,
      aiEnabled: false,
      aiAutoReplyEnabled: false,
      moderationEnabled: false,
      moderationDestructiveActionsEnabled: false,
      approvalRequired: false,
      dryRunEnabled: false,
    });
    expect(result.level).toBe('medium');
  });

  it('is high when moderation can delete messages or remove members', () => {
    const result = computeRiskLabel({
      botEnabled: true,
      monitoringEnabled: true,
      autoReplyEnabled: false,
      aiEnabled: false,
      aiAutoReplyEnabled: false,
      moderationEnabled: true,
      moderationDestructiveActionsEnabled: true,
      approvalRequired: false,
      dryRunEnabled: false,
    });
    expect(result.level).toBe('high');
  });

  it('Dry Run always overrides the level down to low, even with destructive moderation on', () => {
    const result = computeRiskLabel({
      botEnabled: true,
      monitoringEnabled: true,
      autoReplyEnabled: true,
      aiEnabled: true,
      aiAutoReplyEnabled: true,
      moderationEnabled: true,
      moderationDestructiveActionsEnabled: true,
      approvalRequired: false,
      dryRunEnabled: true,
    });
    expect(result.level).toBe('low');
    expect(result.reasons[0]).toMatch(/dry run/i);
  });

  it('notes approval-required as risk-lowering without changing the level itself', () => {
    const result = computeRiskLabel({
      botEnabled: true,
      monitoringEnabled: true,
      autoReplyEnabled: true,
      aiEnabled: true,
      aiAutoReplyEnabled: true,
      moderationEnabled: false,
      moderationDestructiveActionsEnabled: false,
      approvalRequired: true,
      dryRunEnabled: false,
    });
    expect(result.level).toBe('medium');
    expect(result.reasons.some((r) => /approval/i.test(r))).toBe(true);
  });
});

describe('groupRiskLabel / groupCapabilitySummary', () => {
  it('reports low + idle for safe-default (all-off) group settings', () => {
    const settings = groupSettings();
    expect(groupRiskLabel(settings).level).toBe('low');
    expect(groupCapabilitySummary(settings)).toEqual([
      'Bot is off — none of the capabilities below can run until it is turned on.',
      'Currently idle — no monitoring, auto-reply, AI, or moderation capability is active.',
    ]);
  });

  it('lists every active capability in plain language', () => {
    const settings = groupSettings({
      botEnabled: true,
      monitoringEnabled: true,
      autoReplyEnabled: true,
      viewOnceHandlingEnabled: true,
      mediaArchiveEnabled: true,
      approvalRequired: true,
    });
    const summary = groupCapabilitySummary(settings);
    expect(summary).not.toContain(
      'Bot is off — none of the capabilities below can run until it is turned on.',
    );
    expect(summary.some((l) => l.includes('Stores incoming messages'))).toBe(true);
    expect(summary.some((l) => l.includes('automatic replies'))).toBe(true);
    expect(summary.some((l) => l.includes('view-once'))).toBe(true);
    expect(summary.some((l) => l.includes('ordinary incoming media'))).toBe(true);
    expect(summary.some((l) => l.includes('wait for owner approval'))).toBe(true);
    expect(groupRiskLabel(settings).level).toBe('medium');
  });

  it('mentions an active Human Takeover window but not an expired one', () => {
    const active = groupSettings({
      botEnabled: true,
      humanTakeoverUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(groupCapabilitySummary(active).some((l) => l.includes('Human Takeover is active'))).toBe(
      true,
    );

    const expired = groupSettings({
      botEnabled: true,
      humanTakeoverUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(
      groupCapabilitySummary(expired).some((l) => l.includes('Human Takeover is active')),
    ).toBe(false);
  });
});

describe('contactRiskLabel / contactCapabilitySummary', () => {
  it('reports low + idle for safe-default (all-off) contact settings — contacts have no master switch', () => {
    const settings = contactSettings();
    expect(contactRiskLabel(settings).level).toBe('low');
    expect(contactCapabilitySummary(settings)).toEqual([
      'Currently idle — no monitoring, auto-reply, or AI capability is active.',
    ]);
  });

  it('is medium when private AI auto-reply is fully enabled', () => {
    const settings = contactSettings({
      privateMonitoringEnabled: true,
      privateAiEnabled: true,
      privateAiAutoReplyEnabled: true,
    });
    expect(contactRiskLabel(settings).level).toBe('medium');
    expect(
      contactCapabilitySummary(settings).some((l) => l.includes('AI to generate and send replies')),
    ).toBe(true);
  });
});
