import { Result } from 'effect';
import { userId, type UserId } from './bytes';
import { ValidationError } from './errors';

// Frozen with ledger v1. Every shipped ledger stores account IDs in this layout.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const USER_ID_BYTES = 32;
const PAYLOAD_BITS = (USER_ID_BYTES - 1) * 8;
const MAX_CHARACTERS = Math.floor(PAYLOAD_BITS / 5);

const refused = () => Result.fail(new ValidationError({ code: 'canonical' }));

/**
 * Encode an account ID as the ledger's 32-byte user ID, reversibly.
 *
 * Byte 0 is the character count, 1 to 49. The characters of the lowercase Crockford
 * base32 alphabet follow as 5-bit values, most significant bit first, and every
 * remaining bit is zero. Other input is refused, never normalized. The result names
 * an account and proves nothing about who holds a signing key.
 */
export function accountUserId(accountId: string): Result.Result<UserId, ValidationError> {
  const count = accountId.length;
  if (count < 1 || count > MAX_CHARACTERS) return refused();
  const bytes = new Uint8Array(USER_ID_BYTES);
  bytes[0] = count;
  for (let index = 0; index < count; index += 1) {
    const value = ALPHABET.indexOf(accountId[index]!);
    if (value < 0) return refused();
    const bit = index * 5;
    const byte = 1 + (bit >> 3);
    const shifted = value << (11 - (bit & 7));
    bytes[byte] = bytes[byte]! | (shifted >> 8);
    if (byte + 1 < USER_ID_BYTES) bytes[byte + 1] = shifted & 0xff;
  }
  return userId(bytes);
}

/** The account ID a user ID encodes; bytes `accountUserId` cannot produce are refused. */
export function accountIdFromUserId(id: UserId): Result.Result<string, ValidationError> {
  const bytes = id.toBytes();
  const count = bytes[0]!;
  if (count < 1 || count > MAX_CHARACTERS) return refused();
  let accountId = '';
  for (let index = 0; index < count; index += 1) {
    const bit = index * 5;
    const byte = 1 + (bit >> 3);
    const word = (bytes[byte]! << 8) | (bytes[byte + 1] ?? 0);
    accountId += ALPHABET[(word >> (11 - (bit & 7))) & 31]!;
  }
  const expected = accountUserId(accountId);
  return Result.isSuccess(expected) && expected.success.equals(id)
    ? Result.succeed(accountId)
    : refused();
}
