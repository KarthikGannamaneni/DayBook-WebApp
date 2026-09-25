-- ============================================================================
-- Bills bucket.
--
-- Supabase Storage rather than Cloudflare R2, which the design originally
-- chose. The reason is the hosting decision, not a change of mind about the
-- runway: the site is static files on GitHub Pages with no server, and R2
-- presigning needs a secret that a browser cannot hold. Supabase can mint a
-- signed URL under the user's own session, so the server disappears.
--
-- The cost is real and worth restating: 1 GB free instead of 10 GB, which at
-- the expected volume is about three weeks of runway rather than seven
-- months. See docs/p0-tech-design.md §5.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bills', 'bills', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Paths are {owner_id}/{project_id}/{expense_id}/{filename}, so the first
-- folder is the tenant. Everything below keys off that one fact.
create policy bills_select on storage.objects
  for select to authenticated
  using (bucket_id = 'bills' and (storage.foldername(name))[1] = auth.uid()::text);

create policy bills_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'bills' and (storage.foldername(name))[1] = auth.uid()::text);

-- Deliberately no insert policy for `authenticated`. Bills arrive from the
-- bot, which uses the service role; a browser has no reason to put a file in
-- this bucket, and denying it by default is one less thing to get wrong.
