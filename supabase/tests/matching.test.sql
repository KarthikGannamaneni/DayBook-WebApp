-- ============================================================================
-- The matcher, and what it must refuse to do.
--
-- Everything here is one owner, so nothing in this file depends on RLS — that
-- is rls.test.sql's job. What is under test is the judgement: which pairings
-- are proposed, which are deliberately left for a human, and whether accepting
-- one moves the balance correctly.
--
-- The refusals matter more than the matches. A reconciliation product that
-- guesses loses trust in one afternoon, and a guess is indistinguishable from
-- a correct match until somebody checks the bank.
-- ============================================================================
begin;
create extension if not exists pgtap with schema extensions;
\ir harness/harness.psql

select plan(35);

-- Every assertion below is scoped to this owner. A suite that only passes
-- against a freshly reset database is a suite that will mislead somebody the
-- first time it runs against one with rows in it.
\set owner 'a0000000-0000-4000-8000-000000000001'

select tests.make_user('a0000000-0000-4000-8000-000000000001', 'a@test.local');
-- A second owner, used only by the cross-owner check at the bottom.
select tests.make_user('b0000000-0000-4000-8000-000000000002', 'b@test.local');
set local role postgres;

-- ---------------------------------------------------------------------------
-- Name normalisation is what the whole name term rests on.
-- ---------------------------------------------------------------------------
select is(public.norm_name('M/s. Sri Ravi Kumar & Co.'), 'ravi kumar co',
  'honorifics and punctuation come out of a name before it is compared');
select is(public.norm_name('  RAVI   kumar '), 'ravi kumar',
  'case and runs of whitespace do not make two names different');
select is(public.norm_name('రవి కుమార్'), 'రవి కుమార్',
  'Telugu letters survive normalisation — stripping them would make every Telugu name identical');
select is(public.norm_name('   '), null,
  'a name that normalises to nothing is null, not an empty string that matches everything');

-- ---------------------------------------------------------------------------
-- The happy path: one invoice, one payment, same amount, same name.
-- ---------------------------------------------------------------------------
insert into public.invoices (id, owner_id, customer_name, amount_minor, invoice_no, issued_on)
values ('11111111-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'Ravi Kumar', 4500000, 'INV-001', current_date - 5);

insert into public.payments (id, owner_id, payer_name, amount_minor, paid_on, utr, txn_status)
values ('22222222-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'Ravi Kumar', 4500000, current_date - 3, '500000000001', 'completed');

select is(public.propose_matches('payment', '22222222-0000-4000-8000-000000000001'), 1,
  'an exact amount and a matching name on a recent payment is proposed');

select ok((select score from public.allocations where owner_id = :'owner') >= 0.90,
  'and it is proposed with a score the owner can see');

select ok((select 'amount matches the balance exactly' = any(reasons)
           from public.allocations where owner_id = :'owner'),
  'with the reasons spelled out — a score with no explanation is a number to be distrusted');

select is((select state::text from public.allocations where owner_id = :'owner'), 'proposed',
  'proposed, never applied: the ledger does not move while nobody is looking');

select is((select balance_minor from public.v_invoice_status
           where id = '11111111-0000-4000-8000-000000000001'), 4500000::bigint,
  'so the invoice is still outstanding in full');

select is(public.propose_matches('payment', '22222222-0000-4000-8000-000000000001'), 0,
  'and running the matcher again proposes nothing new — it is safe to re-run over everything');

-- ---------------------------------------------------------------------------
-- Accepting moves the balance. Undo puts it back.
-- ---------------------------------------------------------------------------
select is(public.accept_allocations(
  array(select id from public.allocations where owner_id = :'owner')), 1,
  'accepting the proposal reports one row changed');

select is((select balance_minor from public.v_invoice_status
           where id = '11111111-0000-4000-8000-000000000001'), 0::bigint,
  'and the invoice is settled');

select is((select settle_status from public.v_invoice_status
           where id = '11111111-0000-4000-8000-000000000001'), 'settled',
  'reported as settled rather than merely zero');

select is((select count(*)::int from public.allocation_events where owner_id = :'owner'), 2,
  'both the proposal and the acceptance are in the append-only log');

select is(public.undo_allocation(
  (select id from public.allocations where owner_id = :'owner'))::text, 'proposed',
  'undo reverts to the state before the last decision');

select is((select balance_minor from public.v_invoice_status
           where id = '11111111-0000-4000-8000-000000000001'), 4500000::bigint,
  'and the balance comes back, because balances are derived and not stored');

-- ---------------------------------------------------------------------------
-- Ambiguity is never resolved by the matcher. This is the PRD's own example.
-- ---------------------------------------------------------------------------
delete from public.allocations where owner_id = :'owner';

insert into public.invoices (id, owner_id, customer_name, amount_minor, invoice_no, issued_on)
values ('11111111-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
        'Ravi Kumar', 4500000, 'INV-002', current_date - 4);

select is(public.propose_matches('payment', '22222222-0000-4000-8000-000000000001'), 0,
  'two invoices for the same amount from the same customer propose nothing at all');

select ok((select count(*) from public.match_candidates('payment', '22222222-0000-4000-8000-000000000001')) = 2,
  'but both appear in the shortlist, instantly, so disambiguation is a tap and not a search');

-- ---------------------------------------------------------------------------
-- A partial payment is never applied automatically.
-- ---------------------------------------------------------------------------
delete from public.invoices where id = '11111111-0000-4000-8000-000000000002';

insert into public.payments (id, owner_id, payer_name, amount_minor, paid_on, utr, txn_status)
values ('22222222-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
        'Ravi Kumar', 2000000, current_date - 2, '500000000002', 'completed');

select is(public.propose_matches('payment', '22222222-0000-4000-8000-000000000002'), 0,
  'an instalment is offered but not applied: there is no accuracy data yet to justify guessing');

select ok((select full_settlement is false
           from public.match_candidates('payment', '22222222-0000-4000-8000-000000000002') limit 1),
  'and the shortlist says plainly that it would not settle the invoice');

-- Allocated by hand, it leaves the remainder in the pool for both sides.
select lives_ok(
  $$select public.allocate_manual('11111111-0000-4000-8000-000000000001',
      '22222222-0000-4000-8000-000000000002', 2000000)$$,
  'the owner can allocate a partial amount by hand');

select is((select settle_status from public.v_invoice_status
           where id = '11111111-0000-4000-8000-000000000001'), 'part_paid',
  'which leaves the invoice part paid rather than open or settled');

select is((select balance_minor from public.v_invoice_status
           where id = '11111111-0000-4000-8000-000000000001'), 2500000::bigint,
  'with the remainder still outstanding');

-- The second instalment matches the REMAINING balance, not the original amount.
insert into public.payments (id, owner_id, payer_name, amount_minor, paid_on, utr, txn_status)
values ('22222222-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
        'Ravi Kumar', 2500000, current_date - 1, '500000000003', 'completed');

select is(public.propose_matches('payment', '22222222-0000-4000-8000-000000000003'), 1,
  'so the second instalment matches the balance and is proposed on its own');

-- ---------------------------------------------------------------------------
-- A payment dated before its invoice is the wrong pair, not an advance.
-- ---------------------------------------------------------------------------
delete from public.allocations where owner_id = :'owner';

insert into public.invoices (id, owner_id, customer_name, amount_minor, invoice_no, issued_on)
values ('11111111-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
        'Lakshmi Traders', 700000, 'INV-003', current_date);

insert into public.payments (id, owner_id, payer_name, amount_minor, paid_on, utr, txn_status)
values ('22222222-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001',
        'Lakshmi Traders', 700000, current_date - 60, '500000000004', 'completed');

select ok((select 'paid BEFORE the invoice was issued' = any(reasons)
           from public.match_candidates('payment', '22222222-0000-4000-8000-000000000004')
           where invoice_id = '11111111-0000-4000-8000-000000000003'),
  'a payment predating its invoice is flagged rather than quietly scored');

select is(public.propose_matches('payment', '22222222-0000-4000-8000-000000000004'), 0,
  'and is not proposed, however well the amount and name line up');

-- ---------------------------------------------------------------------------
-- A rejection sticks for that pair and only that pair.
-- ---------------------------------------------------------------------------
delete from public.allocations where owner_id = :'owner';
delete from public.payments
 where owner_id = :'owner' and id <> '22222222-0000-4000-8000-000000000001';
delete from public.invoices
 where owner_id = :'owner' and id <> '11111111-0000-4000-8000-000000000001';

select public.propose_matches('payment', '22222222-0000-4000-8000-000000000001');
select public.reject_allocations(
  array(select id from public.allocations where owner_id = :'owner'));

select is(public.propose_matches('payment', '22222222-0000-4000-8000-000000000001'), 0,
  'a rejected pairing is not proposed again — otherwise rejecting it would achieve nothing');

-- ---------------------------------------------------------------------------
-- A document the model could not read at all. The promise is that nothing is
-- ever lost, and an image with no row is lost even though the bytes survive.
-- ---------------------------------------------------------------------------
insert into public.raw_messages (id, owner_id, wa_group_id, wa_message_id, has_media, needs_classification)
values ('44444444-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'a-group@g.us', 'wamid.unreadable', true, true);

insert into public.document_files (owner_id, raw_message_id, storage_path, mime_type, size_bytes)
values ('a0000000-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000001/unclassified/44444444-0000-4000-8000-000000000001/original.jpg',
        'image/jpeg', 2048);

select is((select count(*)::int from public.v_unclassified_documents
           where owner_id = :'owner'), 1,
  'an unreadable image waits in a queue of its own rather than vanishing');

select throws_ok(
  $$insert into public.document_files (owner_id, invoice_id, raw_message_id, storage_path, mime_type, size_bytes)
    values ('a0000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001',
            '44444444-0000-4000-8000-000000000001', 'x', 'image/jpeg', 1)$$,
  '23514', null,
  'a file belongs to exactly one of an invoice, a payment, or an unread message'
);

-- classify_raw_message is SECURITY DEFINER, so it re-checks auth.uid() itself.
-- That means it must be called as a real session, not as superuser — and the
-- suite running as postgres is exactly the case the check is there to refuse.
select tests.authenticate_as('a0000000-0000-4000-8000-000000000001');

select lives_ok(
  $$select public.classify_raw_message('44444444-0000-4000-8000-000000000001', 'payment')$$,
  'the owner can say which side of the ledger it belongs to');

select is((select count(*)::int from public.v_unclassified_documents), 0,
  'and classifying it takes the image out of the queue');

select is((select txn_status::text from public.payments
           where source_message_id = '44444444-0000-4000-8000-000000000001'), 'pending',
  'created as pending, because nothing has been read off it yet and a payment that cannot be allocated is the safer default');

-- The three writes it makes, all of which must land. It was SECURITY INVOKER
-- once, and the two UPDATEs silently matched zero rows because raw_messages and
-- document_files are deliberately not writable by the owner — so the image stayed
-- in the queue after it had been classified, with no error anywhere.
select is((select needs_classification from public.raw_messages
           where id = '44444444-0000-4000-8000-000000000001'), false,
  'classifying clears the flag, so the item leaves the queue');

select is((select count(*)::int from public.document_files
           where raw_message_id = '44444444-0000-4000-8000-000000000001'), 0,
  'and moves the image off the message onto the document');

-- Bypassing RLS means the function is the only thing standing between one
-- owner's documents and another's.
select tests.as_service();
insert into public.raw_messages (id, owner_id, wa_group_id, wa_message_id, has_media, needs_classification)
values ('44444444-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
        'a-group@g.us', 'wamid.unreadable2', true, true);

select tests.authenticate_as('b0000000-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.classify_raw_message('44444444-0000-4000-8000-000000000002', 'invoice')$$,
  '42501', null,
  'and one owner cannot classify another owner''s document'
);
select tests.as_service();

select * from finish();
rollback;
