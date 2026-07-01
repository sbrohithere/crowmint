-- CrowMint direct free downloads (no Edge Function required).
-- Run once in the Supabase SQL editor.

alter table public.products add column if not exists file_path text;

insert into storage.buckets (id, name, public)
values ('product-files', 'product-files', false)
on conflict (id) do update set public = false;

drop policy if exists "CrowMint delivers published free product files" on storage.objects;
drop policy if exists "CrowMint direct free and owned downloads" on storage.objects;

create policy "CrowMint delivers published free product files"
on storage.objects
for select
to anon, authenticated
using (
  bucket_id = 'product-files'
  and exists (
    select 1
    from public.products product
    where product.file_path = storage.objects.name
      and product.status = 'published'
      and (
        product.is_free = true
        or product.personal_price = 0
        or product.commercial_price = 0
      )
  )
);
