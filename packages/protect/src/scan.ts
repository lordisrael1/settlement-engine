/**
 * The guard that makes "we do not store card numbers" an invariant instead of a claim.
 *
 * Today the payloads this system receives carry a truncated PAN at worst — a BIN and a
 * last four, which is the maximum PCI DSS allows to be displayed and is not a card number.
 * That is a fact about the providers we have adapters for and the payload shapes they send
 * *this month*. It is not a property of the system, and the difference matters: a new
 * adapter, a provider adding a field, or an operator uploading the wrong export are each
 * one afternoon away, and each of them would put a full PAN into a table nobody thought
 * needed to be in PCI scope.
 *
 * So the claim is enforced at the door rather than asserted in a document. A delivery or an
 * upload carrying something that looks like a card number, or a field named as sensitive
 * authentication data, is refused before it is written down — the same move the ledger
 * makes when it refuses an unbalanced transaction inside the transaction that writes it.
 *
 * What this deliberately does *not* do is redact and continue. A payload with a PAN in it
 * is a bug in a provider adapter or a mistake by an operator, and quietly cleaning it up
 * would hide both while leaving the bytes in a log, a proxy buffer and a crash report
 * somewhere upstream. Refusing is loud, and loud is correct here.
 */

/**
 * A field name that carries sensitive authentication data, which may never be stored after
 * authorization — not encrypted, not truncated, not "temporarily".
 *
 * Matched against JSON *keys*, normalised, rather than against the text of the payload. A
 * substring search for `pin` matches `shipping`, and a guard that fires on the word
 * "shipping" is a guard somebody will switch off.
 */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'cav2',
  'csc',
  'securitycode',
  'cardsecuritycode',
  'pin',
  'pinblock',
  'encryptedpin',
  'track1',
  'track2',
  'trackdata',
  'track2data',
  'magneticstripe',
  'servicecode',
  'fullpan',
  'pan',
  'cardnumber',
  'cardno',
]);

/**
 * What a real card number looks like: an issuer prefix *and* a length that scheme issues.
 *
 * Luhn alone is a one-in-ten filter — roughly one arbitrary sixteen-digit identifier in ten
 * passes it — and a guard that refuses one upload in ten for no reason is a guard that gets
 * switched off within a week. The prefix narrows it; the length narrows it again, and the
 * pair is what keeps an ordinary settlement id out. A seventeen-digit batch reference
 * beginning `300` passes Luhn and matches the Diners prefix, and is not a card, because
 * Diners issues fourteen digits and nothing else.
 *
 * Every scheme that reaches a Nigerian acquirer is here, Verve (506099…, 6500…) included.
 */
const CARD_SHAPES: readonly { readonly prefix: RegExp; readonly lengths: readonly number[] }[] = [
  { prefix: /^4/, lengths: [13, 16, 19] }, // Visa
  { prefix: /^5[1-5]/, lengths: [16] }, // Mastercard
  { prefix: /^2(2[2-9][1-9]|[3-6][0-9]{2}|7[01][0-9]|720)/, lengths: [16] }, // Mastercard 2-series
  { prefix: /^3[47]/, lengths: [15] }, // American Express
  { prefix: /^3(0[0-5]|[689])/, lengths: [14] }, // Diners
  { prefix: /^(6011|64[4-9]|65)/, lengths: [16, 19] }, // Discover, and Verve's 6500 range
  { prefix: /^50[6-9]/, lengths: [16, 18, 19] }, // Verve and the other national schemes
  { prefix: /^62/, lengths: [16, 17, 18, 19] }, // UnionPay
];

/**
 * Digit runs long enough to be a card number, allowing the single spaces and hyphens a
 * human or a CSV puts between groups. Bounded by non-digits so a thirteen-digit slice of a
 * twenty-digit identifier is not read as a PAN.
 */
const DIGIT_RUN = /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/g;

export interface CardDataFinding {
  /** `pan` — digits that pass Luhn under a real issuer prefix. `sad` — a forbidden field name. */
  readonly kind: 'pan' | 'sad';
  /** Where it was found: a JSON path, or `body` for bytes that are not JSON. */
  readonly at: string;
  /**
   * Enough to act on and not enough to leak.
   *
   * A finding travels into an error message, a log line and an alert, so it carries the
   * field name or a masked form — never the digits. A guard against storing card numbers
   * that writes the card number to the application log has moved the problem, not solved it.
   */
  readonly detail: string;
}

/** The Luhn check digit. Every real card number satisfies it; most other digit runs do not. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;

    const contribution = double ? (value * 2 > 9 ? value * 2 - 9 : value * 2) : value;
    sum += contribution;
    double = !double;
  }

  return sum % 10 === 0;
}

/** Digits that look like a real card number: a scheme's prefix, a scheme's length, Luhn-valid. */
export function looksLikeCardNumber(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;

  const shaped = CARD_SHAPES.some(
    (shape) => shape.prefix.test(digits) && shape.lengths.includes(digits.length),
  );
  return shaped && luhn(digits);
}

/** First six and last four — the most PCI DSS allows to be displayed, and all a finding says. */
function mask(digits: string): string {
  return `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`;
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Does this payload contain a card number or sensitive authentication data?
 *
 * Two passes, because the bytes arriving here are not always JSON — a bank statement is a
 * CSV, and a payload we cannot parse is exactly the one worth being suspicious of. The
 * structural pass names offending fields precisely; the text pass catches digits wherever
 * they are, including inside a string a parser would hand back as an opaque value.
 *
 * Returns the first finding rather than all of them. One is enough to refuse, and
 * enumerating every occurrence produces a longer list of the thing we are trying not to
 * hold.
 */
export function scanForCardData(bytes: Buffer): CardDataFinding | null {
  const text = bytes.toString('utf8');

  const parsed = tryParse(text);
  if (parsed !== undefined) {
    const structural = walk(parsed, '$');
    if (structural) return structural;
  }

  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (looksLikeCardNumber(digits)) {
      return {
        kind: 'pan',
        at: parsed === undefined ? 'body' : '$',
        detail: `a Luhn-valid card number (${mask(digits)}) appears in the payload`,
      };
    }
  }

  return null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function walk(value: unknown, path: string): CardDataFinding | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = walk(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const here = `${path}.${key}`;

      if (SENSITIVE_FIELDS.has(normaliseKey(key))) {
        // Named, not inspected. A field called `cvv` is refused whether or not it holds
        // anything today: the shape is the problem, and an empty one fills up later.
        return {
          kind: 'sad',
          at: here,
          detail:
            `"${key}" is sensitive authentication data, which may never be stored after ` +
            `authorization — not encrypted, not truncated, not briefly`,
        };
      }

      const found = walk(item, here);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const digits = String(value).replace(/[ -]/g, '');
    if (/^[0-9]+$/.test(digits) && looksLikeCardNumber(digits)) {
      return {
        kind: 'pan',
        at: path,
        detail: `${path} holds a Luhn-valid card number (${mask(digits)})`,
      };
    }
  }

  return null;
}

/**
 * Refused because it carried card data.
 *
 * A named error rather than a boolean, so the transport layer can answer 422 and say why,
 * and so nothing downstream mistakes it for a parse failure and retries it. The bytes were
 * not stored, and the message says so — an operator whose upload is refused needs to know
 * whether they must now go and delete something.
 */
export class CardDataRefused extends Error {
  readonly finding: CardDataFinding;

  constructor(finding: CardDataFinding, what: string) {
    super(
      `${what} was refused and nothing was stored: ${finding.detail}. This system holds ` +
        `tokens and approved truncations only — a BIN and a last four are not a card ` +
        `number, and a card number is not something it may keep (ADR-0066). Fix the ` +
        `payload at its source; do not re-send it.`,
    );
    this.name = 'CardDataRefused';
    this.finding = finding;
  }
}

/** Scan, and throw if there is anything to find. The form the request path uses. */
export function refuseCardData(bytes: Buffer, what: string): void {
  const finding = scanForCardData(bytes);
  if (finding) throw new CardDataRefused(finding, what);
}
