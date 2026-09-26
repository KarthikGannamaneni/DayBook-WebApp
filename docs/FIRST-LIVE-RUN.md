# The first live run

Getting one real invoice and one real payment screenshot out of a WhatsApp group
and into the review queue. This is milestone 5 in the design, and the point of it
is to find out whether the thing works on real documents before any more is built
on top of it.

Everything here runs on your own machine. The bot does not need to live on a VM
to be tested, and watching JSON log lines scroll past while you post into the
group tells you more than a deployment would.

---

## Before you start

**Use a dedicated SIM.** Baileys is an unofficial reimplementation of WhatsApp
Web, using it breaks WhatsApp's terms, and the number can be banned without
warning or appeal. Do not pair your personal number. Treat the session as
something you will have to re-establish rather than as infrastructure.

**Two keys you need, and I should not have:**

| Variable | Where it comes from | Notes |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API | Bypasses row-level security. Never in a `NEXT_PUBLIC_*` variable, never in a committed file |
| `GEMINI_API_KEY` | aistudio.google.com | Free tier is fine for your own documents. See the warning below |

**The free Gemini tier is not free of consequences.** Google may use free-tier
prompts and responses to improve its products, including human review. What this
product sends is your *customers'* names, UPI handles, phone numbers and
transaction references — third-party personal data, which makes the business a
data fiduciary for it under the DPDP Act. Fine for documents you made up or your
own. Not fine for a real customer's.

---

## 1. Link the group

The bot ignores every group that is not linked, and does not store their
messages. List what the number can see:

```bash
pnpm --filter bot groups
```

First run prints a QR code — scan it from WhatsApp → Linked devices. That writes
`bot/auth_state/`, which **is a credential**: anyone who copies that directory
reads every group this number is in. It is gitignored; keep it that way.

You should see `pairing configured successfully`, a brief reconnect, and then the
list. A **515** right after pairing is WhatsApp asking for the socket to be
re-established, not a failure — the command handles it, and so does the bot's
listener.

If it dies with **`connection closed (405)`** before showing a QR code, the
announced WhatsApp Web version was rejected. The socket now looks the current
version up at runtime (`bot/src/sources/socket.ts`), so this should not recur —
but if it does, `pnpm --filter bot add baileys@legacy` and try once more.

If it dies with **`401` / `device_removed`**, the phone no longer lists this
device. Check WhatsApp → Settings → Linked devices:

- **No device listed** — the link is gone. `rm -rf bot/auth_state` and pair once
  more. An exit before the 515 reconnect can leave a device half-registered,
  which the phone then drops; that is why the restart is handled rather than
  treated as an error.
- **A device IS listed** — something else is using those credentials. Stop the
  other process; do not re-pair.

**Do not retry a failed pairing in a loop.** Repeated failed registrations from
one number is exactly the pattern that gets it flagged, and a banned number is
the one failure here that has no workaround. Two attempts, then stop and work out
why.

The command prints each group's name, id and member count, then exits. Copy the
accounting group's id into **Settings → WhatsApp groups** in the web app. Do it
there rather than in SQL: the row has to be scoped to your `auth.uid()`, and the
web app is the only place that happens without the service-role key.

`wa_group_id` is globally unique, not unique per owner — a group can only ever be
claimed once, or two owners could both point it at their own books.

### Only one bot per session, ever

WhatsApp allows one connection per linked device, and two processes on one auth
directory do not take turns: each evicts the other with
`conflict type="replaced"`, both reconnect, and within seconds the group cipher
state is corrupt — real messages then arrive as `failed to decrypt message:
Received message with old counter`. It presents as three unrelated bugs and is
one cause.

The bot now refuses to start if another holds the session, and names the pid to
kill. If a crash leaves a stale `bot/auth_state.lock` behind, the next start
detects the dead pid and takes over on its own.

### Finding a group id while the bot is running

Do **not** run `groups` with the bot running: WhatsApp allows one connection per
linked device, so the two fight and each keeps replacing the other
(`conflict type="replaced"`, code 440). The bot recovers, but it is pointless
churn on a session you want to look boring.

Instead, post anything into the group and read the bot's own log:

```
{"event":"ignored","reason":"unknown-group","waGroupId":"1203...@g.us"}
```

That line exists precisely so an unlinked group can be identified without
storing anything from it — the bot exits before any write, any Gemini call, any
row. Copy the id from there.

## 2. Start the bot

```bash
SUPABASE_URL=https://pqgxohjvatwocxiehytv.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=… \
GEMINI_API_KEY=… \
pnpm --filter bot start
```

Or put them in `bot/.env` — `.env` is gitignored — and just run
`pnpm --filter bot start`.

It prints `[bot] listening` and then one JSON line per message. Leave it in the
foreground where you can see it and kill it with ctrl-C.

### If you are paired to your own number

Every message you post is then `fromMe`, and the bot drops those before it logs
anything — no line, no row, nothing to debug, because in production `fromMe`
means only the bot's own traffic and processing it would be a loop.

Set `INCLUDE_OWN_MESSAGES=1` in `bot/.env` while testing. The bot prints a
warning on startup so it cannot be left on by accident, and it must be removed
before a real customer's group.

## 3. Post two documents

Into the linked group, from any member:

1. **An invoice** — a photo of a bill, or a PDF. Note the amount.
2. **A payment screenshot** for the same amount, from GPay / PhonePe / a bank
   app, ideally with a payer name close to the invoice's customer name.

Post them a minute apart. Order does not matter — that is the whole point of the
pending pool — but seeing the second one produce the proposal is the clearer
demonstration.

## 4. Read the log

One line per message. What to expect:

| Line | Means |
|---|---|
| `{"event":"saved","kind":"invoice",…,"proposed":0}` | The invoice landed. Nothing to match it to yet |
| `{"event":"saved","kind":"payment",…,"proposed":1}` | **The one you want.** The payment landed and the matcher proposed a pairing |
| `…"proposed":0` on the payment | It saved but would not guess. Not a failure — see below |
| `…"attention":["no amount could be read"]` | Readable enough to store, not enough to match. It is in "Needs a human first" |
| `{"event":"not-document",…}` | Read as chatter. If that was a real document, see below |
| `{"event":"unclassified",…}` | Extraction failed outright. The image is kept and waiting for you to say what it is |
| `{"event":"ignored","reason":"unknown-group"}` | The group is not linked, or the id does not match. Re-run step 1 |
| `{"event":"ignored","reason":"duplicate-message"}` | Already seen. Normal after a reconnect |

Then open the review screen. A proposal shows both images side by side with the
score and the reasons it gives.

## 5. What "it didn't work" actually tells you

Each failure points somewhere different, and it is worth being precise about
which one you got.

**`proposed: 0` on the payment, and both documents look right in the app.** The
matcher would not guess, which it does on purpose. Open the payment and press
"Find its invoice" — the shortlist shows every candidate with its score. Read the
reasons. Almost always one of:

- *names do not match* — the interesting case. If the invoice is handwritten in
  Telugu and the UPI app shows a Latin name, trigram similarity between them is
  **zero**, and the name term contributes nothing at all. This is the top-ranked
  risk in the design, and if it holds across real documents the answer is a
  better shortlist, not a cleverer matcher.
- *could be a partial payment* — amounts differ. Partials are never proposed
  automatically in P0.
- *paid BEFORE the invoice was issued* — a hard veto. Check the dates the model
  read; a misread year does this.

**The amount is wrong in the app.** Extraction, not matching. Correct it on the
detail screen; saving re-runs the matcher. Note how often this happens — it is
the number that decides whether the review queue is the exception or the main
screen.

**A payment screenshot came out as `pending` when it plainly said success.** Look
at what the app displays. The prompt refuses to answer `completed` unless the
screen says so, because a failed payment recorded as received puts money in the
books that never arrived. If real screenshots trip this, the prompt needs the
wording they actually use.

**`not-document` on something real.** The classifier, which is the cheapest thing
here to fix — it is prompt wording in `bot/src/extract/gemini.ts`. Keep the
example; it is worth more than a guess at what to change.

---

## What this run is for

Not a demo. It is the honest measurement the design calls milestone 4, on a
sample of two — and the number worth writing down is not "did it work" but **how
many of fifty real pairs it gets right**. If precision at the 0.90 threshold is
poor, auto-proposal is worthless and the product is a fast manual matching tool
instead. That is still a viable product, and the review screen is most of it, but
it is a different pitch and the threshold should move to say so.

Find that out on fifty documents, before building anything else.
