-- CrowMint orders, licenses, and downloads.
-- Run in the Supabase SQL editor for the CrowMint project.
-- Order creation must happen only from a trusted payment-verification backend
-- using the service-role key. Never expose the service-role key in this website.

create extension if not exists pgcrypto;

alter table if exists public.products add column if not exists file_path text;

-- Public catalog visibility and authenticated admin management.
alter table public.products enable row level security;
alter table public.categories enable row level security;

-- Remove any earlier dashboard-generated policies so these are the only
-- product/category access rules in effect.
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('products', 'categories')
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      existing_policy.policyname,
      existing_policy.tablename
    );
  end loop;
end
$$;

drop policy if exists "CrowMint public reads published products" on public.products;
create policy "CrowMint public reads published products" on public.products
for select to anon, authenticated
using (status = 'published');

drop policy if exists "CrowMint admin reads all products" on public.products;
create policy "CrowMint admin reads all products" on public.products
for select to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin creates products" on public.products;
create policy "CrowMint admin creates products" on public.products
for insert to authenticated
with check (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin updates products" on public.products;
create policy "CrowMint admin updates products" on public.products
for update to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'))
with check (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin deletes products" on public.products;
create policy "CrowMint admin deletes products" on public.products
for delete to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint public reads categories" on public.categories;
create policy "CrowMint public reads categories" on public.categories
for select to anon, authenticated using (true);

drop policy if exists "CrowMint admin creates categories" on public.categories;
create policy "CrowMint admin creates categories" on public.categories
for insert to authenticated
with check (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin updates categories" on public.categories;
create policy "CrowMint admin updates categories" on public.categories
for update to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'))
with check (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin deletes categories" on public.categories;
create policy "CrowMint admin deletes categories" on public.categories
for delete to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

insert into storage.buckets (id, name, public)
values ('product-files', 'product-files', false)
on conflict (id) do update set public = false;

drop policy if exists "CrowMint admin uploads product files" on storage.objects;
create policy "CrowMint admin uploads product files" on storage.objects
for insert to authenticated
with check (bucket_id = 'product-files' and lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin updates product files" on storage.objects;
create policy "CrowMint admin updates product files" on storage.objects
for update to authenticated
using (bucket_id = 'product-files' and lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'))
with check (bucket_id = 'product-files' and lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin deletes product files" on storage.objects;
create policy "CrowMint admin deletes product files" on storage.objects
for delete to authenticated
using (bucket_id = 'product-files' and lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

-- Allow the browser to create signed URLs only for published products with a
-- free license option. Products with no free option remain private.
drop policy if exists "CrowMint delivers published free product files" on storage.objects;
create policy "CrowMint delivers published free product files" on storage.objects
for select to anon, authenticated
using (
  bucket_id = 'product-files'
  and (
    lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com')
    or exists (
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
  )
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  customer_name text not null,
  customer_email text not null,
  product_id text not null,
  product_name text not null,
  license_type text not null check (license_type in ('personal', 'commercial')),
  amount_paid numeric(12,2) not null check (amount_paid >= 0),
  purchase_date timestamptz not null default now(),
  payment_status text not null check (payment_status in ('free', 'paid', 'refunded', 'failed', 'pending')),
  created_at timestamptz not null default now()
);

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check check (payment_status in ('free', 'paid', 'refunded', 'failed', 'pending'));

create index if not exists orders_order_id_idx on public.orders(order_id);
create index if not exists orders_purchase_date_idx on public.orders(purchase_date desc);
create index if not exists orders_customer_email_idx on public.orders(customer_email);

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  order_row_id uuid not null unique references public.orders(id) on delete cascade,
  order_id text not null,
  product_id text not null,
  customer_email text not null,
  license_type text not null check (license_type in ('personal', 'commercial')),
  status text not null default 'active' check (status in ('active', 'revoked', 'refunded')),
  issued_at timestamptz not null default now()
);

create table if not exists public.downloads (
  id uuid primary key default gen_random_uuid(),
  order_row_id uuid not null unique references public.orders(id) on delete cascade,
  order_id text not null,
  product_id text not null,
  download_count integer not null default 0 check (download_count >= 0),
  max_downloads integer not null default 5 check (max_downloads > 0),
  last_downloaded_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;
alter table public.licenses enable row level security;
alter table public.downloads enable row level security;

drop policy if exists "CrowMint admin reads orders" on public.orders;
create policy "CrowMint admin reads orders" on public.orders
for select to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin reads licenses" on public.licenses;
create policy "CrowMint admin reads licenses" on public.licenses
for select to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

drop policy if exists "CrowMint admin reads downloads" on public.downloads;
create policy "CrowMint admin reads downloads" on public.downloads
for select to authenticated
using (lower(auth.jwt() ->> 'email') = lower('kandhamalaivasann@gmail.com'));

-- No browser INSERT/UPDATE/DELETE policies are intentionally created.
-- A verified payment backend using the Supabase service role writes these rows.
