# Expense capture

Expenses captured from WhatsApp groups, one project at a time. Built for small
businesses in South India: contractors and shop owners who already share bills
in a group and should never have to type one in.

Design: **[docs/p0-tech-design.md](docs/p0-tech-design.md)**. Read it before
changing an architectural choice — most of them have a reason written down.

## Layout

| Path | What |
|---|---|
| `bot/` | Always-on Node process: WhatsApp → extract → store. All the decisions live in `src/pipeline.ts` |
| `web/` | Next.js owner app: projects, expenses, the review queue |
| `supabase/` | Schema, row-level security, and the tests that prove it |

## Running it

```bash
pnpm install
supabase start            # local Postgres, auth and studio
supabase test db          # 15 tenant-isolation assertions
pnpm --filter bot test    # 23 pipeline tests, no credentials needed
pnpm dev:web              # http://localhost:3100
```

Copy `.env.example` to `.env.local` (web) and `.env` (bot). Neither the bot nor
the web app needs a WhatsApp pairing or a Gemini key to run:

```bash
pnpm --filter bot smoke   # drives the real pipeline with a stub extractor
```

## Three things to know before pointing this at a customer

**Gemini's free tier trains on what you send it**, including human review. That
would be photographs of customers' bills. Use a paid key first —
`docs/p0-tech-design.md` §2.3.

**Baileys is unofficial and the number can be banned.** Use a dedicated SIM
that is nobody's personal number and treat the session as disposable — §2.2.

**The bot holds the service-role key and bypasses row-level security.** Every
write it makes is scoped by an `ownerId` resolved from the group mapping, never
from anything in the message. That check in `pipeline.ts` is the only thing
keeping one customer's bills out of another's project, and it has a test.

## Conventions

- Money is integer paise on `bigint`. Never a float, never `parseFloat`.
  `Intl.NumberFormat` is the one place a number may appear, at render.
- Row-level security is the authorization model. The UI hides; the database
  refuses. A check that exists only in React is a convenience.
- The original bill is the source of truth. Extracted fields are a convenience
  layer, and anything the model was unsure of goes to review rather than into
  the ledger.
