import pino, { type LoggerOptions } from 'pino';
import { config } from '../config/config';

/**
 * Structured application logger. Never pass raw config/secret objects to
 * this logger — log selective, non-sensitive fields only (see docs/SECURITY.md).
 */
const options: LoggerOptions = {
  level: config.logLevel,
  redact: {
    paths: [
      '*.apiKey',
      '*.serviceRoleKey',
      '*.password',
      '*.adminPassword',
      '*.token',
      '*.csrfToken',
      '*.sessionId',
      '*.pairingCode',
      '*.encryptionKey',
      '*.authEncryptionKey',
      '*.ciphertext',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.cookies',
      // WhatsApp (Baileys) auth material — defense in depth. Application
      // code never intentionally logs these objects, but Baileys' own
      // internal logging (it uses the logger we pass it) could include
      // them as a bound field, so they're redacted here too.
      'creds',
      'authState',
      'keys',
      'qr',
      '*.creds',
      '*.authState',
      '*.keys',
      '*.qr',
      'authState.creds',
      'authState.keys',
    ],
    censor: '[REDACTED]',
  },
  base: {
    env: config.env,
  },
};

if (config.env === 'development') {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  };
}

export const logger = pino(options);

export function createChildLogger(scope: string) {
  return logger.child({ scope });
}
