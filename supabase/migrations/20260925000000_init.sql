-- ============================================================================
-- P0 schema. See docs/p0-tech-design.md §3.
--
-- Every row hangs off owner_id. That is the tenant root and the whole of the
-- authorization model: row-level security resolves every policy to
-- `owner_id = auth.uid()`. The UI hides; the database refuses.
--
-- Roles (supervisor, approvals) are P1 and deliberately absent. The shape
-- allows them later: a project_members table can grant access without
-- reshaping anything here.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

create type public.expense_status as enum ('confirmed', 'needs_review');

-- ---------------------------------------------------------------------------
-- Owners. Mirrors auth.users so the rest of the schema can carry a real
-- foreign key, and so an owner row can hold app-level fields later.
-- ---------------------------------------------------------------------------
create table public.owners (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index projects_owner_idx on public.projects (owner_id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- One WhatsApp group maps to exactly one project.
--
-- wa_group_id is globally unique, not unique per owner: a group can only be
-- claimed once, otherwise two owners could both point it at their own project
-- and each would receive the other's bills.
-- ---------------------------------------------------------------------------
create table public.whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  wa_group_id text not null unique,
  name text,
  linked_at timestamptz,
  created_at timestamptz not null default now()
);
create index whatsapp_groups_owner_idx on public.whatsapp_groups (owner_id);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 40),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

-- ---------------------------------------------------------------------------
-- Raw messages. Written BEFORE the model is called, so a crash or a bad
-- extraction loses nothing, and the 30-day window is the recovery path when
-- a real bill is wrongly classified as chatter.
--
-- wa_message_id is unique: this is the idempotency key for the whole pipeline.
-- Baileys re-delivers missed messages on reconnect, and without this every
-- disconnect would double-count a day of expenses.
-- ---------------------------------------------------------------------------
create table public.raw_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  wa_group_id text not null,
  wa_message_id text not null unique,
  sender_wa_id text,
  sender_name text,
  body text,
  has_media boolean not null default false,
  received_at timestamptz not null default now(),
  purge_after date not null default (current_date + 30),
  deleted_in_whatsapp boolean not null default false
);
create index raw_messages_purge_idx on public.raw_messages (purge_after);

-- ---------------------------------------------------------------------------
-- Expenses.
--
-- Money is bigint paise. Never a float: a rupee amount in a float is a
-- rounding error waiting to become a dispute.
-- ---------------------------------------------------------------------------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  spent_on date,
  vendor text,
  description text,
  category_id uuid references public.categories (id) on delete set null,
  posted_by_wa_id text,
  posted_by_name text,
  source_message_id uuid references public.raw_messages (id) on delete set null,
  status public.expense_status not null default 'needs_review',
  confidence numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  extraction_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz
);
create index expenses_project_idx on public.expenses (project_id, spent_on desc) where deleted_at is null;
create index expenses_review_idx on public.expenses (owner_id, created_at) where status = 'needs_review' and deleted_at is null;
-- One expense per source message: the pipeline is idempotent end to end, not
-- only at the dedupe step.
create unique index expenses_source_message_uidx on public.expenses (source_message_id) where source_message_id is not null;

-- ---------------------------------------------------------------------------
-- Files. The original is the source of truth; the extracted fields above are
-- a convenience layer over it.
-- ---------------------------------------------------------------------------
create table public.expense_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id) on delete cascade,
  expense_id uuid not null references public.expenses (id) on delete cascade,
  storage_path text not null,
  thumbnail_path text,
  mime_type text not null,
  size_bytes bigint not null,
  wa_message_id text,
  sender_wa_id text,
  captured_at timestamptz not null default now()
);
create index expense_files_expense_idx on public.expense_files (expense_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger expenses_updated_at before update on public.expenses
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- New owner setup: mirror the auth user and seed a usable category list, so
-- the first extraction has something to categorise into.
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

  insert into public.categories (owner_id, name, is_default)
  select new.id, name, true
  from unnest(array[
    'Materials', 'Labour', 'Transport', 'Equipment rental', 'Fuel',
    'Food & tea', 'Utilities', 'Permits & fees', 'Repairs', 'Other'
  ]) as name
  on conflict (owner_id, name) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_on_auth_user_created();

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Deny by default, then one policy family per table, all resolving to
-- auth.uid(). The bot uses the service-role key and therefore bypasses all of
-- this — which is exactly why it must scope every write by hand.
-- ---------------------------------------------------------------------------
alter table public.owners          enable row level security;
alter table public.projects        enable row level security;
alter table public.whatsapp_groups enable row level security;
alter table public.categories      enable row level security;
alter table public.raw_messages    enable row level security;
alter table public.expenses        enable row level security;
alter table public.expense_files   enable row level security;

create policy owners_select on public.owners
  for select using (id = auth.uid());
create policy owners_update on public.owners
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy projects_all on public.projects
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy groups_all on public.whatsapp_groups
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy categories_all on public.categories
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Raw messages are readable so the owner can see the original behind an
-- expense, but they are written only by the bot. No insert or update policy.
create policy raw_messages_select on public.raw_messages
  for select using (owner_id = auth.uid());

create policy expenses_all on public.expenses
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy expense_files_select on public.expense_files
  for select using (owner_id = auth.uid());
create policy expense_files_delete on public.expense_files
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Project totals. A view rather than a column: a stored running total is a
-- second source of truth that drifts the first time an expense is edited.
--
-- security_invoker so RLS still applies through it.
-- ---------------------------------------------------------------------------
create view public.v_project_totals with (security_invoker = true) as
select
  p.id as project_id,
  p.owner_id,
  p.name,
  p.archived_at,
  coalesce(sum(e.amount_minor) filter (where e.status = 'confirmed'), 0)::bigint as confirmed_minor,
  count(e.id) filter (where e.status = 'confirmed') as confirmed_count,
  count(e.id) filter (where e.status = 'needs_review') as review_count
from public.projects p
left join public.expenses e
  on e.project_id = p.id and e.deleted_at is null
group by p.id, p.owner_id, p.name, p.archived_at;
