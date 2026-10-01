import { config } from '../config/config';
import { createChildLogger } from '../services/logger';
import { FileAuthStateProvider } from './auth/fileAuthStateProvider';
import { WhatsAppConnectionManager } from './connectionManager';
import type { WhatsAppStatus } from './types';

const log = createChildLogger('whatsapp');

const authProvider = new FileAuthStateProvider(config.whatsapp.authDir);

export const whatsappConnectionManager = new WhatsAppConnectionManager({
  authProvider,
  logger: log,
  reconnect: {
    baseMs: config.whatsapp.reconnectBaseMs,
    maxMs: config.whatsapp.reconnectMaxMs,
  },
});

/** Starts the connection unless disabled via WHATSAPP_ENABLED=false. Never throws. */
export async function startWhatsApp(): Promise<void> {
  if (!config.whatsapp.enabled) {
    log.info('WhatsApp integration disabled (WHATSAPP_ENABLED=false); skipping connection');
    return;
  }

  try {
    await whatsappConnectionManager.start();
  } catch (err) {
    // start() already catches internally and sets state 'error', but guard
    // here too so a bug can never take the HTTP server down with it.
    log.error({ err }, 'Unexpected error starting WhatsApp connection');
  }
}

export async function stopWhatsApp(): Promise<void> {
  await whatsappConnectionManager.shutdown();
}

export function getWhatsAppStatus(): WhatsAppStatus {
  return whatsappConnectionManager.getStatus();
}
