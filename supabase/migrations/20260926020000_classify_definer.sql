-- ============================================================================
-- classify_raw_message must be SECURITY DEFINER.
--
-- It was security invoker, and two of the three writes it makes silently did
-- nothing. Observed in production: the owner classified an unreadable image as
-- an invoice, the invoice was created, and the image stayed in the unclassified
-- queue as though nothing had happened.
--
-- The cause is that the function writes to tables the owner is deliberately not
-- allowed to write:
--
--   raw_messages    — select only, because the bot writes inbound messages and a
--                     client forging one could invent a source for a document
--                     that never arrived.
--   document_files  — select and delete only, for the same reason.
--
-- Under RLS an UPDATE with no matching policy does not raise; it matches zero
-- rows. So `insert into invoices` succeeded (that table the owner does own) and
-- both UPDATEs were no-ops. Half a transaction, no error, inconsistent state.
--
-- SECURITY DEFINER fixes the writes and creates the obligation that goes with
-- it: the function now bypasses RLS, so it must re-check the caller's identity
-- itself rather than trusting that a policy did. That check is the whole reason
-- this migration ships with a test.
-- ============================================================================

create or replace function public.classify_raw_message(
  p_raw_message_id uuid, p_kind public.doc_kind
)
returns uuid
language plpgsql
security definer
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

  -- SECURITY DEFINER bypasses row-level security, so the policy that would
  -- normally scope this is not running. Re-check by hand, or this function is a
  -- way for any signed-in user to classify anybody's documents.
  if v_owner is distinct from auth.uid() then
    raise exception 'that message belongs to another owner' using errcode = '42501';
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

revoke all on function public.classify_raw_message(uuid, public.doc_kind) from public, anon;
grant execute on function public.classify_raw_message(uuid, public.doc_kind) to authenticated, service_role;
