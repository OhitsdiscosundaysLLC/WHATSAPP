import qrcodeTerminal from 'qrcode-terminal';
import type { Logger } from 'pino';

/**
 * Renders a WhatsApp linking QR code to the terminal for local development.
 *
 * The raw QR string is intentionally never passed to the structured
 * (pino/JSON) logger — only the rendered ASCII art goes to stdout via
 * `console.log`, and only a human-readable notice (no QR data) goes through
 * `logger`. QR values are short-lived authentication material: this
 * function does not persist them anywhere.
 */
export function displayQr(qr: string, logger: Logger): void {
  logger.info('New WhatsApp QR code generated — scan it now (it expires in ~20s).');
  logger.info('WhatsApp > Settings > Linked Devices > Link a Device');

  qrcodeTerminal.generate(qr, { small: true }, (ascii) => {
    // Intentional: human-facing terminal rendering, not a structured log record.
    console.log(ascii);
  });
}
