import { describe, expect, it, vi } from 'vitest';
import { executeAction, type MessageSender } from './actionEngine';

function fakeSender(impl?: (jid: string, text: string) => Promise<void>): MessageSender {
  return { sendTextMessage: vi.fn(impl ?? (async () => {})) };
}

describe('executeAction', () => {
  it('LOG_ONLY never sends a WhatsApp message', async () => {
    const sender = fakeSender();
    const result = await executeAction(
      { type: 'LOG_ONLY' },
      { groupJid: 'g@g.us', sender, ownerJids: [] },
    );
    expect(result.status).toBe('success');
    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });

  it('SEND_MESSAGE sends the configured text to the group JID', async () => {
    const sender = fakeSender();
    const result = await executeAction(
      { type: 'SEND_MESSAGE', message: 'Thanks everyone!' },
      { groupJid: 'g@g.us', sender, ownerJids: [] },
    );
    expect(result.status).toBe('success');
    expect(sender.sendTextMessage).toHaveBeenCalledWith('g@g.us', 'Thanks everyone!');
    expect(sender.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('SEND_MESSAGE reports failure (without throwing) if sending fails', async () => {
    const sender = fakeSender(async () => {
      throw new Error('socket not connected');
    });
    const result = await executeAction(
      { type: 'SEND_MESSAGE', message: 'Hi' },
      { groupJid: 'g@g.us', sender, ownerJids: [] },
    );
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/socket not connected/);
  });

  it('NOTIFY_OWNER sends to every configured owner JID, not the group', async () => {
    const sender = fakeSender();
    const result = await executeAction(
      { type: 'NOTIFY_OWNER', message: 'Rule fired' },
      { groupJid: 'g@g.us', sender, ownerJids: ['owner1@s.whatsapp.net', 'owner2@s.whatsapp.net'] },
    );
    expect(result.status).toBe('success');
    expect(sender.sendTextMessage).toHaveBeenCalledWith('owner1@s.whatsapp.net', 'Rule fired');
    expect(sender.sendTextMessage).toHaveBeenCalledWith('owner2@s.whatsapp.net', 'Rule fired');
    expect(sender.sendTextMessage).not.toHaveBeenCalledWith('g@g.us', expect.anything());
  });

  it('NOTIFY_OWNER is skipped (not failed) when no owners are configured', async () => {
    const sender = fakeSender();
    const result = await executeAction(
      { type: 'NOTIFY_OWNER', message: 'Rule fired' },
      { groupJid: 'g@g.us', sender, ownerJids: [] },
    );
    expect(result.status).toBe('skipped');
    expect(sender.sendTextMessage).not.toHaveBeenCalled();
  });
});
