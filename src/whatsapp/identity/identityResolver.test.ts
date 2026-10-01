import type { SupabaseClient } from '@supabase/supabase-js';
import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { IdentityMapRepository } from '../../db/identityMapRepository';
import {
  extractIdentityCandidates,
  recordIdentityIfKnown,
  resolveAuthorizedRole,
} from './identityResolver';

function repo(): IdentityMapRepository {
  return new IdentityMapRepository(new FakeSupabaseClient() as unknown as SupabaseClient);
}

function groupMessage(key: Record<string, unknown>, participant?: string): WAMessage {
  return {
    key: { remoteJid: 'group@g.us', fromMe: false, id: 'MSG1', ...key },
    participant,
    message: { conversation: 'hi' },
  } as WAMessage;
}

describe('extractIdentityCandidates', () => {
  it('extracts the plain @s.whatsapp.net participant when no lid/pn fields are present', () => {
    const msg = groupMessage({ participant: 'owner@s.whatsapp.net' });
    const candidates = extractIdentityCandidates(msg, true);
    expect(candidates).toEqual({
      primary: 'owner@s.whatsapp.net',
      phoneJid: undefined,
      lidJid: undefined,
    });
  });

  it('extracts participantLid/participantPn when Baileys provides both (group message)', () => {
    const msg = groupMessage({
      participant: '123456789@lid',
      participantLid: '123456789@lid',
      participantPn: '15550001111@s.whatsapp.net',
    });
    const candidates = extractIdentityCandidates(msg, true);
    expect(candidates).toEqual({
      primary: '123456789@lid',
      phoneJid: '15550001111@s.whatsapp.net',
      lidJid: '123456789@lid',
    });
  });

  it('uses senderLid/senderPn (not participant*) for a non-group message', () => {
    const msg = {
      key: {
        remoteJid: '123456789@lid',
        fromMe: false,
        id: 'MSG1',
        senderLid: '123456789@lid',
        senderPn: '15550001111@s.whatsapp.net',
      },
      message: { conversation: 'hi' },
    } as WAMessage;
    const candidates = extractIdentityCandidates(msg, false);
    expect(candidates).toEqual({
      primary: '123456789@lid',
      phoneJid: '15550001111@s.whatsapp.net',
      lidJid: '123456789@lid',
    });
  });
});

describe('recordIdentityIfKnown', () => {
  it('records the pairing when both forms are present on the message', async () => {
    const identityMapRepository = repo();
    await recordIdentityIfKnown(
      { primary: '123456789@lid', phoneJid: '15550001111@s.whatsapp.net', lidJid: '123456789@lid' },
      'acct-1',
      identityMapRepository,
    );
    const resolved = await identityMapRepository.getPhoneJidForLid('acct-1', '123456789@lid');
    expect(resolved).toBe('15550001111@s.whatsapp.net');
  });

  it('does nothing when only one form is known', async () => {
    const identityMapRepository = repo();
    await recordIdentityIfKnown(
      { primary: 'owner@s.whatsapp.net', phoneJid: undefined, lidJid: undefined },
      'acct-1',
      identityMapRepository,
    );
    const resolved = await identityMapRepository.getPhoneJidForLid(
      'acct-1',
      'owner@s.whatsapp.net',
    );
    expect(resolved).toBeUndefined();
  });
});

describe('resolveAuthorizedRole', () => {
  it('authorizes the owner via a plain @s.whatsapp.net primary JID', async () => {
    const role = await resolveAuthorizedRole(
      { primary: '15550001111@s.whatsapp.net', phoneJid: undefined, lidJid: undefined },
      'acct-1',
      repo(),
      ['15550001111'],
      [],
    );
    expect(role).toBe('owner');
  });

  it('authorizes the owner via phoneJid carried directly on the message, even though primary is @lid', async () => {
    const role = await resolveAuthorizedRole(
      { primary: '999@lid', phoneJid: '15550001111@s.whatsapp.net', lidJid: '999@lid' },
      'acct-1',
      repo(),
      ['15550001111'],
      [],
    );
    expect(role).toBe('owner');
  });

  it('authorizes the owner via the DURABLE identity map when this message carries only @lid', async () => {
    const identityMapRepository = repo();
    // Seeded earlier — e.g. from group discovery or an earlier message that carried both forms.
    await identityMapRepository.upsert('acct-1', '999@lid', '15550001111@s.whatsapp.net');

    const role = await resolveAuthorizedRole(
      { primary: '999@lid', phoneJid: undefined, lidJid: undefined },
      'acct-1',
      identityMapRepository,
      ['15550001111'],
      [],
    );
    expect(role).toBe('owner');
  });

  it('never authorizes an unconfigured number, regardless of identity form', async () => {
    const role = await resolveAuthorizedRole(
      { primary: '999@lid', phoneJid: '19998887777@s.whatsapp.net', lidJid: '999@lid' },
      'acct-1',
      repo(),
      ['15550001111'],
      [],
    );
    expect(role).toBeUndefined();
  });

  it('the identity map is scoped per account — a mapping in account A never authorizes in account B', async () => {
    const identityMapRepository = repo();
    await identityMapRepository.upsert('acct-A', '999@lid', '15550001111@s.whatsapp.net');

    const role = await resolveAuthorizedRole(
      { primary: '999@lid', phoneJid: undefined, lidJid: undefined },
      'acct-B',
      identityMapRepository,
      ['15550001111'],
      [],
    );
    expect(role).toBeUndefined();
  });

  it('admin authorization also works via the durable @lid map', async () => {
    const identityMapRepository = repo();
    await identityMapRepository.upsert('acct-1', '888@lid', '19998887777@s.whatsapp.net');

    const role = await resolveAuthorizedRole(
      { primary: '888@lid', phoneJid: undefined, lidJid: undefined },
      'acct-1',
      identityMapRepository,
      ['15550001111'],
      ['19998887777'],
    );
    expect(role).toBe('admin');
  });

  it('owner takes precedence when a number is (incorrectly) configured as both owner and admin', async () => {
    const role = await resolveAuthorizedRole(
      { primary: '15550001111@s.whatsapp.net', phoneJid: undefined, lidJid: undefined },
      'acct-1',
      repo(),
      ['15550001111'],
      ['15550001111'],
    );
    expect(role).toBe('owner');
  });

  it('never authorizes based on an unmapped @lid with no corroborating data', async () => {
    const role = await resolveAuthorizedRole(
      { primary: '000@lid', phoneJid: undefined, lidJid: undefined },
      'acct-1',
      repo(),
      ['15550001111'],
      [],
    );
    expect(role).toBeUndefined();
  });
});
