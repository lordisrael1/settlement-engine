/**
 * @recon/protect — the data-protection boundary.
 *
 * Three jobs, and they are the three answers to "what happens to a stranger's bytes here":
 *
 *   refuse    card data never enters                          `refuseCardData`
 *   reduce    keep the fields the matcher reads, drop the rest `redact`
 *   protect   what is kept is encrypted, per record            `seal` / `unseal`
 *
 * It exists as a package rather than as a file in `apps/api` because all three are needed
 * in four places — the webhook rail, the upload rails, the inbox drain and the retention
 * command — and a control implemented four times is three chances to implement it slightly
 * differently.
 *
 * Note what is absent: a database, a clock, and any knowledge of payments. This package
 * takes bytes and gives back bytes or a verdict. Which table the result goes in is the
 * reconciler's business, when it is redacted is the retention schedule's, and whether a
 * principal may see it is the API's.
 */

export {
  CardDataRefused,
  looksLikeCardNumber,
  luhn,
  refuseCardData,
  scanForCardData,
  type CardDataFinding,
} from './scan.js';

export { redact, REDACTION_VERSION, type Redaction } from './redact.js';

export {
  DecryptionFailed,
  equalBytes,
  freshKey,
  localKeyRing,
  openWithKey,
  parseLocalKey,
  seal,
  sealWithKey,
  unseal,
  type EncryptionContext,
  type KeyRing,
  type LocalKey,
  type Sealed,
  type SealedBytes,
} from './envelope.js';

export {
  keyRingFromEnv,
  retentionFromEnv,
  ProtectionConfigurationError,
} from './config.js';
