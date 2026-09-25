-- ============================================================================
-- Tenant isolation, and the invariants that protect the money.
--
-- Row-level security is the whole authorization model: the web app has no role
-- checks beyond "are you signed in". So this file is the proof that the model
-- works, run as a real `authenticated` user rather than as superuser.
--
-- The invariants at the bottom are security controls, not merely correctness
-- ones. Their input is model output derived from images anyone in the WhatsApp
-- group can post.
-- ============================================================================
begin;
create extension if not exists pgtap with schema extensions;
\ir harness/harness.psql

select plan(29);

-- Two owners.
select tests.make_user('a0000000-0000-4000-8000-000000000001', 'a@test.local');
select tests.make_user('b0000000-0000-4000-8000-000000000002', 'b@test.local');

-- Counted by id rather than in total: the suite has to pass against a database
-- that already has rows in it, or it is only ever true after a reset.
select is((select count(*)::int from public.owners
           where id in ('a0000000-0000-4000-8000-000000000001',
                        'b0000000-0000-4000-8000-000000000002')), 2,
  'the auth trigger mirrors each new user into owners');

insert into public.whatsapp_groups (owner_id, wa_group_id, name) values
  ('a0000000-0000-4000-8000-000000000001', 'a-group@g.us', 'A accounts'),
  ('b0000000-0000-4000-8000-000000000002', 'b-group@g.us', 'B accounts');

insert into public.raw_messages (id, owner_id, wa_group_id, wa_message_id, body, doc_kind) values
  ('33333333-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a-group@g.us', 'wamid.a', 'invoice 4500', 'invoice'),
  ('33333333-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'b-group@g.us', 'wamid.b', 'invoice 900', 'invoice');

insert into public.invoices (id, owner_id, customer_name, amount_minor, invoice_no, issued_on, source_message_id) values
  ('11111111-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Ravi Kumar', 450000, 'A-1', current_date - 5, '33333333-0000-4000-8000-000000000001'),
  ('11111111-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'Other Person', 90000, 'B-1', current_date - 5, '33333333-0000-4000-8000-000000000002');

insert into public.payments (id, owner_id, payer_name, amount_minor, paid_on, utr, txn_status) values
  ('22222222-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Ravi Kumar', 450000, current_date - 1, '100000000001', 'completed'),
  ('22222222-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'Other Person', 90000, current_date - 1, '100000000002', 'completed');

insert into public.document_files (owner_id, invoice_id, storage_path, mime_type, size_bytes)
select owner_id, id, owner_id || '/invoice/' || id || '/original.jpg', 'image/jpeg', 1000
from public.invoices;

insert into public.allocations (owner_id, invoice_id, payment_id, amount_minor, score, state, source) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000001', 450000, 0.95, 'proposed', 'auto'),
  ('b0000000-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000002', 90000, 0.95, 'proposed', 'auto');

-- ---------------------------------------------------------------------------
-- A reads exactly their own rows and none of B's.
-- ---------------------------------------------------------------------------
select tests.authenticate_as('a0000000-0000-4000-8000-000000000001');

select is((select count(*)::int from public.invoices), 1, 'A sees only their own invoices');
select is((select count(*)::int from public.payments), 1, 'A sees only their own payments');
select is((select count(*)::int from public.allocations), 1, 'A sees only their own allocations');
select is((select count(*)::int from public.raw_messages), 1, 'A sees only their own messages');
select is((select count(*)::int from public.document_files), 1, 'A sees only their own files');
select is((select count(*)::int from public.whatsapp_groups), 1, 'A sees only their own groups');
select is((select count(*)::int from public.allocation_events), 1,
  'A sees only their own decision log');

-- Every view is security_invoker, so none of them is a way around the policies.
select is((select count(*)::int from public.v_invoice_status), 1,
  'the invoice view is not a way around row-level security');
select is((select count(*)::int from public.v_payment_status), 1,
  'the payment view is not a way around row-level security');
select is((select count(*)::int from public.v_review_queue), 1,
  'the review queue shows only the caller''s proposals');
select is((select count(*)::int from public.v_customer_balances), 1,
  'the customer balance view does not aggregate across owners');
select is((select review_count::int from public.v_counts), 1,
  'the counts header counts only the caller''s work');

-- The document image is the sensitive artefact; a leaked storage path is a
-- leaked invoice.
select is((select count(*)::int from public.document_files
           where owner_id = 'b0000000-0000-4000-8000-000000000002'), 0,
  'A cannot read the storage path of B''s document');

-- ---------------------------------------------------------------------------
-- And cannot write across the boundary.
-- ---------------------------------------------------------------------------
select is(tests.rows_affected(
  $$update public.invoices set amount_minor = 1
    where id = '11111111-0000-4000-8000-000000000002'$$), 0,
  'A cannot edit B''s invoice');

select is(tests.rows_affected(
  $$delete from public.payments where id = '22222222-0000-4000-8000-000000000002'$$), 0,
  'A cannot delete B''s payment');

select is(tests.rows_affected(
  $$update public.allocations set state = 'accepted'
    where id in (select id from public.allocations)
      and owner_id = 'b0000000-0000-4000-8000-000000000002'$$), 0,
  'A cannot accept a match in B''s books');

select throws_ok(
  $$insert into public.invoices (owner_id, customer_name, amount_minor)
    values ('b0000000-0000-4000-8000-000000000002', 'planted', 100)$$,
  '42501',
  'new row violates row-level security policy for table "invoices"',
  'A cannot create an invoice owned by B'
);

-- The bot writes raw messages with the service role. A client forging one could
-- invent a source for an expense that never arrived.
select throws_ok(
  $$insert into public.raw_messages (owner_id, wa_group_id, wa_message_id)
    values ('a0000000-0000-4000-8000-000000000001', 'a-group@g.us', 'forged')$$,
  '42501',
  'new row violates row-level security policy for table "raw_messages"',
  'a client cannot forge an inbound message'
);

-- An append-only log the client can append to is not append-only.
select throws_ok(
  $$insert into public.allocation_events
      (allocation_id, owner_id, from_state, to_state, amount_minor, actor)
    select id, owner_id, 'accepted', 'proposed', amount_minor, 'owner'
    from public.allocations limit 1$$,
  '42501',
  null,
  'a client cannot write its own history into the decision log'
);

-- ---------------------------------------------------------------------------
-- Idempotency, at the database level rather than in the bot's good intentions.
-- ---------------------------------------------------------------------------
select tests.as_service();

select throws_ok(
  $$insert into public.raw_messages (owner_id, wa_group_id, wa_message_id)
    values ('a0000000-0000-4000-8000-000000000001', 'a-group@g.us', 'wamid.a')$$,
  '23505', null,
  'the same WhatsApp message cannot be stored twice, however often it is delivered'
);

select throws_ok(
  $$insert into public.invoices (owner_id, amount_minor, source_message_id)
    values ('a0000000-0000-4000-8000-000000000001', 1, '33333333-0000-4000-8000-000000000001')$$,
  '23505', null,
  'and one message can only ever produce one invoice'
);

-- Two screenshots of one payment. Different message ids, same transaction.
select throws_ok(
  $$insert into public.payments (owner_id, payer_name, amount_minor, paid_on, utr, txn_status)
    values ('a0000000-0000-4000-8000-000000000001', 'Ravi Kumar', 450000, current_date, '100000000001', 'completed')$$,
  '23505', null,
  'one UPI reference is one payment, however many times the screenshot is forwarded'
);

-- The invoice forwarded again as a reminder. Without this, receivables double
-- every time somebody chases a payment.
select throws_ok(
  $$insert into public.invoices (owner_id, customer_name, amount_minor, invoice_no, issued_on)
    values ('a0000000-0000-4000-8000-000000000001', 'Ravi Kumar', 450000, 'A-1', current_date)$$,
  '23505', null,
  'one invoice number is one receivable, however many reminders are sent'
);

-- ---------------------------------------------------------------------------
-- The invariants that protect the money.
-- ---------------------------------------------------------------------------

-- The one write in this schema touching two owners' rows.
select throws_ok(
  $$insert into public.allocations (owner_id, invoice_id, payment_id, amount_minor)
    values ('a0000000-0000-4000-8000-000000000001',
            '11111111-0000-4000-8000-000000000001',
            '22222222-0000-4000-8000-000000000002', 100)$$,
  '42501', null,
  'an allocation cannot pair one owner''s invoice with another owner''s payment'
);

insert into public.payments (id, owner_id, payer_name, amount_minor, paid_on, txn_status)
values ('22222222-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001',
        'Ravi Kumar', 450000, current_date, 'failed');

-- A screenshot of a failed transaction is a screenshot of money that did not
-- arrive. This is the field a ledger gets wrong by ignoring.
select throws_ok(
  $$insert into public.allocations (owner_id, invoice_id, payment_id, amount_minor)
    values ('a0000000-0000-4000-8000-000000000001',
            '11111111-0000-4000-8000-000000000001',
            '22222222-0000-4000-8000-000000000009', 100)$$,
  '23514', null,
  'a failed payment cannot settle an invoice'
);

-- Over-allocation must be impossible even through a bug in the RPCs. Deferred
-- in production, forced immediate here so it can be asserted in one test.
select lives_ok(
  $$select tests.attempt($q$update public.allocations set state = 'accepted'
      where invoice_id = '11111111-0000-4000-8000-000000000001'$q$)$$,
  'a full settlement is allowed'
);

insert into public.payments (id, owner_id, payer_name, amount_minor, paid_on, utr, txn_status)
values ('22222222-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000001',
        'Ravi Kumar', 450000, current_date, '100000000010', 'completed');

select throws_ok(
  $$select tests.attempt($q$insert into public.allocations
      (owner_id, invoice_id, payment_id, amount_minor, state)
    values ('a0000000-0000-4000-8000-000000000001',
            '11111111-0000-4000-8000-000000000001',
            '22222222-0000-4000-8000-000000000010', 1, 'accepted')$q$)$$,
  '23514', null,
  'an invoice cannot be settled for more than it is worth'
);

select throws_ok(
  $$insert into public.allocations (owner_id, invoice_id, payment_id, amount_minor)
    values ('a0000000-0000-4000-8000-000000000001',
            '11111111-0000-4000-8000-000000000001',
            '22222222-0000-4000-8000-000000000001', 1)$$,
  '23505', null,
  'one pair has at most one live allocation'
);

select * from finish();
rollback;
