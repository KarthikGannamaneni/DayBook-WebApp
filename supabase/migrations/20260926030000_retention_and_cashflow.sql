-- ============================================================================
-- Image retention, and the cash-flow series the summary screen needs.
--
-- Retention was a promise with no mechanism. `raw_messages.purge_after` existed
-- and nothing called the function that honours it; document images had no
-- retention at all and were kept forever. These are photographs of other
-- people's payments — the business is the data fiduciary for them under DPDP,
-- and "we keep them indefinitely because nobody wrote the job" is not a
-- retention policy.
--
-- The structured record outlives the image on purpose: an owner asking "what did
-- Ravi pay in March" should still get an answer next year, while the screenshot
-- itself has no reason to survive that long.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- When each image becomes deletable, and whether it has been.
--
-- The row is KEPT after the image goes, with purged_at set, so the app can say
-- "the original was deleted on 3 March" instead of showing a broken image and
-- letting the owner conclude the system lost their bill.
-- ---------------------------------------------------------------------------
alter table public.document_files
  add column if not exists purge_after date not null default (current_date + 90),
  add column if not exists purged_at timestamptz;

comment on column public.document_files.purge_after is
  'Date the stored original becomes deletable. The row survives; see purged_at.';

create index if not exists document_files_purge_idx
  on public.document_files (purge_after) where purged_at is null;

-- What the purge job asks for. A view rather than a function because the deletion
-- itself has to happen through the Storage API, which SQL cannot reach — the bot
-- reads this, deletes the objects, then marks them.
create view public.v_purgeable_files with (security_invoker = true) as
select id, owner_id, storage_path, thumbnail_path, purge_after
from public.document_files
where purged_at is null and purge_after < current_date;

-- Marks images as purged once the objects are actually gone. SECURITY DEFINER
-- because document_files is deliberately not writable by the owner, and the same
-- obligation applies as everywhere else: it bypasses RLS, so it re-checks the
-- caller instead of trusting a policy that is not running.
--
-- The bot calls this with the service role, where auth.uid() is null. That is
-- allowed; a signed-in user may only mark their own.
create or replace function public.mark_files_purged(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  update public.document_files
     set purged_at = now(), thumbnail_path = null
   where id = any (p_ids)
     and purged_at is null
     and (auth.uid() is null or owner_id = auth.uid());
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.mark_files_purged(uuid[]) from public, anon;
grant execute on function public.mark_files_purged(uuid[]) to authenticated, service_role;

-- ============================================================================
-- Cash flow.
--
-- The requirement calls budgeting "a side benefit of data the business was
-- already producing", which is exactly right: this is a view over rows that
-- already exist, not a new pipeline.
--
-- Weeks are generated rather than grouped, so a week with no activity appears as
-- a zero instead of vanishing — a chart that silently drops empty weeks
-- misrepresents a slow month as a busy one.
-- ============================================================================
create view public.v_cash_flow_weeks with (security_invoker = true) as
with weeks as (
  select generate_series(
    date_trunc('week', current_date - interval '11 weeks')::date,
    date_trunc('week', current_date)::date,
    interval '1 week'
  )::date as week_start
)
select
  w.week_start,
  (w.week_start + 6) as week_end,
  coalesce((
    select sum(i.amount_minor) from public.invoices i
     where i.deleted_at is null and i.issued_on >= w.week_start and i.issued_on < w.week_start + 7
  ), 0)::bigint as invoiced_minor,
  -- Money received, by the date it was received rather than the date it was
  -- matched. Reconciliation is bookkeeping; the cash arrived when it arrived.
  coalesce((
    select sum(p.amount_minor) from public.payments p
     where p.deleted_at is null and p.txn_status = 'completed'
       and p.paid_on >= w.week_start and p.paid_on < w.week_start + 7
  ), 0)::bigint as collected_minor
from weeks w
order by w.week_start;

comment on view public.v_cash_flow_weeks is
  'Twelve weeks of invoiced vs collected, scoped to the caller by RLS underneath.';
