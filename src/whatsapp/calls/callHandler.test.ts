import type { SupabaseClient } from '@supabase/supabase-js';
import type { WACallEvent } from '@whiskeysockets/baileys';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AccountSettingsRepository } from '../../db/accountSettingsRepository';
import { AuditRepository } from '../../db/auditRepository';
import { CallEventsRepository } from '../../db/callEventsRepository';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { NotificationCooldownRepository } from '../../db/notificationCooldownRepository';
import { handleCallEvent, type CallHandlerDeps } from './callHandler';

const testLogger = pino({ level: 'silent' });

function offerCall(overrides: Partial<WACallEvent> = {}): WACallEvent {
  return {
    chatId: 'caller@s.whatsapp.net',
    from: 'caller@s.whatsapp.net',
    id: 'CALL1',
    date: new Date(),
    status: 'offer',
    offline: false,
    ...overrides,
  };
}

function setup(): {
  fake: FakeSupabaseClient;
  deps: CallHandlerDeps;
  rejectCall: ReturnType<typeof vi.fn>;
} {
  const fake = new FakeSupabaseClient();
  const rejectCall = vi.fn(async () => {});
  const deps: CallHandlerDeps = {
    accountId: 'acct-1',
    accountSettingsRepository: new AccountSettingsRepository(fake as unknown as SupabaseClient),
    callEventsRepository: new CallEventsRepository(fake as unknown as SupabaseClient),
    auditRepository: new AuditRepository(fake as unknown as SupabaseClient),
    notificationCooldowns: new NotificationCooldownRepository(fake as unknown as SupabaseClient),
    sender: { sendTextMessage: vi.fn(async () => {}) },
    connection: { rejectCall },
    ownerJids: ['15550001111@s.whatsapp.net'],
    logger: testLogger,
  };
  return { fake, deps, rejectCall };
}

describe('handleCallEvent', () => {
  it('logs only when callHandlingEnabled is false (safe default)', async () => {
    const { deps, fake, rejectCall } = setup();
    await handleCallEvent(offerCall(), deps);
    expect(rejectCall).not.toHaveBeenCalled();
    expect(deps.sender.sendTextMessage).not.toHaveBeenCalled();
    expect(fake.rawRows('whatsapp_call_events')).toHaveLength(1);
    expect(fake.rawRows('whatsapp_call_events')[0]?.action_taken).toBe('logged');
  });

  it('AUTO_REJECT rejects the call when enabled', async () => {
    const { deps, rejectCall } = setup();
    await deps.accountSettingsRepository.update('acct-1', {
      callHandlingEnabled: true,
      callResponseAction: 'AUTO_REJECT',
    });
    await handleCallEvent(offerCall(), deps);
    expect(rejectCall).toHaveBeenCalledWith('CALL1', 'caller@s.whatsapp.net');
  });

  it('NOTIFY_OWNER notifies configured owners, cooldown-protected', async () => {
    const { deps } = setup();
    await deps.accountSettingsRepository.update('acct-1', {
      callHandlingEnabled: true,
      callResponseAction: 'NOTIFY_OWNER',
    });
    await handleCallEvent(offerCall(), deps);
    expect(deps.sender.sendTextMessage).toHaveBeenCalledTimes(1);

    await handleCallEvent(offerCall({ id: 'CALL2' }), deps);
    expect(deps.sender.sendTextMessage).toHaveBeenCalledTimes(1); // cooldown suppressed the 2nd
  });

  it('SEND_MESSAGE_AFTER replies to the caller with the configured message', async () => {
    const { deps } = setup();
    await deps.accountSettingsRepository.update('acct-1', {
      callHandlingEnabled: true,
      callResponseAction: 'SEND_MESSAGE_AFTER',
      callResponseMessage: "Sorry, I can't take calls.",
    });
    await handleCallEvent(offerCall(), deps);
    expect(deps.sender.sendTextMessage).toHaveBeenCalledWith(
      'caller@s.whatsapp.net',
      "Sorry, I can't take calls.",
    );
  });

  it('never claims to answer the call — AUTO_REJECT only rejects, no audio/media capability exists', async () => {
    const { deps, rejectCall } = setup();
    await deps.accountSettingsRepository.update('acct-1', {
      callHandlingEnabled: true,
      callResponseAction: 'AUTO_REJECT',
    });
    expect(deps).not.toHaveProperty('answerCall');
    await handleCallEvent(offerCall(), deps);
    expect(rejectCall).toHaveBeenCalledTimes(1);
  });

  it('a non-offer status (e.g. terminate) is recorded but never re-triggers the configured action', async () => {
    const { deps, rejectCall } = setup();
    await deps.accountSettingsRepository.update('acct-1', {
      callHandlingEnabled: true,
      callResponseAction: 'AUTO_REJECT',
    });
    await handleCallEvent(offerCall({ status: 'terminate' }), deps);
    expect(rejectCall).not.toHaveBeenCalled();
  });

  it('stores signaling metadata only — never any audio/video payload field', async () => {
    const { deps, fake } = setup();
    await handleCallEvent(offerCall({ isVideo: true }), deps);
    const row = fake.rawRows('whatsapp_call_events')[0];
    expect(row).toMatchObject({
      caller_jid: 'caller@s.whatsapp.net',
      is_video: true,
      status: 'offer',
    });
    expect(Object.keys(row ?? {})).not.toContain('audio');
    expect(Object.keys(row ?? {})).not.toContain('media');
  });
});
