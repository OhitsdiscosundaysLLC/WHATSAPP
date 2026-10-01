import type { SupabaseClient } from '@supabase/supabase-js';
import { initAuthCreds } from '@whiskeysockets/baileys';
import pino from 'pino';
import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../../db/fakeSupabaseClient';
import { parseEncryptionKey } from '../../db/encryption';
import { SupabaseAuthStateProvider } from './supabaseAuthStateProvider';

const testLogger = pino({ level: 'silent' });
const encryptionKey = parseEncryptionKey(randomBytes(32).toString('hex'));

function asSupabaseClient(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function makeKeyValue(seed: string) {
  // A representative signal-key-shaped value: nested object with a Buffer
  // field, matching what Baileys actually stores for most categories
  // (e.g. pre-keys / sessions carry raw key material as Buffers).
  return { keyId: seed, secret: Buffer.from(`secret-${seed}`), count: seed.length };
}

describe('SupabaseAuthStateProvider', () => {
  it('load() with no existing row returns a fresh, unregistered identity', async () => {
    const fake = new FakeSupabaseClient();
    const provider = new SupabaseAuthStateProvider({
      accountId: 'acct-1',
      supabase: asSupabaseClient(fake),
      encryptionKey,
      logger: testLogger,
    });

    const { state } = await provider.load();
    expect(state.creds.registered).toBe(false);
    expect(await provider.hasExistingSession()).toBe(false);
  });

  it('stores only ciphertext/iv/auth_tag for credentials — never plaintext', async () => {
    const fake = new FakeSupabaseClient();
    const provider = new SupabaseAuthStateProvider({
      accountId: 'acct-1',
      supabase: asSupabaseClient(fake),
      encryptionKey,
      logger: testLogger,
    });

    const { state, saveCreds } = await provider.load();
    (state.creds as { registered: boolean }).registered = true;
    await saveCreds();

    const rows = fake.rawRows('whatsapp_auth_credentials');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual([
      'account_id',
      'auth_tag',
      'ciphertext',
      'iv',
      'updated_at',
    ]);
    expect(String(row.ciphertext)).not.toContain('registered');
    expect(String(row.iv)).not.toContain('registered');
  });

  it(
    'MOST IMPORTANT TEST: survives a simulated process restart — a second, ' +
      'independently-constructed provider instance (no shared memory with the ' +
      'first) loads the exact same credentials and every signal key category ' +
      'that the first instance saved',
    async () => {
      // One fake Supabase client stands in for the durable database; it is
      // the only thing "PROCESS B" is allowed to share with "PROCESS A".
      const sharedDatabase = new FakeSupabaseClient();
      const accountId = 'acct-restart-sim';

      // ---- PROCESS A ----
      let processA: SupabaseAuthStateProvider | undefined = new SupabaseAuthStateProvider({
        accountId,
        supabase: asSupabaseClient(sharedDatabase),
        encryptionKey,
        logger: testLogger,
      });

      const loadedA = await processA.load();
      const credsA = {
        ...initAuthCreds(),
        registered: true,
        me: { id: '1234@s.whatsapp.net', name: 'Test' },
      };
      Object.assign(loadedA.state.creds, credsA);
      await loadedA.saveCreds();

      const preKey = makeKeyValue('prekey-1');
      const session = makeKeyValue('session-1');
      const senderKey = makeKeyValue('senderkey-1');
      const appStateVersion = {
        keyId: Buffer.from('app-state-key-id'),
        fingerprint: Buffer.from('fp'),
      };

      await loadedA.state.keys.set({
        'pre-key': { 'pre-key-1': preKey as never },
        session: { 'session-1': session as never },
        'sender-key': { 'sender-key-1': senderKey as never },
        'app-state-sync-version': { 'app-state-sync-version-1': appStateVersion as never },
      });

      // Simulate the process dying: drop every reference to PROCESS A.
      processA = undefined;

      // ---- PROCESS B: a completely new provider instance ----
      const processB = new SupabaseAuthStateProvider({
        accountId,
        supabase: asSupabaseClient(sharedDatabase),
        encryptionKey,
        logger: testLogger,
      });

      expect(await processB.hasExistingSession()).toBe(true);

      const loadedB = await processB.load();
      expect(loadedB.state.creds.registered).toBe(true);
      expect(loadedB.state.creds.me).toEqual(credsA.me);

      const keys = await loadedB.state.keys.get('pre-key', ['pre-key-1']);
      expect(keys['pre-key-1']).toMatchObject({ keyId: 'prekey-1', count: 8 });
      expect(Buffer.isBuffer((keys['pre-key-1'] as unknown as { secret: Buffer }).secret)).toBe(
        true,
      );
      expect((keys['pre-key-1'] as unknown as { secret: Buffer }).secret.toString()).toBe(
        'secret-prekey-1',
      );

      const sessions = await loadedB.state.keys.get('session', ['session-1']);
      expect(sessions['session-1']).toMatchObject({ keyId: 'session-1' });

      const senderKeys = await loadedB.state.keys.get('sender-key', ['sender-key-1']);
      expect(senderKeys['sender-key-1']).toMatchObject({ keyId: 'senderkey-1' });

      const appStateVersions = await loadedB.state.keys.get('app-state-sync-version', [
        'app-state-sync-version-1',
      ]);
      const revivedVersion = appStateVersions['app-state-sync-version-1'] as unknown as {
        keyId: Buffer;
      };
      expect(Buffer.isBuffer(revivedVersion.keyId)).toBe(true);
      expect(revivedVersion.keyId.toString()).toBe('app-state-key-id');
    },
  );

  it('round-trips app-state-sync-key values through the Baileys protobuf fixup', async () => {
    const fake = new FakeSupabaseClient();
    const provider = new SupabaseAuthStateProvider({
      accountId: 'acct-appstate',
      supabase: asSupabaseClient(fake),
      encryptionKey,
      logger: testLogger,
    });

    const { state } = await provider.load();
    const keyData = {
      keyData: Buffer.from('app-state-sync-key-bytes'),
      fingerprint: { data: Buffer.from('fp') },
    };
    await state.keys.set({ 'app-state-sync-key': { 'key-1': keyData as never } });

    const result = await state.keys.get('app-state-sync-key', ['key-1']);
    const revived = result['key-1'] as { keyData?: Uint8Array };
    // proto.Message.AppStateSyncKeyData.fromObject() output — not a plain object.
    expect(revived).toBeDefined();
    expect(revived?.keyData).toBeDefined();
  });

  it('set() with a null value deletes that key rather than storing it', async () => {
    const fake = new FakeSupabaseClient();
    const provider = new SupabaseAuthStateProvider({
      accountId: 'acct-1',
      supabase: asSupabaseClient(fake),
      encryptionKey,
      logger: testLogger,
    });
    const { state } = await provider.load();

    await state.keys.set({ 'pre-key': { k1: makeKeyValue('k1') as never } });
    expect((await state.keys.get('pre-key', ['k1'])).k1).toBeDefined();

    await state.keys.set({ 'pre-key': { k1: null } });
    expect((await state.keys.get('pre-key', ['k1'])).k1).toBeUndefined();
  });

  it('clear() removes both credentials and all signal keys for the account', async () => {
    const fake = new FakeSupabaseClient();
    const provider = new SupabaseAuthStateProvider({
      accountId: 'acct-1',
      supabase: asSupabaseClient(fake),
      encryptionKey,
      logger: testLogger,
    });
    const { state, saveCreds } = await provider.load();
    await saveCreds();
    await state.keys.set({ 'pre-key': { k1: makeKeyValue('k1') as never } });

    await provider.clear();

    expect(fake.rawRows('whatsapp_auth_credentials')).toHaveLength(0);
    expect(fake.rawRows('whatsapp_auth_keys')).toHaveLength(0);
    expect(await provider.hasExistingSession()).toBe(false);
  });

  it("multi-account isolation: two accounts never see each other's credentials or keys", async () => {
    const fake = new FakeSupabaseClient();
    const providerA = new SupabaseAuthStateProvider({
      accountId: 'acct-A',
      supabase: asSupabaseClient(fake),
      encryptionKey,
      logger: testLogger,
    });
    const providerB = new SupabaseAuthStateProvider({
      accountId: 'acct-B',
      supabase: asSupabaseClient(fake),
      encryptionKey,
      logger: testLogger,
    });

    const loadedA = await providerA.load();
    loadedA.state.creds.me = { id: 'A@s.whatsapp.net', name: 'Account A' };
    await loadedA.saveCreds();
    await loadedA.state.keys.set({ 'pre-key': { shared_id: makeKeyValue('from-A') as never } });

    const loadedB = await providerB.load();
    // B never saved creds — must still be a blank, unregistered identity,
    // not accidentally A's.
    expect(loadedB.state.creds.registered).toBe(false);
    expect(loadedB.state.creds.me).toBeUndefined();

    // Same key_id ("shared_id") used by both accounts — composite PK
    // (account_id, category, key_id) must keep them separate.
    await loadedB.state.keys.set({ 'pre-key': { shared_id: makeKeyValue('from-B') as never } });

    const fromA = await loadedA.state.keys.get('pre-key', ['shared_id']);
    const fromB = await loadedB.state.keys.get('pre-key', ['shared_id']);
    expect((fromA.shared_id as unknown as { keyId: string }).keyId).toBe('from-A');
    expect((fromB.shared_id as unknown as { keyId: string }).keyId).toBe('from-B');

    await providerA.clear();
    expect(await providerA.hasExistingSession()).toBe(false);
    // B's data must be untouched by A's clear().
    const bStillThere = await loadedB.state.keys.get('pre-key', ['shared_id']);
    expect((bStillThere.shared_id as unknown as { keyId: string }).keyId).toBe('from-B');
  });

  it('throws (never silently returns blank creds) when the underlying query fails', async () => {
    const failingClient = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: 'connection refused' } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const provider = new SupabaseAuthStateProvider({
      accountId: 'acct-1',
      supabase: failingClient,
      encryptionKey,
      logger: testLogger,
    });

    await expect(provider.load()).rejects.toThrow(/Failed to load WhatsApp credentials/);
  });
});
