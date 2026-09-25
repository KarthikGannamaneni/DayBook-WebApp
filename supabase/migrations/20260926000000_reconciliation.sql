-- ============================================================================
-- Payment reconciliation. See docs/p0-tech-design.md.
--
-- This replaces the expense-capture schema created in 20260925000000. The
-- product changed from "what did I spend" to "who still owes me", which is a
-- different question with a different shape, so `projects`, `categories`,
-- `expenses` and `expense_files` are dropped rather than bent into place.
--
-- The earlier migration is kept rather than rewritten because it is how the
-- deployed database got to where it is; editing applied history would leave
-- the cloud project and this directory disagreeing about reality. The drops
-- below are the honest record of a one-day-old mistake.
--
-- The centre of this schema is the ALLOCATION: a statement that ₹X of one
-- payment settles one invoice. The pending pool, the counts, partial payments
-- and undo are all derived from allocations rather than stored separately.
-- Getting this shape wrong is the most expensive mistake available here, so it
-- is decided first and defended by constraints.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;
-- Trigram similarity is how a payer name is matched to a customer name. It is
-- in Postgres rather than a service because the review screen needs the same
-- ranking the bot used, live, while the owner is looking at a payment.
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Out with the expense model.
-- ---------------------------------------------------------------------------
drop view if exists public.v_project_totals;

-- A group belongs to an owner. It does not belong to a project, because there
-- are no projects: the accounting group holds documents for many customers,
-- so customer identity comes from the documents, not from the group. This
-- column goes first, because it is the last thing referencing projects.
alter table public.whatsapp_groups drop column if exists project_id;

drop table if exists public.expense_files;
drop table if exists public.expenses;
drop table if exists public.categories;
drop table if exists public.projects;
drop type if exists public.expense_status;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.doc_kind        as enum ('invoice', 'payment', 'neither');
create type public.allocation_state as enum ('proposed', 'accepted', 'rejected');
create type public.actor           as enum ('auto', 'owner');
create type public.txn_status      as enum ('completed', 'pending', 'failed');
create type public.payment_method  as enum ('upi', 'cash', 'bank', 'other');

-- ---------------------------------------------------------------------------
-- Name normalisation, shared by both sides of the ledger.
--
-- Immutable, because it backs a generated column.
--
-- Punctuation is REMOVED by blacklist rather than by keeping [:alnum:]. The
-- whitelist version looked equivalent and was not: Telugu vowel signs are
-- combining marks, not alphanumerics, so `[^[:alnum:] ]` deleted them and
-- turned "కుమార్" into "క మ ర" — making most Telugu names normalise to the
-- same handful of consonants. The suite asserts this directly.
--
-- Punctuation goes first so honorifics are whole tokens by the time they are
-- matched: "M/s." only looks like the token "m s" after the slash and full
-- stop are gone.
-- ---------------------------------------------------------------------------
create or replace function public.norm_name(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(coalesce(p_name, '')), '[[:punct:]]+', ' ', 'g'),
        '\s+', ' ', 'g'),
      '(^|\s)(m s|messrs|sri|shri|smt|mr|mrs|ms)(?=\s|$)', ' ', 'g'),
    '\s+', ' ', 'g')), '');
$$;

comment on function public.norm_name(text) is
  'Lowercase, honorific- and punctuation-stripped name for trigram matching.';

-- ---------------------------------------------------------------------------
-- Raw messages. Written BEFORE the model is called, so a crash or a bad
-- classification loses nothing, and the 30-day window is the recovery path
-- when a real document is wrongly read as chatter.
--
-- wa_message_id is unique: the idempotency key for the whole pipeline. Baileys
-- re-delivers on reconnect, and without this every disconnect would duplicate
-- a day of documents.
-- ---------------------------------------------------------------------------
alter table public.raw_messages
  add column if not exists doc_kind public.doc_kind;

-- Set when the model could not read a message that carried an image, so the
-- bot knows what it is looking at but not which side of the ledger it belongs
-- to. Without somewhere to park these, a Gemini outage would mean storing a
-- photograph that nothing in the app ever references again — and "an image with
-- no row is invisible to everyone" is the reason the pipeline is ordered the
-- way it is. The owner says which it is; see classify_raw_message below.
alter table public.raw_messages
  add column if not exists needs_classification boolean not null default false;

create index if not exists raw_messages_unclassified_idx
  on public.raw_messages (owner_id, received_at desc) where needs_classification;

-- ---------------------------------------------------------------------------
-- Invoices — money owed to the business.
-- ---------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  customer_name text,
  -- Generated, so it can never drift from the name it normalises.
  customer_name_norm text generated always as (public.norm_name(customer_name)) stored,
  -- Money is bigint paise. Never a float: a rupee amount in a float is a
  -- rounding error waiting to become a dispute. Null means "could not be
  -- read", which is a reviewable state, not a zero.
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  invoice_no text,
  issued_on date,
  due_on date,
  description text,
  source_message_id uuid references public.raw_messages (id) on delete set null,
  confidence numeric(3, 2) check (confidence is null or (confidence between 0 and 1)),
  extraction_notes text,
  entered_by public.actor not null default 'auto',
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

-- One message produces at most one invoice: the pipeline is idempotent end to
-- end, not only at the dedupe step.
create unique index invoices_source_message_uidx
  on public.invoices (source_message_id) where source_message_id is not null;

-- People forward the same invoice again as a reminder, which arrives as a new
-- message with a new id. Without this, receivables double every time somebody
-- chases a payment.
create unique index invoices_no_uidx
  on public.invoices (owner_id, invoice_no) where invoice_no is not null;

create index invoices_owner_issued_idx
  on public.invoices (owner_id, issued_on desc) where deleted_at is null;
create index invoices_name_trgm_idx
  on public.invoices using gin (customer_name_norm extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Payments — money received.
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  payer_name text,
  payer_name_norm text generated always as (public.norm_name(payer_name)) stored,
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  paid_on date,
  -- The UPI reference. Globally unique per transaction, which makes it the
  -- one dedupe key strong enough to collapse two screenshots of one payment.
  utr text,
  payer_vpa text,
  -- Captured so it can be checked: a forwarded screenshot of a payment made to
  -- somebody else's handle is not a receipt for this business.
  payee_vpa text,
  app text,
  -- A screenshot of a FAILED or PENDING transaction is a screenshot of money
  -- that did not arrive. Only 'completed' may be allocated; the constraint is
  -- in tg_validate_allocation, not in a comment.
  txn_status public.txn_status not null default 'pending',
  note text,
  method public.payment_method not null default 'upi',
  source_message_id uuid references public.raw_messages (id) on delete set null,
  confidence numeric(3, 2) check (confidence is null or (confidence between 0 and 1)),
  extraction_notes text,
  entered_by public.actor not null default 'auto',
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

create unique index payments_source_message_uidx
  on public.payments (source_message_id) where source_message_id is not null;
create unique index payments_utr_uidx
  on public.payments (owner_id, utr) where utr is not null;
create index payments_owner_paid_idx
  on public.payments (owner_id, paid_on desc) where deleted_at is null;
create index payments_name_trgm_idx
  on public.payments using gin (payer_name_norm extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Allocations — the whole point.
--
-- Many-to-many, because partial payments and split invoices are both ordinary:
-- one payment can settle three invoices, one invoice can take four
-- instalments. A match_id column on either side could not express that.
--
-- Rejected rows are KEPT. Deleting them would let the matcher re-propose the
-- same wrong pairing on the next run, forever.
-- ---------------------------------------------------------------------------
create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  payment_id uuid not null references public.payments (id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  score numeric(3, 2) check (score is null or (score between 0 and 1)),
  reasons text[] not null default '{}',
  state public.allocation_state not null default 'proposed',
  source public.actor not null default 'auto',
  decided_at timestamptz,
  decided_by uuid references public.owners (id) on delete set null,
  created_at timestamptz not null default now()
);

-- One live allocation per pair. Rejected ones are excluded so a pair can be
-- reconsidered after an undo without tripping over its own history.
create unique index allocations_pair_uidx
  on public.allocations (invoice_id, payment_id) where state <> 'rejected';
create index allocations_invoice_idx on public.allocations (invoice_id) where state = 'accepted';
create index allocations_payment_idx on public.allocations (payment_id) where state = 'accepted';
create index allocations_queue_idx on public.allocations (owner_id, score desc) where state = 'proposed';

-- ---------------------------------------------------------------------------
-- Append-only decision log. This is what makes undo correct.
--
-- Undo has to survive a page refresh, so it cannot live in React state.
-- Inverting the last event is two lines; reconstructing intent from a mutable
-- status column is not. It also answers "who accepted this ₹45,000 match",
-- which anything touching money wants regardless.
-- ---------------------------------------------------------------------------
create table public.allocation_events (
  id bigserial primary key,
  allocation_id uuid not null references public.allocations (id) on delete cascade,
  owner_id uuid not null references public.owners (id) on delete cascade,
  from_state public.allocation_state,
  to_state public.allocation_state not null,
  amount_minor bigint not null,
  actor public.actor not null,
  at timestamptz not null default now()
);
create index allocation_events_alloc_idx on public.allocation_events (allocation_id, at desc);
create index allocation_events_owner_idx on public.allocation_events (owner_id, at desc);

-- ---------------------------------------------------------------------------
-- Files. The original is the source of truth; extracted fields are a
-- convenience layer over it. Exactly one of invoice_id / payment_id is set.
-- ---------------------------------------------------------------------------
create table public.document_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  invoice_id uuid references public.invoices (id) on delete cascade,
  payment_id uuid references public.payments (id) on delete cascade,
  -- The third option is for a file whose document could not be created because
  -- extraction failed. It holds the image until the owner says what it is.
  raw_message_id uuid references public.raw_messages (id) on delete cascade,
  storage_path text not null,
  thumbnail_path text,
  mime_type text not null,
  size_bytes bigint not null,
  wa_message_id text,
  sender_wa_id text,
  captured_at timestamptz not null default now(),
  constraint document_files_one_side check (
    (invoice_id is not null)::int
    + (payment_id is not null)::int
    + (raw_message_id is not null)::int = 1
  )
);
create index document_files_invoice_idx on public.document_files (invoice_id);
create index document_files_payment_idx on public.document_files (payment_id);
create index document_files_raw_idx on public.document_files (raw_message_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create trigger invoices_updated_at before update on public.invoices
  for each row execute function public.tg_set_updated_at();
create trigger payments_updated_at before update on public.payments
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- New owner setup. No categories to seed any more — reconciliation has no
-- category dimension, and inventing one would be modelling a requirement
-- nobody stated.
-- ---------------------------------------------------------------------------
create or replace function public.tg_on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.owners (id, email, phone)
  values (new.id, new.email, new.phone)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ============================================================================
-- Invariants.
--
-- These are correctness AND security controls. Their input is model output
-- derived from images anyone in the WhatsApp group can post, so a prompt that
-- talks Gemini into a ₹10,00,000 payment still must not settle more than an
-- invoice is worth. The defence is here, not in the prompt.
-- ============================================================================

create or replace function public.tg_validate_allocation()
returns trigger
language plpgsql
as $$
declare
  v_inv_owner uuid;
  v_pay_owner uuid;
  v_txn public.txn_status;
begin
  select owner_id into v_inv_owner from public.invoices where id = new.invoice_id;
  select owner_id, txn_status into v_pay_owner, v_txn from public.payments where id = new.payment_id;

  -- The one write in this schema that touches two owners' rows, and therefore
  -- the one worth attacking.
  if v_inv_owner is distinct from v_pay_owner or v_inv_owner is distinct from new.owner_id then
    raise exception 'an allocation must join an invoice and a payment belonging to the same owner'
      using errcode = '42501';
  end if;

  if v_txn <> 'completed' then
    raise exception 'only a completed payment can settle an invoice (this one is %)', v_txn
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger allocations_validate before insert or update on public.allocations
  for each row execute function public.tg_validate_allocation();

-- Over-allocation must be impossible even through a bug in the RPCs. Deferred,
-- so a bulk accept of twelve rows is checked once at commit rather than
-- row-by-row in an order that happens to pass.
create or replace function public.tg_check_allocation_totals()
returns trigger
language plpgsql
as $$
declare
  v_inv uuid := coalesce(new.invoice_id, old.invoice_id);
  v_pay uuid := coalesce(new.payment_id, old.payment_id);
  v_allocated bigint;
  v_total bigint;
begin
  select coalesce(sum(amount_minor), 0) into v_allocated
    from public.allocations where invoice_id = v_inv and state = 'accepted';
  select amount_minor into v_total from public.invoices where id = v_inv;
  if v_total is not null and v_allocated > v_total then
    raise exception 'allocations for this invoice total % but the invoice is %',
      v_allocated, v_total using errcode = '23514';
  end if;

  select coalesce(sum(amount_minor), 0) into v_allocated
    from public.allocations where payment_id = v_pay and state = 'accepted';
  select amount_minor into v_total from public.payments where id = v_pay;
  if v_total is not null and v_allocated > v_total then
    raise exception 'allocations for this payment total % but the payment is %',
      v_allocated, v_total using errcode = '23514';
  end if;

  return null;
end;
$$;

create constraint trigger allocations_totals
  after insert or update or delete on public.allocations
  deferrable initially deferred
  for each row execute function public.tg_check_allocation_totals();

-- Every state change is logged, by a trigger rather than by the callers, so a
-- direct UPDATE from the browser cannot skip the audit trail. SECURITY DEFINER
-- because allocation_events has no insert policy: the log is writable only
-- this way.
create or replace function public.tg_log_allocation_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.allocation_events (allocation_id, owner_id, from_state, to_state, amount_minor, actor)
  values (
    new.id, new.owner_id,
    case when tg_op = 'UPDATE' then old.state end,
    new.state, new.amount_minor,
    (case when auth.uid() is null then 'auto' else 'owner' end)::public.actor
  );
  return null;
end;
$$;

create trigger allocations_log_insert after insert on public.allocations
  for each row execute function public.tg_log_allocation_event();
create trigger allocations_log_update after update on public.allocations
  for each row when (old.state is distinct from new.state)
  execute function public.tg_log_allocation_event();

-- ============================================================================
-- Derived state. The pending pool is a VIEW, not a table: no pool to drift out
-- of sync with the ledger, and partial payments need no special case.
--
-- security_invoker throughout, so row-level security still applies through
-- every one of them.
-- ============================================================================

create view public.v_invoice_status with (security_invoker = true) as
select
  i.*,
  coalesce(a.allocated, 0)::bigint as allocated_minor,
  (i.amount_minor - coalesce(a.allocated, 0))::bigint as balance_minor,
  case
    when i.amount_minor is null then 'unreadable'
    when coalesce(a.allocated, 0) = 0 then 'open'
    when coalesce(a.allocated, 0) < i.amount_minor then 'part_paid'
    else 'settled'
  end as settle_status,
  (current_date - i.issued_on) as age_days
from public.invoices i
left join (
  select invoice_id, sum(amount_minor) as allocated
  from public.allocations where state = 'accepted' group by invoice_id
) a on a.invoice_id = i.id
where i.deleted_at is null;

create view public.v_payment_status with (security_invoker = true) as
select
  p.*,
  coalesce(a.applied, 0)::bigint as applied_minor,
  (p.amount_minor - coalesce(a.applied, 0))::bigint as unapplied_minor
from public.payments p
left join (
  select payment_id, sum(amount_minor) as applied
  from public.allocations where state = 'accepted' group by payment_id
) a on a.payment_id = p.id
where p.deleted_at is null;

-- What the review screen works through: one proposal at a time, both sides
-- joined, with the reasons the matcher gives. A score with no explanation is a
-- number to be distrusted.
create view public.v_review_queue with (security_invoker = true) as
select
  al.id            as allocation_id,
  al.owner_id,
  al.score,
  al.reasons,
  al.amount_minor  as proposed_minor,
  al.created_at,
  iv.id            as invoice_id,
  iv.customer_name,
  iv.invoice_no,
  iv.issued_on,
  iv.amount_minor  as invoice_amount_minor,
  iv.balance_minor as invoice_balance_minor,
  pv.id            as payment_id,
  pv.payer_name,
  pv.paid_on,
  pv.utr,
  pv.app,
  pv.payer_vpa,
  pv.payee_vpa,
  pv.note,
  pv.amount_minor    as payment_amount_minor,
  pv.unapplied_minor as payment_unapplied_minor
from public.allocations al
join public.v_invoice_status iv on iv.id = al.invoice_id
join public.v_payment_status pv on pv.id = al.payment_id
where al.state = 'proposed';

-- Documents the model could not read. These need a human before they can be
-- matched at all, so they belong in the review session too.
create view public.v_unreadable_documents with (security_invoker = true) as
select 'invoice'::public.doc_kind as kind, i.id, i.owner_id,
       i.customer_name as party_name, i.amount_minor, i.issued_on as dated,
       i.confidence, i.extraction_notes, i.created_at
from public.v_invoice_status i
where i.amount_minor is null or i.customer_name is null
union all
select 'payment'::public.doc_kind, p.id, p.owner_id,
       p.payer_name, p.amount_minor, p.paid_on,
       p.confidence, p.extraction_notes, p.created_at
from public.v_payment_status p
where p.amount_minor is null or p.payer_name is null or p.txn_status <> 'completed';

-- ---------------------------------------------------------------------------
-- Documents the model could not read at all, waiting to be told what they are.
-- ---------------------------------------------------------------------------
create view public.v_unclassified_documents with (security_invoker = true) as
select
  r.id as raw_message_id,
  r.owner_id,
  r.body,
  r.sender_name,
  r.received_at,
  f.id   as file_id,
  f.storage_path,
  f.thumbnail_path,
  f.mime_type
from public.raw_messages r
join public.document_files f on f.raw_message_id = r.id
where r.needs_classification;

-- Money arrived and the ledger cannot say what for. A real signal — an
-- unbilled job, or a payment meant for somebody else — so it is surfaced,
-- never hidden.
create view public.v_unapplied_payments with (security_invoker = true) as
select p.*
from public.v_payment_status p
where p.txn_status = 'completed' and p.unapplied_minor > 0;

-- "State always visible": the header of the review screen. One row, scoped to
-- the caller by RLS on the views underneath — which is why the web app is its
-- only intended caller. The service role would see every owner summed
-- together.
create view public.v_counts with (security_invoker = true) as
select
  (select count(*)                                   from public.v_review_queue)                                                as review_count,
  (select count(*) from public.v_unreadable_documents)
    + (select count(*) from public.v_unclassified_documents)                                                                     as unreadable_count,
  (select count(*)                                   from public.v_invoice_status where settle_status in ('open', 'part_paid'))  as pending_count,
  (select coalesce(sum(balance_minor), 0)::bigint     from public.v_invoice_status where settle_status in ('open', 'part_paid'))  as pending_minor,
  (select count(*)                                   from public.v_invoice_status where settle_status = 'settled')               as matched_count,
  (select coalesce(sum(amount_minor), 0)::bigint      from public.v_invoice_status where settle_status = 'settled')              as matched_minor,
  (select count(*)                                   from public.v_unapplied_payments)                                          as unapplied_count,
  (select coalesce(sum(unapplied_minor), 0)::bigint   from public.v_unapplied_payments)                                         as unapplied_minor,
  (select count(*)                                   from public.v_invoice_status
     where settle_status in ('open', 'part_paid') and issued_on is not null)                                                     as aged_count,
  (select coalesce(max(current_date - issued_on), 0)  from public.v_invoice_status
     where settle_status in ('open', 'part_paid'))                                                                              as oldest_age_days;

-- Grouped by normalised name rather than by a customers table. P0 deliberately
-- has no customer entity: OCR produces several spellings of one person, and
-- auto-creating a row per variant means twelve customers become fifty plus a
-- merge UI on day one. This view answers "what does Ravi owe" well enough, and
-- tells you how bad the name problem actually is before you build on it.
create view public.v_customer_balances with (security_invoker = true) as
select
  owner_id,
  coalesce(customer_name_norm, '(unreadable)') as customer_key,
  min(customer_name)                           as display_name,
  count(*)                                     as invoice_count,
  coalesce(sum(balance_minor), 0)::bigint      as balance_minor,
  max(current_date - issued_on)                as oldest_age_days
from public.v_invoice_status
where settle_status in ('open', 'part_paid')
group by owner_id, coalesce(customer_name_norm, '(unreadable)');

-- ============================================================================
-- The matcher.
--
-- One implementation, two callers: the bot after inserting a document, and the
-- browser for the re-match shortlist. Two implementations of a money-matching
-- rule would diverge, and a round trip to the VM for a dropdown is absurd.
--
-- Scoring (docs §4):
--   reference hit           → 1.00
--   otherwise 0.60 × amount_fit + 0.30 × name_similarity + 0.10 × date_fit
-- ============================================================================

create or replace function public.match_candidates(p_side text, p_id uuid)
returns table (
  invoice_id uuid,
  payment_id uuid,
  suggested_minor bigint,
  score numeric,
  reasons text[],
  full_settlement boolean,
  date_ok boolean,
  customer_name text,
  invoice_amount_minor bigint,
  invoice_balance_minor bigint,
  issued_on date,
  invoice_no text,
  payer_name text,
  payment_amount_minor bigint,
  payment_unapplied_minor bigint,
  paid_on date,
  utr text
)
language sql
stable
set search_path = public, extensions
as $$
  with target_invoice as (
    select iv.*
    from public.v_invoice_status iv
    where iv.balance_minor > 0
      and (
        (p_side = 'invoice' and iv.id = p_id)
        or (p_side = 'payment'
            and iv.owner_id = (select pp.owner_id from public.payments pp where pp.id = p_id))
      )
  ),
  target_payment as (
    select pv.*
    from public.v_payment_status pv
    where pv.txn_status = 'completed' and pv.unapplied_minor > 0
      and (
        (p_side = 'payment' and pv.id = p_id)
        or (p_side = 'invoice'
            and pv.owner_id = (select ii.owner_id from public.invoices ii where ii.id = p_id))
      )
  ),
  scored as (
    select
      ti.id as inv_id,
      tp.id as pay_id,
      ti.customer_name, ti.amount_minor as inv_amount, ti.balance_minor, ti.issued_on, ti.invoice_no,
      tp.payer_name, tp.amount_minor as pay_amount, tp.unapplied_minor, tp.paid_on, tp.utr,
      least(tp.unapplied_minor, ti.balance_minor) as suggested,
      -- A reference on either side is decisive and rare. Cheap to check.
      (ti.invoice_no is not null and tp.note is not null
         and position(lower(ti.invoice_no) in lower(tp.note)) > 0)
      or (tp.utr is not null and ti.description is not null
         and position(lower(tp.utr) in lower(ti.description)) > 0) as ref_hit,
      -- Remaining balance, not the original amount, so an instalment matches
      -- as cleanly as a first payment.
      case
        when tp.unapplied_minor = ti.balance_minor then 1.0
        when tp.unapplied_minor < ti.balance_minor
             and tp.unapplied_minor >= (ti.balance_minor * 0.10) then 0.5
        else 0.0
      end as amount_fit,
      extensions.similarity(
        coalesce(tp.payer_name_norm, ''), coalesce(ti.customer_name_norm, '')
      )::numeric as name_sim,
      -- A payment dated before its invoice is usually the wrong pair rather
      -- than an advance, so it scores zero rather than something small.
      case
        when tp.paid_on is null or ti.issued_on is null then 0.0
        when tp.paid_on < ti.issued_on then 0.0
        when tp.paid_on <= ti.issued_on + 30 then 1.0
        when tp.paid_on <= ti.issued_on + 90
          then (90 - (tp.paid_on - ti.issued_on))::numeric / 60
        else 0.0
      end as date_fit
    from target_invoice ti
    join target_payment tp on tp.owner_id = ti.owner_id
    -- Any existing allocation for this pair takes it out of scoring. That
    -- includes rejections: "this payment is not for that invoice" must stick,
    -- while leaving the payment available for every other invoice.
    where not exists (
      select 1 from public.allocations al
      where al.invoice_id = ti.id and al.payment_id = tp.id
    )
  ),
  final as (
    select
      s.*,
      case when s.ref_hit then 1.00
           else round(0.60 * s.amount_fit + 0.30 * s.name_sim + 0.10 * s.date_fit, 2)
      end as total_score
    from scored s
  )
  select
    f.inv_id, f.pay_id, f.suggested, f.total_score,
    array_remove(array[
      case when f.ref_hit then 'invoice reference found in the payment' end,
      case when f.amount_fit = 1.0 then 'amount matches the balance exactly'
           when f.amount_fit = 0.5 then 'could be a partial payment' end,
      case when f.name_sim >= 0.75 then 'name matches'
           when f.name_sim >= 0.35 then 'name is similar'
           when f.name_sim > 0 then 'name is only loosely similar'
           else 'names do not match' end,
      case when f.date_fit = 1.0 then 'paid within 30 days of the invoice'
           when f.date_fit > 0 then 'paid within 90 days of the invoice'
           when f.paid_on is not null and f.issued_on is not null and f.paid_on < f.issued_on
             then 'paid BEFORE the invoice was issued' end
    ], null) as reasons,
    (f.suggested = f.balance_minor and f.suggested = f.unapplied_minor) as full_settlement,
    (f.paid_on is not null and f.issued_on is not null and f.paid_on >= f.issued_on) as date_ok,
    f.customer_name, f.inv_amount, f.balance_minor, f.issued_on, f.invoice_no,
    f.payer_name, f.pay_amount, f.unapplied_minor, f.paid_on, f.utr
  from final f
  where f.total_score >= 0.50
  order by f.total_score desc, f.suggested desc
  limit 25;
$$;

comment on function public.match_candidates(text, uuid) is
  'Ranked pairings for one document. p_side is invoice or payment. Also the re-match shortlist.';

-- Writes proposals, never applications. A pairing the matcher is sure of still
-- waits for the owner: the requirement is not to confirm the obvious 90% one
-- at a time, which is an argument for bulk accept, not for a ledger that
-- changes while nobody is looking.
--
-- Idempotent and derivable — it only ever inserts 'proposed' rows and never
-- touches an accepted one — so it is safe to call last in the pipeline and
-- safe to re-run over everything after a scoring change.
create or replace function public.propose_matches(p_side text, p_id uuid)
returns int
language plpgsql
set search_path = public, extensions
as $$
declare
  v_inserted int;
begin
  if p_side not in ('invoice', 'payment') then
    raise exception 'p_side must be invoice or payment, not %', p_side;
  end if;

  insert into public.allocations
    (owner_id, invoice_id, payment_id, amount_minor, score, reasons, state, source)
  with ranked as (
    select
      c.*,
      row_number() over (order by c.score desc)      as rn,
      lead(c.score) over (order by c.score desc)     as next_score
    from public.match_candidates(p_side, p_id) c
  )
  select i.owner_id, r.invoice_id, r.payment_id, r.suggested_minor, r.score, r.reasons, 'proposed', 'auto'
  from ranked r
  join public.invoices i on i.id = r.invoice_id
  where r.rn = 1
    and r.score >= 0.90
    -- Partials are always reviewed in P0: there is no accuracy data yet that
    -- would justify automating "this ₹20,000 is part of that ₹50,000".
    and r.full_settlement
    -- A payment dated before its invoice is vetoed outright rather than left
    -- to arithmetic. Scoring date_fit at 0 is not enough: an exact amount and
    -- an exact name are worth 0.90 between them, which clears the threshold on
    -- its own, so the date term could never actually stop anything. Found by
    -- the test in matching.test.sql, not by reading the formula.
    and r.date_ok
    -- Ambiguity is never resolved by the matcher. Two invoices for ₹10,000 is
    -- the common case, not the edge case, and guessing here is how a
    -- reconciliation product loses trust in one afternoon.
    and (r.next_score is null or r.score - r.next_score > 0.05)
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- ============================================================================
-- Owner actions. security invoker, so RLS scopes them and no function here
-- can reach another owner's rows. Each is one statement in one transaction,
-- which is what makes bulk accept all-or-nothing: the deferred constraint
-- above checks the whole batch at commit.
-- ============================================================================

create or replace function public.accept_allocations(p_ids uuid[])
returns int
language plpgsql
set search_path = public
as $$
declare v_n int;
begin
  update public.allocations
     set state = 'accepted', decided_at = now(), decided_by = auth.uid()
   where id = any (p_ids) and state = 'proposed';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.reject_allocations(p_ids uuid[])
returns int
language plpgsql
set search_path = public
as $$
declare v_n int;
begin
  update public.allocations
     set state = 'rejected', decided_at = now(), decided_by = auth.uid()
   where id = any (p_ids) and state <> 'rejected';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The owner pairing two documents themselves, from the shortlist. Also how a
-- partial allocation is made: pass less than the balance and both sides stay
-- in the pool for the remainder.
create or replace function public.allocate_manual(
  p_invoice_id uuid, p_payment_id uuid, p_amount_minor bigint
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_owner uuid;
  v_id uuid;
begin
  select owner_id into v_owner from public.invoices where id = p_invoice_id;
  if v_owner is null then
    raise exception 'no such invoice' using errcode = '42501';
  end if;

  insert into public.allocations
    (owner_id, invoice_id, payment_id, amount_minor, score, reasons, state, source, decided_at, decided_by)
  values
    (v_owner, p_invoice_id, p_payment_id, p_amount_minor, null, array['matched by hand'],
     'accepted', 'owner', now(), auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- Reject one pairing and make another, atomically, so the re-match cannot
-- leave a payment with nothing attached if the second half fails.
create or replace function public.rematch(
  p_allocation_id uuid, p_invoice_id uuid, p_payment_id uuid, p_amount_minor bigint
)
returns uuid
language plpgsql
set search_path = public
as $$
begin
  perform public.reject_allocations(array[p_allocation_id]);
  return public.allocate_manual(p_invoice_id, p_payment_id, p_amount_minor);
end;
$$;

-- Undo, which the requirement asks for twice. Reads the last logged decision
-- and inverts it; the inversion is itself logged, so the trail is complete.
--
-- An allocation whose only event is its creation has nothing to revert to. If
-- the owner made it by hand, undoing "I matched these" means "not matched",
-- so it becomes rejected rather than vanishing.
create or replace function public.undo_allocation(p_allocation_id uuid)
returns public.allocation_state
language plpgsql
set search_path = public
as $$
declare
  v_from public.allocation_state;
  v_target public.allocation_state;
begin
  select from_state into v_from
    from public.allocation_events
   where allocation_id = p_allocation_id
   order by at desc, id desc
   limit 1;

  v_target := coalesce(v_from, 'rejected');

  update public.allocations
     set state = v_target,
         decided_at = case when v_target = 'proposed' then null else now() end,
         decided_by = case when v_target = 'proposed' then null else auth.uid() end
   where id = p_allocation_id
     and state <> v_target;

  return v_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- The owner saying "that one is an invoice". Creates the document with whatever
-- little is known, moves the image onto it, and clears the flag — all in one
-- transaction, so a half-classified message cannot exist.
--
-- The fields are left null on purpose. Guessing an amount here would put a
-- number in the ledger that nothing on the image supports; the owner fills it
-- in on the detail screen, looking at the picture.
create or replace function public.classify_raw_message(
  p_raw_message_id uuid, p_kind public.doc_kind
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_owner uuid;
  v_dated date;
  v_id uuid;
begin
  if p_kind not in ('invoice', 'payment') then
    raise exception 'a message can only be classified as an invoice or a payment';
  end if;

  select owner_id, received_at::date into v_owner, v_dated
    from public.raw_messages
   where id = p_raw_message_id and needs_classification;

  if v_owner is null then
    raise exception 'no unclassified message with that id' using errcode = '42501';
  end if;

  if p_kind = 'invoice' then
    insert into public.invoices (owner_id, issued_on, source_message_id, entered_by, extraction_notes)
    values (v_owner, v_dated, p_raw_message_id, 'owner', 'Classified by hand after extraction failed.')
    returning id into v_id;
    update public.document_files
       set invoice_id = v_id, raw_message_id = null
     where raw_message_id = p_raw_message_id;
  else
    -- 'pending' rather than 'completed': nothing has been read off this
    -- screenshot yet, and a payment that cannot be allocated is a far better
    -- default than one that can.
    insert into public.payments (owner_id, paid_on, txn_status, source_message_id, entered_by, extraction_notes)
    values (v_owner, v_dated, 'pending', p_raw_message_id, 'owner', 'Classified by hand after extraction failed.')
    returning id into v_id;
    update public.document_files
       set payment_id = v_id, raw_message_id = null
     where raw_message_id = p_raw_message_id;
  end if;

  update public.raw_messages
     set needs_classification = false, doc_kind = p_kind
   where id = p_raw_message_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 30-day retention on raw messages. The design promises this actually runs;
-- schedule it once per project with pg_cron:
--
--   select cron.schedule('purge-raw-messages', '30 4 * * *',
--                        $$select public.purge_expired_raw_messages()$$);
--
-- It is not scheduled from this migration because pg_cron is a project-level
-- setting, and a migration that silently enables a background job is a
-- surprise nobody asked for.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_raw_messages()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  -- A message still waiting to be classified is the one thing the 30-day window
  -- must not eat: its image is the only record of the document.
  delete from public.raw_messages
   where purge_after < current_date and not needs_classification;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ============================================================================
-- Row-level security. Deny by default, then one policy family per table, all
-- resolving to auth.uid(). The UI hides; the database refuses.
--
-- The bot uses the service-role key and bypasses all of this, which is exactly
-- why it resolves owner_id from the group mapping and never trusts anything in
-- a message.
-- ============================================================================
alter table public.invoices          enable row level security;
alter table public.payments          enable row level security;
alter table public.allocations       enable row level security;
alter table public.allocation_events enable row level security;
alter table public.document_files    enable row level security;

create policy invoices_all on public.invoices
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy payments_all on public.payments
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy allocations_all on public.allocations
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Read-only to the owner. Written only by the logging trigger, which is
-- SECURITY DEFINER for precisely this reason: an append-only log that the
-- client can append to is not append-only.
create policy allocation_events_select on public.allocation_events
  for select using (owner_id = auth.uid());

create policy document_files_select on public.document_files
  for select using (owner_id = auth.uid());
create policy document_files_delete on public.document_files
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Execution grants. Nothing here is callable by an anonymous visitor.
-- ---------------------------------------------------------------------------
do $$
declare v_sig text;
begin
  foreach v_sig in array array[
    'public.match_candidates(text, uuid)',
    'public.propose_matches(text, uuid)',
    'public.accept_allocations(uuid[])',
    'public.reject_allocations(uuid[])',
    'public.allocate_manual(uuid, uuid, bigint)',
    'public.rematch(uuid, uuid, uuid, bigint)',
    'public.undo_allocation(uuid)',
    'public.classify_raw_message(uuid, public.doc_kind)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_sig);
    execute format('grant execute on function %s to authenticated, service_role', v_sig);
  end loop;
end;
$$;

revoke all on function public.purge_expired_raw_messages() from public, anon, authenticated;
grant execute on function public.purge_expired_raw_messages() to service_role;
