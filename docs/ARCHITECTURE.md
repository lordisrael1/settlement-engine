# Architecture

*The shape of the codebase, and why it has that shape.*

---

## The organizing principle: libraries vs. deployables

Before the individual pieces, notice the split between `packages/` and `apps/`. That
division is not cosmetic — it encodes the single most important idea in the whole layout.

A **package** (under `packages/`) is a **library**: a body of code that does something but
does not run on its own. It has no `main()` you start, no port it listens on. It exists to
be imported and used by something else. A library answers *"what capabilities do I offer?"*
and waits to be called.

An **app** (under `apps/`) is a **deployable**: a program with an entry point that you
actually start and that runs. It is a long-lived process with a `main`, it binds to a port,
it does work. An app answers *"I am a running thing you can deploy and talk to."*

So the first-principles reason for the whole structure: **you separate the code that thinks
(libraries) from the code that runs (the app)**, because the same thinking might be run in
many ways, and the way-it-runs should not contaminate the thinking. The ledger logic should
not know or care that it is being served over HTTP — that is the app's concern. Keeping them
apart means the ledger can be tested with no server, reused in a CLI or a different service
tomorrow, and reasoned about in isolation. This is the same boundary principle as the ingest
layer, applied to the shape of the codebase itself: contain each concern so the others stay
simple.

With that lens, here is each piece.

---

## `packages/canon` — the shared language

**Problem it solves.** Every other part of the system needs to speak about the same
things — a `Money` amount, a `SettlementLine`, a `LedgerTransaction`. If each package
defined its own version of "a settlement line," they would drift, disagree, and you would
spend your life writing translation code between your own modules. There must be exactly
one definition of each domain concept, in one place, that everyone imports.

**What it is.** The dictionary. Pure type definitions and the enums/constants that go with
them — `Money`, `CanonicalPayment`, `SettlementLine`, `Account`, `Entry`,
`LedgerTransaction`, the reason codes. Almost no behaviour; just the vocabulary.

**Its place in the dependency graph.** It sits at the bottom. It depends on nothing internal.
Everything depends on it. That is the signature of a well-designed shared-types package:
a leaf that everyone points to, so a change to the canonical language is made once and
propagates everywhere. This is `packages/canon` enforcing **Law 7** at the level of code
structure — there is literally one place the language lives.

## `packages/ledger-core` — the engine that is correct about money

**Problem it solves.** The double-entry rules — balance-zero, append-only, integer kobo,
reversal-not-mutation, balance-as-derived — must live somewhere pure, testable, and unaware
of the outside world. If this logic were tangled into the web server, you could not test it
without spinning up HTTP, and you would be tempted to let a request handler bypass a Law
"just once."

**What it is.** The heart from Phase 1: `postTransaction()` with the atomic balance-zero
assertion, `balance()`, `reverse()`, the transaction lifecycle. It knows accounts and
entries and invariants. It knows nothing about Paystack, HTTP, or files.

**Its place in the graph.** Depends on `canon` (to speak the language) and on the Postgres
client (its store). Nothing about sources or protocols. It is imported by `reconciler`
(which posts settlement transactions through it) and by `api` (which posts authorized
transactions through it). **Because it is the only path to writing money, no other layer
can violate Law 1** — they must go through the engine.

## `packages/ingest` — the anti-corruption boundary

**Problem it solves.** The outside world is impure and various — five amount conventions,
four signature schemes, CSVs, JSON, fixed-width bank files. That variety must be quarantined
at the edge and converted, once, into `canon` types, so the core never sees a foreign shape
(Law 7 again, this time as behaviour).

**What it is.** The two-halves ingest layer from Phase 2, and it is *thin*. The bible
assumed the settlement half would be entirely new work; reading `@pay-normalize/core`
showed its `Connector` interface already includes `parseSettlementFile`, and that
Flutterwave, Nomba and Monnify ship working parsers. So both halves stand on the library:
signature verification, kobo conversion, timezone rules, status ordering and row-isolated
parsing are all upstream.

What this package genuinely adds is the last translation into our language, and the two
facts a deliberately stateless normalisation library will never have: **an expected
settlement window** and **an expected fee**, declared per source as data. Those two are
what reconciliation actually runs on. See [DECISIONS.md § D-012](DECISIONS.md).

**Its place in the graph.** Depends on `canon` (its output language) and on `pay-normalize`.
Notably it does **not** depend on `ledger-core` — ingest's job ends when it has produced a
clean canonical event; something else decides what to do with it. It is imported by `api`
(which receives the raw bytes and hands them to ingest), and its output feeds `reconciler`
and `ledger-core`.

## `packages/reconciler` — the engine that explains the difference

**Problem it solves.** The promise (ledger) and the money (settlement lines) diverge, and
every divergence must be either automatically explained or escalated. That matching logic —
the tiered pipeline, the fee-aware and batch matching, the timing-aware deferral, the
exception state machine — is its own distinct concern and deserves its own home.

**What it is.** Phases 3 and 4, in **two stages**, because money moves in two steps.
`allocate()` matches authorized ledger transactions to the payouts a PSP says it is sending,
names every deduction, and **books nothing** — a settlement report is a claim by an
interested party, not cash. `confirm()` matches an independent bank credit to that payout,
and is the only thing in the system that **writes a ledger transaction through
`ledger-core`**: cash to `bank_account`, each named deduction to its own account, and the
receivable closed. So it is where reconciliation feeds back into the ledger — but only on
the evidence that justifies it.

**Its place in the graph.** Depends on `canon` (the language) and `ledger-core` (to post the
transactions it discovers), and reads the ingest output. It is pure domain logic —
deterministic, no HTTP. Imported by `api`, which triggers reconciliation runs.

**The edge that is deliberately absent** is `reconciler → ingest`. The matcher needs to know
each source's business calendar and fee contracts, and it would be easy to let it look them
up. It must not: the moment it can reach a source table, it can branch on a source name
(Law 7). Instead both arrive as a `SourcePolicy` handed in, and the *deployable* joins
ingest's calendars to the contracts in the database. That is what `apps/pipeline/src/policy.ts`
is, and it is the whole of it — the conductor wiring two sections together, owning no logic.

## `apps/api` — the one thing that actually runs

**Problem it solves.** All of the above are libraries that cannot run by themselves.
Something has to be a live, long-lived process: bind a port, accept HTTP, receive webhooks,
expose balances and exceptions, kick off reconciliation runs — and wire the libraries
together. That is the app.

**What it is.** Phase 6: the Fastify service. Its job is deliberately thin — own the
transport and the contract (HTTP, auth, signature verification, status codes), then delegate
all thinking to the packages. An inbound webhook: the API verifies it is authentic
(transport concern), hands the raw payload to `ingest` (meaning concern), and the resulting
canonical event goes to `ledger-core`. A settlement upload: the API receives the file,
`ingest` normalises it, `reconciler` matches it. **The API is the conductor; the packages
are the orchestra.** It contains no business logic itself — if you find a Law being enforced
in `apps/api`, it is in the wrong place.

**Its place in the graph.** It sits at the top: it depends on all the packages; nothing
depends on it. That *"depends on everything, depended on by nothing"* shape is the signature
of a deployable — and it is exactly why the app, and only the app, is what you containerise.

---

## `apps/pipeline` — the deployable that exists today

Phase 6's Fastify service is not built yet, and Phase 7 needs a program to containerise.
`apps/pipeline` is that program: a CLI over the same libraries — `migrate`, `demo`,
`balances`, `verify`, `ingest-settlement`.

It occupies exactly the position `apps/api` will occupy, and obeys the same rule: it owns
no business logic, only transport and dispatch. When the service arrives it *joins* this
one rather than replacing it — a service and a CLI over one set of libraries is precisely
the reuse the library/deployable split exists to allow, and nothing under `packages/`
changes when it lands. See [DECISIONS.md § D-022](DECISIONS.md).

---

## The dependency graph

Dependencies only ever point downward toward `canon`. No cycles.

```
       apps/pipeline (today)          apps/api (Phase 6)     ← deployables; nothing
              \                        /   |    \    \          depends on them
               \                      /    |     \    \
                \   packages/reconciler    |      \    \       (Phase 3)
                 \      |    \             |       \    \
                  \     |     \            |        \    \
          packages/ledger-core  \          |    packages/ingest  →  @pay-normalize/*
                       \         \         |        /
                        \         \        |       /
                         \         \       |      /
                              packages/canon               ← the leaf; depends on nothing
```

Read as edges (`A → B` means "A imports B"):

| From | Imports |
|---|---|
| `apps/pipeline`, `apps/api` | `canon`, `ledger-core`, `ingest`, `reconciler` |
| `reconciler` | `canon`, `ledger-core` |
| `ingest` | `canon`, `@pay-normalize/*` |
| `ledger-core` | `canon`, `pg` |
| `canon` | *(nothing)* |

That acyclic, one-directional shape is what makes the system reasoned-about and testable —
and it is the thing a senior reviewer checks first.

Two edges are deliberately **absent**, and their absence is load-bearing:

- `ingest` does **not** import `ledger-core`. Ingest produces canonical events; deciding
  what to do with them is someone else's job. This is what keeps ingest a pure translator.
- `ledger-core` does **not** import `ingest`. The ledger must be provable in complete
  isolation from where its inputs came from — that is Law 7 expressed as a missing arrow.

---

## How this becomes a containerised backend service

Here is the key realisation that ties it together. **You do not containerise the packages.
You containerise the app** — and the packages come along for the ride because the app
depends on them.

Think back to what a container is from first principles: a sealed unit holding the program
plus its entire world so it runs identically anywhere. For this system, "the program" is
`apps/api` — the only runnable thing. And "its entire world" includes everything it needs
to run: the right Node version, its external npm dependencies (Fastify, the Postgres
client), and its internal dependencies — `canon`, `ledger-core`, `ingest`, `reconciler`.
From the app's point of view, the internal packages are just dependencies, no different in
kind from Fastify. The only difference is where they come from: Fastify is downloaded from
the npm registry; these live in the same repo. Both must end up inside the image.

So the container-building process, concretely, in a monorepo:

1. **Start from a base image that provides the OS and runtime.** `FROM node:20` gives you
   Linux plus the correct Node version — the foundation of the app's world, frozen.
2. **Bring the workspace in and install dependencies.** Because this is a monorepo with
   npm workspaces, the build copies the workspace manifest and the packages, and runs an
   install that resolves both the external npm deps and links the internal packages
   together. This is the step where `apps/api`'s import of `ledger-core` gets satisfied from
   the local `packages/` folder rather than the registry.
3. **Build / compile.** TypeScript across the packages and the app is compiled to
   JavaScript. The internal packages are built first (they are dependencies), then the app
   that imports them. The output is a runnable JS build of the app with all its internal
   package code included — because you cannot run `apps/api` without the `ledger-core` code
   it calls, that code is now baked in.
4. **Declare how to run.** The Dockerfile sets the start command —
   `node apps/pipeline/dist/main.js demo` today, and the Fastify service in Phase 6, at
   which point it also exposes the port. This is the line that decides what the image
   *is*; everything above it is the same either way.
5. **`docker build` freezes all of that into an image** — the sealed artifact. Not an
   `.exe`: an image containing Linux + Node + the app + all four packages' compiled code +
   external deps, sealed together.
6. **The database is a separate container.** The service needs Postgres, but Postgres is not
   part of the app — it is its own program with its own world. So it gets its own container
   (from the official `postgres` image), and `docker-compose.yml` describes both containers
   as one system, wired together (the app gets the DB's address via an environment
   variable). `docker compose up` starts both and connects them.

That is the containerised backend service: `docker compose up` launches the Fastify
`apps/api` container — carrying `canon`, `ledger-core`, `ingest`, and `reconciler` compiled
inside it — alongside a Postgres container, wired together, running identically on a laptop
or on AWS. **The packages made the code correct and separable; the app made it runnable;
the container made it reproducible anywhere.**

One clean way to hold the whole thing: *the packages are the organs, the app is the body
that runs on them, and the container is the sealed environment the body lives in — you ship
the body (with its organs inside), not each organ separately.*

This is Phase 7. Nothing about it should require changing a single line inside the packages,
and if it does, the layering above was wrong.
