import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { ContactsRepository, DEFAULT_CONTACT_SETTINGS } from './contactsRepository';
import { FakeSupabaseClient } from './fakeSupabaseClient';

function repo(): { repo: ContactsRepository; fake: FakeSupabaseClient } {
  const fake = new FakeSupabaseClient();
  return { repo: new ContactsRepository(fake as unknown as SupabaseClient), fake };
}

describe('ContactsRepository', () => {
  it('upsertDiscoveredContact creates a new contact with safe-default (all-off) settings', async () => {
    const { repo: r } = repo();
    const contact = await r.upsertDiscoveredContact(
      'acct-1',
      '15551234567@s.whatsapp.net',
      undefined,
    );
    expect(contact.whatsappJid).toBe('15551234567@s.whatsapp.net');
    expect(contact.blocked).toBe(false);
    expect(contact.allowlisted).toBe(false);

    const settings = await r.getSettings(contact.id);
    expect(settings).toMatchObject(DEFAULT_CONTACT_SETTINGS);
    expect(settings?.privateMonitoringEnabled).toBe(false);
    expect(settings?.privateAiEnabled).toBe(false);
    expect(settings?.privateAutoReplyEnabled).toBe(false);
  });

  it('upsertDiscoveredContact is idempotent by (account, JID) — identity is the JID, not the name', async () => {
    const { repo: r } = repo();
    const a = await r.upsertDiscoveredContact('acct-1', '123@s.whatsapp.net', undefined);
    const b = await r.upsertDiscoveredContact('acct-1', '123@s.whatsapp.net', undefined);
    expect(b.id).toBe(a.id);
  });

  it('the same JID under two different accounts produces two separate contacts', async () => {
    const { repo: r } = repo();
    const c1 = await r.upsertDiscoveredContact('acct-1', '123@s.whatsapp.net', undefined);
    const c2 = await r.upsertDiscoveredContact('acct-2', '123@s.whatsapp.net', undefined);
    expect(c1.id).not.toBe(c2.id);
  });

  it('a later display name updates the contact in place rather than creating a duplicate row', async () => {
    const { repo: r } = repo();
    const original = await r.upsertDiscoveredContact('acct-1', '123@s.whatsapp.net', undefined);
    const named = await r.upsertDiscoveredContact('acct-1', '123@s.whatsapp.net', 'Alice');
    expect(named.id).toBe(original.id);
    expect(named.displayName).toBe('Alice');
    const all = await r.listByAccount('acct-1');
    expect(all).toHaveLength(1);
  });

  it('updateSettings for one contact never affects another contact (isolation)', async () => {
    const { repo: r } = repo();
    const a = await r.upsertDiscoveredContact('acct-1', 'a@s.whatsapp.net', undefined);
    const b = await r.upsertDiscoveredContact('acct-1', 'b@s.whatsapp.net', undefined);

    await r.updateSettings(a.id, { privateAiEnabled: true, privateMonitoringEnabled: true });

    const settingsA = await r.getSettings(a.id);
    const settingsB = await r.getSettings(b.id);
    expect(settingsA?.privateAiEnabled).toBe(true);
    expect(settingsB?.privateAiEnabled).toBe(false);
    expect(settingsB?.privateMonitoringEnabled).toBe(false);
  });

  it('updateSettings only changes the fields provided, leaving the rest untouched', async () => {
    const { repo: r } = repo();
    const c = await r.upsertDiscoveredContact('acct-1', 'a@s.whatsapp.net', undefined);
    await r.updateSettings(c.id, { privateMonitoringEnabled: true });
    await r.updateSettings(c.id, { privateAiEnabled: true });

    const settings = await r.getSettings(c.id);
    expect(settings?.privateMonitoringEnabled).toBe(true);
    expect(settings?.privateAiEnabled).toBe(true);
  });

  it('getByJid looks up a contact by its WhatsApp JID', async () => {
    const { repo: r } = repo();
    const created = await r.upsertDiscoveredContact('acct-1', 'a@s.whatsapp.net', undefined);
    const found = await r.getByJid('acct-1', 'a@s.whatsapp.net');
    expect(found?.id).toBe(created.id);
    expect(await r.getByJid('acct-1', 'nonexistent@s.whatsapp.net')).toBeUndefined();
  });

  it('updateContact can block a contact independent of its automation settings', async () => {
    const { repo: r } = repo();
    const c = await r.upsertDiscoveredContact('acct-1', 'a@s.whatsapp.net', undefined);
    await r.updateSettings(c.id, { privateAiEnabled: true });

    const blocked = await r.updateContact(c.id, { blocked: true });
    expect(blocked.blocked).toBe(true);

    // blocking never silently clears other settings — it's a separate gate
    const settings = await r.getSettings(c.id);
    expect(settings?.privateAiEnabled).toBe(true);
  });

  it('updateContact can set allowlisted and displayName independently of blocked', async () => {
    const { repo: r } = repo();
    const c = await r.upsertDiscoveredContact('acct-1', 'a@s.whatsapp.net', undefined);
    const updated = await r.updateContact(c.id, { allowlisted: true, displayName: 'Bob' });
    expect(updated.allowlisted).toBe(true);
    expect(updated.displayName).toBe('Bob');
    expect(updated.blocked).toBe(false);
  });
});
