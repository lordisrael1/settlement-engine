# 27. Reconciliation is three-way: webhook, PSP report, bank statement

Date: 2026-08-16

## Status

Accepted

## Context

A settlement report is a party with an interest in the answer describing its own future
behaviour. Treating it as cash makes four ordinary events invisible: a payout reported and
never sent, one the bank returns days later, one credited short of a correspondent-bank
charge, and one credited twice.

## Decision

The webhook, the PSP's settlement report and the bank statement are three independent
records. Only bank evidence may increase `bank_account`. A PSP report is recorded as a
`Payout` with status `reported`, matched to the payments it covers, and books nothing.

## Consequences

- The earlier design booked `bank_account +net / fees_expense +fee / psp_receivable -gross`
  the moment a settlement line matched a promise. It is gone; `bookSettlement` no longer
  exists and `bookBankConfirmedSettlement` replaces it.
- The reported-but-not-received state is a reconciliation fact with a lifecycle, held in
  `expected_inflows` where it carries a value date, a source and an evidence id.
- A `psp_payout_expected` clearing account was rejected: it would put a second, weaker copy
  of that state in the books.
