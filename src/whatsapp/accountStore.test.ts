import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from '../db/fakeSupabaseClient';
import {
  JsonManifestAccountStore,
  SupabaseAccountStore,
  type AccountStore,
  type StoredAccount,
} from './accountStore';

function asSupabaseClient(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: 'acct-1',
    label: 'Front Desk',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Both implementations satisfy the exact same `AccountStore` contract, so
 * this single suite runs against each — proving they're truly
 * interchangeable, not just superficially similar.
 */
function sharedAccountStoreTests(makeStore: () => Promise<AccountStore> | AccountStore): void {
  it('list() is empty before any account is created', async () => {
    const store = await makeStore();
    expect(await store.list()).toEqual([]);
  });

  it('create() then list() returns the created account', async () => {
    const store = await makeStore();
    await store.create(account());
    const accounts = await store.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: 'acct-1', label: 'Front Desk' });
  });

  it('list() returns multiple accounts ordered by creation time', async () => {
    const store = await makeStore();
    await store.create(account({ id: 'a', label: 'First', createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.create(
      account({ id: 'b', label: 'Second', createdAt: '2026-01-02T00:00:00.000Z' }),
    );
    const accounts = await store.list();
    expect(accounts.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('remove() deletes the account', async () => {
    const store = await makeStore();
    await store.create(account());
    await store.remove('acct-1');
    expect(await store.list()).toEqual([]);
  });

  it('touchLastConnected() sets lastConnectedAt on the account', async () => {
    const store = await makeStore();
    await store.create(account());
    expect((await store.list())[0]!.lastConnectedAt).toBeUndefined();

    await store.touchLastConnected('acct-1');

    const updated = (await store.list())[0]!;
    expect(updated.lastConnectedAt).toBeTruthy();
    expect(() => new Date(updated.lastConnectedAt!).toISOString()).not.toThrow();
  });

  it('touchLastConnected() on an unknown id does not throw', async () => {
    const store = await makeStore();
    await expect(store.touchLastConnected('does-not-exist')).resolves.not.toThrow();
  });
}

describe('JsonManifestAccountStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-account-store-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  sharedAccountStoreTests(() => new JsonManifestAccountStore(dir));

  it('kind is "file"', () => {
    expect(new JsonManifestAccountStore(dir).kind).toBe('file');
  });

  it('persists across independently-constructed instances (survives a simulated restart)', async () => {
    const storeA = new JsonManifestAccountStore(dir);
    await storeA.create(account());

    const storeB = new JsonManifestAccountStore(dir);
    const accounts = await storeB.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id).toBe('acct-1');
  });
});

describe('SupabaseAccountStore', () => {
  sharedAccountStoreTests(
    () => new SupabaseAccountStore(asSupabaseClient(new FakeSupabaseClient())),
  );

  it('kind is "supabase"', () => {
    expect(new SupabaseAccountStore(asSupabaseClient(new FakeSupabaseClient())).kind).toBe(
      'supabase',
    );
  });

  it('throws on list() failure rather than silently returning an empty list', async () => {
    const failingClient = {
      from: () => ({
        select: () => ({
          order: async () => ({ data: null, error: { message: 'network error' } }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(new SupabaseAccountStore(failingClient).list()).rejects.toThrow(/Failed to list/);
  });

  it('throws on create() failure', async () => {
    const failingClient = {
      from: () => ({
        insert: async () => ({ error: { message: 'duplicate key' } }),
      }),
    } as unknown as SupabaseClient;

    await expect(new SupabaseAccountStore(failingClient).create(account())).rejects.toThrow(
      /Failed to create/,
    );
  });

  it('touchLastConnected() failure is swallowed (logged, not thrown) — never affects the live connection', async () => {
    const failingClient = {
      from: () => ({
        update: () => ({
          eq: async () => ({ error: { message: 'timeout' } }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      new SupabaseAccountStore(failingClient).touchLastConnected('acct-1'),
    ).resolves.not.toThrow();
  });
});
