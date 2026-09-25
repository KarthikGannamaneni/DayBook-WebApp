-- ============================================================================
-- Tenant isolation.
--
-- Row-level security is the whole authorization model here: there are no role
-- checks in the web app beyond "are you signed in". So this file is the proof
-- that the model works, run as a real `authenticated` user with a JWT claim
-- rather than as superuser — which would bypass every policy and pass
-- regardless.
-- ============================================================================
begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

create schema if not exists tests;
create or replace function tests.authenticate_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create or replace function tests.as_service()
returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', null, true);
end;
$$;
create or replace function tests.rows_affected(p_sql text)
returns int language plpgsql as $$
declare v int;
begin
  execute 'with a as (' || p_sql || ' returning 1) select count(*)::int from a' into v;
  return v;
end;
$$;
grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

-- Two owners, inserted with triggers LIVE.
--
-- The obvious way to seed auth.users in a test is
-- `set session_replication_role = replica`, which skips foreign-key checks —
-- and also skips triggers, including the one under test. Doing that here
-- silently produced no owners rows at all. Insert normally instead.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token,
  email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token)
values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'a@test.local', '', now(), now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'b@test.local', '', now(), now(), now(), '', '', '', '', '', '', '', '');

select is((select count(*)::int from public.owners), 2,
  'the auth trigger mirrors each new user into owners');
select ok((select count(*) from public.categories
           where owner_id = 'a0000000-0000-4000-8000-000000000001') >= 10,
  'and seeds a usable category list, so the first extraction has somewhere to go');

insert into public.projects (id, owner_id, name) values
  ('11111111-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'A site'),
  ('22222222-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'B site');

insert into public.whatsapp_groups (owner_id, project_id, wa_group_id) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'a-group@g.us'),
  ('b0000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000002', 'b-group@g.us');

insert into public.raw_messages (id, owner_id, wa_group_id, wa_message_id, body) values
  ('33333333-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a-group@g.us', 'wamid.a', 'cement 4500'),
  ('33333333-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'b-group@g.us', 'wamid.b', 'sand 900');

insert into public.expenses (owner_id, project_id, amount_minor, spent_on, vendor, status, source_message_id) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 450000, current_date, 'A vendor', 'confirmed', '33333333-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000002',  90000, current_date, 'B vendor', 'confirmed', '33333333-0000-4000-8000-000000000002');

insert into public.expense_files (owner_id, expense_id, storage_path, mime_type, size_bytes)
select owner_id, id, owner_id || '/x/' || id || '/original.jpg', 'image/jpeg', 1000
from public.expenses;

-- ---------------------------------------------------------------------------
-- Owner A sees exactly their own rows and none of B's.
-- ---------------------------------------------------------------------------
select tests.authenticate_as('a0000000-0000-4000-8000-000000000001');

select is((select count(*)::int from public.projects), 1, 'A sees only their own project');
select is((select count(*)::int from public.expenses), 1, 'A sees only their own expenses');
select is((select count(*)::int from public.raw_messages), 1, 'A sees only their own messages');
select is((select count(*)::int from public.expense_files), 1, 'A sees only their own files');
select is((select count(*)::int from public.whatsapp_groups), 1, 'A sees only their own groups');
select is((select count(*)::int from public.v_project_totals), 1,
  'the totals view is not a way around row-level security');

-- The bill is the sensitive artefact; a leaked storage path is a leaked bill.
select is((select count(*)::int from public.expense_files
           where owner_id = 'b0000000-0000-4000-8000-000000000002'), 0,
  'A cannot read the storage path of B''s bill');

-- ---------------------------------------------------------------------------
-- And cannot write across the boundary either.
-- ---------------------------------------------------------------------------
select is(tests.rows_affected(
  $$update public.expenses set amount_minor = 1
    where project_id = '22222222-0000-4000-8000-000000000002'$$), 0,
  'A cannot edit an expense in B''s project');

select is(tests.rows_affected(
  $$delete from public.projects where id = '22222222-0000-4000-8000-000000000002'$$), 0,
  'A cannot delete B''s project');

select throws_ok(
  $$insert into public.projects (owner_id, name)
    values ('b0000000-0000-4000-8000-000000000002', 'planted')$$,
  '42501',
  'new row violates row-level security policy for table "projects"',
  'A cannot create a project owned by B'
);

-- raw_messages is written only by the bot, which uses the service role.
select throws_ok(
  $$insert into public.raw_messages (owner_id, wa_group_id, wa_message_id)
    values ('a0000000-0000-4000-8000-000000000001', 'a-group@g.us', 'forged')$$,
  '42501',
  'new row violates row-level security policy for table "raw_messages"',
  'a client cannot forge an inbound message'
);

-- ---------------------------------------------------------------------------
-- The pipeline's own idempotency guarantee, at the database level.
-- ---------------------------------------------------------------------------
select tests.as_service();

select throws_ok(
  $$insert into public.raw_messages (owner_id, wa_group_id, wa_message_id)
    values ('a0000000-0000-4000-8000-000000000001', 'a-group@g.us', 'wamid.a')$$,
  '23505',
  null,
  'the same WhatsApp message cannot be stored twice, however often it is delivered'
);

select throws_ok(
  $$insert into public.expenses (owner_id, project_id, amount_minor, status, source_message_id)
    values ('a0000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001',
            1, 'confirmed', '33333333-0000-4000-8000-000000000001')$$,
  '23505',
  null,
  'and one message can only ever produce one expense'
);

select * from finish();
rollback;
