import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FakeSupabaseClient } from './fakeSupabaseClient';
import { PendingApprovalsRepository } from './pendingApprovalsRepository';

function repo(fake: FakeSupabaseClient): PendingApprovalsRepository {
  return new PendingApprovalsRepository(fake as unknown as SupabaseClient);
}

describe('PendingApprovalsRepository', () => {
  it('creates a pending approval and reads it back', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);

    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      ruleId: 'rule-1',
      triggerWhatsappMessageId: 'MSG1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'We will get back to you.',
    });

    expect(approval).toMatchObject({
      accountId: 'acct-1',
      groupId: 'group-1',
      contactId: undefined,
      status: 'pending',
      proposedMessage: 'We will get back to you.',
    });
    expect(await repository.getById(approval.id)).toMatchObject({ id: approval.id });
  });

  it('list() filters by account and by status', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Hello',
    });
    const other = await repository.create({
      accountId: 'acct-2',
      contactId: 'contact-1',
      targetChatJid: 'contact@s.whatsapp.net',
      proposedMessage: 'Hi there',
    });
    await repository.reject(other.id, 'owner');

    expect(await repository.list('acct-1')).toHaveLength(1);
    expect(await repository.list(undefined)).toHaveLength(2);
    expect(await repository.list('acct-2', { status: 'rejected' })).toHaveLength(1);
    expect(await repository.list('acct-2', { status: 'pending' })).toHaveLength(0);
  });

  it('approve() moves pending -> approved, optionally overwriting the proposed message', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const approved = await repository.approve(approval.id, 'owner', 'Edited reply');
    expect(approved).toMatchObject({
      status: 'approved',
      decidedBy: 'owner',
      proposedMessage: 'Edited reply',
    });
    expect(approved?.decidedAt).toBeTruthy();
  });

  it('approve() without an edit keeps the original proposed message', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const approved = await repository.approve(approval.id, 'owner');
    expect(approved?.proposedMessage).toBe('Original draft');
  });

  it('reject() moves pending -> rejected and never sends anything', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const rejected = await repository.reject(approval.id, 'owner');
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: 'owner' });
  });

  it('double-approval is impossible: a second approve() on an already-approved row returns undefined', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const first = await repository.approve(approval.id, 'owner');
    const second = await repository.approve(approval.id, 'owner');
    expect(first).toBeTruthy();
    expect(second).toBeUndefined();
  });

  it('concurrent approve() + reject() on the same row: exactly one wins', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    const [approveResult, rejectResult] = await Promise.all([
      repository.approve(approval.id, 'owner'),
      repository.reject(approval.id, 'owner'),
    ]);

    const winners = [approveResult, rejectResult].filter(Boolean);
    expect(winners).toHaveLength(1);

    const final = await repository.getById(approval.id);
    expect(['approved', 'rejected']).toContain(final?.status);
  });

  it('reject() on an already-rejected row returns undefined (idempotency)', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    await repository.reject(approval.id, 'owner');
    expect(await repository.reject(approval.id, 'owner')).toBeUndefined();
  });

  it('markSent() only succeeds from approved, never from pending', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    expect(await repository.markSent(approval.id)).toBe(false);
    await repository.approve(approval.id, 'owner');
    expect(await repository.markSent(approval.id)).toBe(true);
    expect((await repository.getById(approval.id))?.status).toBe('sent');
  });

  it('markFailed() only succeeds from approved', async () => {
    const fake = new FakeSupabaseClient();
    const repository = repo(fake);
    const approval = await repository.create({
      accountId: 'acct-1',
      groupId: 'group-1',
      targetChatJid: 'group@g.us',
      proposedMessage: 'Original draft',
    });

    await repository.approve(approval.id, 'owner');
    expect(await repository.markFailed(approval.id)).toBe(true);
    expect((await repository.getById(approval.id))?.status).toBe('failed');
  });
});
