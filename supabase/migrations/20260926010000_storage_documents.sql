-- ============================================================================
-- The documents bucket, replacing `bills`.
--
-- Renamed because the name became a lie: this bucket now holds invoices AND
-- UPI payment screenshots, and "bills" reads as only the first kind. Nothing
-- is migrated because the old bucket is empty — there has never been a
-- production upload.
--
-- `bills` itself is NOT deleted here: Supabase refuses a direct delete from
-- storage.buckets, and routing a bucket teardown through the Storage API from
-- inside a migration is more machinery than an empty bucket is worth. Dropping
-- its policies leaves it unreadable by anyone but the service role, which is
-- inert. Remove it from the dashboard when convenient — see README.
--
-- Still Supabase Storage rather than Cloudflare R2, and still for the hosting
-- reason rather than a change of mind about runway: the site is static files
-- on GitHub Pages with no server, and R2 presigning needs a secret a browser
-- cannot hold. Supabase mints a signed URL under the user's own session.
--
-- The cost is unchanged and worth restating: 1 GB free instead of 10 GB, about
-- three weeks of runway at the expected volume rather than seven months. See
-- docs/p0-tech-design.md §5.
-- ============================================================================

drop policy if exists bills_select on storage.objects;
drop policy if exists bills_delete on storage.objects;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Paths are {owner_id}/{invoice|payment}/{doc_id}/{filename}, so the first
-- folder is the tenant. Everything below keys off that one fact.
create policy documents_select on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy documents_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

-- Deliberately no insert policy for `authenticated`. Documents arrive from the
-- bot, which uses the service role; a browser has no reason to put a file in
-- this bucket, and denying it by default is one less thing to get wrong.
