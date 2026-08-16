-- The rail a payment arrived on, recorded beside the transaction that promised it.
--
-- Why the ledger and not a side table: the fee a promise is expected to attract depends on
-- its channel, and fee contracts are now scoped by channel (0003). A matcher that has to go
-- looking elsewhere for the channel will eventually stop looking and assume card — which is
-- exactly the silent, permanent fee variance on every transfer that channel-scoped pricing
-- exists to prevent.
--
-- It is descriptive metadata about the causing event, which is the same thing `source` and
-- `reference` already are. No entry, balance or invariant depends on it.
--
-- On the number: migrations are applied in filename order across every package, so the
-- numbers are one global sequence rather than one per package. The reconciler took 0002 and
-- 0003, so the ledger's second migration is 0004.

ALTER TABLE ledger_transactions
  ADD COLUMN channel TEXT;

COMMENT ON COLUMN ledger_transactions.channel IS
  'card | bank_transfer | ussd | qr | wallet | pos | unknown. NULL for transactions that '
  'are not about a single payment: a settlement booking covering a batch, an adjustment.';

-- Rows written before this column existed genuinely do not know their channel, and
-- backfilling them with a guess would put a fabricated fact into an append-only table.
-- NULL is the honest value and the fee model already treats an unknown channel as one it
-- can only price from a blended contract.
