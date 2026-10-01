import { proto, type SignalDataTypeMap } from '@whiskeysockets/baileys';

/**
 * The one piece of Baileys auth-state serialization that isn't just
 * generic `BufferJSON` round-tripping (see `src/db/encryption.ts`'s
 * `encryptJson`/`decryptJson`, which take `BufferJSON.replacer`/`.reviver`
 * directly as their replacer/reviver).
 *
 * Verified against the installed @whiskeysockets/baileys 6.7.24 source
 * (`lib/Utils/use-multi-file-auth-state.js`): every signal key category
 * round-trips through `JSON.stringify`/`JSON.parse` with `BufferJSON` and
 * needs nothing else — except `app-state-sync-key`, which Baileys
 * additionally reconstructs via
 * `proto.Message.AppStateSyncKeyData.fromObject(value)` after the generic
 * JSON round-trip. A plain parsed object isn't sufficient for how that
 * value gets used downstream. This function applies that exact same
 * fixup, and only for that one category — not invented, mirrored.
 */
export function reviveSignalKeyValue<T extends keyof SignalDataTypeMap>(
  category: T,
  value: unknown,
): SignalDataTypeMap[T] {
  if (category === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value) as unknown as SignalDataTypeMap[T];
  }
  return value as SignalDataTypeMap[T];
}
