-- Run once in the Supabase SQL Editor.
-- Existing published rows without a permanent Storage file are made drafts.

update public.products
set status = 'draft'
where status = 'published'
  and nullif(trim(file_path), '') is null;

alter table public.products
drop constraint if exists published_products_require_file_path;

alter table public.products
add constraint published_products_require_file_path
check (
  status <> 'published'
  or nullif(trim(file_path), '') is not null
);
