# DayBook

Payments matched to invoices, straight out of WhatsApp.

Small businesses in South India already run their accounts in a group: invoices
go out, UPI payment screenshots come back, in no particular order. Working out
who has paid means scrolling weeks of chat and retyping amounts into Excel. A bot
sits in the group the business already uses, reads both kinds of document, and
pairs them up. Nothing about how the business works has to change.

**The review experience is the product.** Automated matching will never be
perfect — fuzzy names, partial payments, split invoices — so the moment that
decides whether this is useful is the weekly session where the owner clears the
exceptions. If that is slow, they are back to doing it by hand with software in
the way.

Design: **[docs/p0-tech-design.md](docs/p0-tech-design.md)**. Read it before
changing an architectural choice — most of them have a reason written down, and
several were arrived at by getting it wrong first.

## Layout

| Path | What |
|---|---|
| `bot/` | Always-on Node process: WhatsApp → classify + extract → invoice or payment → ask the matcher. All the decisions live in `src/pipeline.ts` |
| `web/` | Next.js owner app: the review session, outstanding balances, cash flow, payments |
| `supabase/` | Schema, the matcher, row-level security, and the tests that prove all three |

The matcher is **SQL, not TypeScript** (`match_candidates` in the migration).
The review screen needs the same ranking the bot used, live, for its shortlist;
two implementations of a money-matching rule would drift apart within a month.

## Running it

```bash
pnpm install
supabase start            # local Postgres, auth and studio
supabase db reset         # apply migrations
supabase test db          # 61 assertions: tenant isolation, invariants, matching
pnpm --filter bot test    # 33 pipeline tests, no credentials needed
pnpm dev:web              # http://localhost:3100
```

Copy `.env.example` to `.env.local` (web) and `.env` (bot). Neither needs a
WhatsApp pairing or a Gemini key to exercise the whole path:

```bash
pnpm --filter bot smoke   # real pipeline, real database, stub extractor
pnpm --filter bot groups  # the WhatsApp groups the paired number can see
pnpm --filter bot purge --dry-run   # what retention would delete
```

**Schedule the purge.** Originals are deleted 90 days after capture and raw
messages after 30; `pnpm --filter bot purge` is what does it, and nothing calls it
for you. Until it is on a daily timer, retention is a comment rather than a
policy.

The smoke run posts an invoice, a matching payment and a line of chatter. If it
ends with one proposal in the review queue, everything works. It needs a linked
group first — add one in the web app's Settings, or pass `SMOKE_GROUP_ID`.

To see which groups the paired number is actually in, and their ids:

```bash
pnpm --filter bot groups
```

For the first run against a real WhatsApp group and a real Gemini key, follow
**[docs/FIRST-LIVE-RUN.md](docs/FIRST-LIVE-RUN.md)** — including the part about
what each way of failing tells you, which is most of the value of doing it.

## Four things to know before pointing this at a customer

**Gemini's free tier trains on what you send it**, including human review. Under
this product that is the business's *customers'* names, UPI handles and
transaction references — third-party personal data, which makes the business a
data fiduciary for it under the DPDP Act. Paid key first; §2.3.

**Baileys is unofficial and the number can be banned.** Use a dedicated SIM that
is nobody's personal number, and treat the session as something you will have to
re-establish rather than as infrastructure — §2.2.

**The bot holds the service-role key and bypasses row-level security.** Every
write it makes is scoped by an `ownerId` resolved from the group mapping, never
from anything in the message. That is the only thing keeping one business's books
out of another's, and it has a test.

**Storage runway is about three weeks**, not seven months: Supabase Storage's
1 GB rather than R2's 10 GB, which is the price of having no server. Decide at
70% full — §5.

## Conventions

- Money is integer paise on `bigint`. Never a float, never `parseFloat`.
  `Intl.NumberFormat` is the one place a number may appear, at render.
- Row-level security is the authorization model. The UI hides; the database
  refuses. A check that exists only in React is a convenience.
- **Balances are derived, never stored.** An invoice's balance is its amount
  minus its accepted allocations, computed in a view. A stored total is a second
  source of truth that drifts the first time anything is edited or undone.
- **Every threshold in the matcher is a veto, not a vote.** A candidate must
  clear score, uniqueness, full settlement and date order independently. A
  weighted sum that lets two strong signals outvote a disqualifying one is how a
  matcher ends up confidently wrong.
- **Nothing is applied silently.** The matcher writes *proposals*; only the owner
  moves a balance. Undo is server state, so it survives a refresh.
- The original document is the source of truth. Extracted fields are a
  convenience layer over it, and anything unreadable waits for a human rather
  than entering the ledger.

## Housekeeping

One manual step is outstanding from the rename of the storage bucket: the empty
`bills` bucket still exists in the Supabase project, with its policies dropped so
nothing can read it. Supabase refuses a direct delete from `storage.buckets`, so
remove it from the dashboard when convenient. New files go to `documents`.
