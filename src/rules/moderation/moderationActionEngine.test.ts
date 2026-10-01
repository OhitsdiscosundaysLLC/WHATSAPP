import { describe, expect, it, vi } from 'vitest';
import type { MessageSender } from '../actionEngine';
import {
  executeModerationAction,
  type ModerationCapabilities,
  type MessageKey,
} from './moderationActionEngine';

function sender(): MessageSender & { sent: Array<{ jid: string; text: string }> } {
  const sent: Array<{ jid: string; text: string }> = [];
  return { sent, sendTextMessage: vi.fn(async (jid, text) => void sent.push({ jid, text })) };
}

function moderation(): ModerationCapabilities & {
  deleted: MessageKey[];
  removed: Array<{ groupJid: string; participantJid: string }>;
} {
  const deleted: MessageKey[] = [];
  const removed: Array<{ groupJid: string; participantJid: string }> = [];
  return {
    deleted,
    removed,
    deleteMessage: vi.fn(async (key: MessageKey) => void deleted.push(key)),
    removeParticipant: vi.fn(
      async (groupJid: string, participantJid: string) =>
        void removed.push({ groupJid, participantJid }),
    ),
  };
}

const KEY: MessageKey = {
  remoteJid: 'group@g.us',
  id: 'MSG1',
  participant: 'spammer@s.whatsapp.net',
  fromMe: false,
};

describe('executeModerationAction', () => {
  it('LOG_ONLY never calls sender or moderation capabilities', async () => {
    const s = sender();
    const m = moderation();
    const result = await executeModerationAction(
      { type: 'LOG_ONLY' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: false,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('success');
    expect(s.sendTextMessage).not.toHaveBeenCalled();
  });

  it('WARN sends a message to the group', async () => {
    const s = sender();
    const m = moderation();
    const result = await executeModerationAction(
      { type: 'WARN', message: 'Please stop spamming.' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: false,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('success');
    expect(s.sent).toEqual([{ jid: 'group@g.us', text: 'Please stop spamming.' }]);
  });

  it('DELETE_MESSAGE is SKIPPED (never executed) when destructiveActionsEnabled is false', async () => {
    const s = sender();
    const m = moderation();
    const result = await executeModerationAction(
      { type: 'DELETE_MESSAGE' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: false,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('skipped');
    expect(m.deleteMessage).not.toHaveBeenCalled();
    expect(m.deleted).toHaveLength(0);
  });

  it('REMOVE_USER is SKIPPED (never executed) when destructiveActionsEnabled is false', async () => {
    const s = sender();
    const m = moderation();
    const result = await executeModerationAction(
      { type: 'REMOVE_USER' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: false,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('skipped');
    expect(m.removeParticipant).not.toHaveBeenCalled();
  });

  it('DELETE_MESSAGE executes when destructiveActionsEnabled is explicitly true', async () => {
    const s = sender();
    const m = moderation();
    const result = await executeModerationAction(
      { type: 'DELETE_MESSAGE' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: true,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('success');
    expect(m.deleted).toEqual([KEY]);
  });

  it('REMOVE_USER executes when destructiveActionsEnabled is explicitly true', async () => {
    const s = sender();
    const m = moderation();
    const result = await executeModerationAction(
      { type: 'REMOVE_USER' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: true,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('success');
    expect(m.removed).toEqual([
      { groupJid: 'group@g.us', participantJid: 'spammer@s.whatsapp.net' },
    ]);
  });

  it('a WhatsApp-side permission failure (bot not admin) surfaces as status failed, not a silent no-op', async () => {
    const s = sender();
    const m = moderation();
    m.deleteMessage = vi.fn(async () => {
      throw new Error('not authorized');
    });
    const result = await executeModerationAction(
      { type: 'DELETE_MESSAGE' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: true,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('failed');
  });

  it('NOTIFY_OWNER with no owners configured is skipped', async () => {
    const s = sender();
    const m = moderation();
    const result = await executeModerationAction(
      { type: 'NOTIFY_OWNER', message: 'spam detected' },
      {
        groupJid: 'group@g.us',
        sender: s,
        moderation: m,
        ownerJids: [],
        destructiveActionsEnabled: false,
        targetMessageKey: KEY,
        targetSenderJid: 'spammer@s.whatsapp.net',
      },
    );
    expect(result.status).toBe('skipped');
  });
});
