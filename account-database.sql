-- CrowMint accounts, ownership, order history, free claims, and RLS.
-- Run once in the Supabase SQL editor after the base products/categories schema exists.

create extension if not exists pgcrypto;

alter table public.products add column if not exists is_free boolean not null default false;
alter table public.products add column if not exists file_path text;
alter table public.products add column if not exists price numeric(12,2) not null default 0;
alter table public.products add column if not exists free_for_first_enabled boolean not null default false;
alter table public.products add column if not exists free_for_first_limit integer;
alter table public.products add column if not exists free_for_first_claimed_count integer not null default 0;
alter table public.products drop constraint if exists products_free_for_first_limit_check;
alter table public.products add constraint products_free_for_first_limit_check check (free_for_first_limit is null or free_for_first_limit > 0);
alter table public.products drop constraint if exists products_free_for_first_claimed_count_check;
alter table public.products add constraint products_free_for_first_claimed_count_check check (free_for_first_claimed_count >= 0);

update public.products
set price = coalesce(personal_price, price),
    is_free = coalesce(personal_price, 0) = 0 and coalesce(commercial_price, 0) = 0;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'file_url') then
    execute 'update public.products set file_path = file_url where (file_path is null or file_path = '''') and file_url is not null';
  end if;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Repair legacy profile data, then enforce one profile per Auth user.
delete from public.profiles
where id is null
   or not exists (select 1 from auth.users where auth.users.id = profiles.id);

delete from public.profiles older
using public.profiles newer
where older.id = newer.id
  and older.ctid < newer.ctid;

do $$
declare
  current_primary_key text;
  current_primary_key_definition text;
begin
  select conname, pg_get_constraintdef(oid)
  into current_primary_key, current_primary_key_definition
  from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and contype = 'p'
  limit 1;

  if current_primary_key is not null
     and current_primary_key_definition <> 'PRIMARY KEY (id)' then
    execute format('alter table public.profiles drop constraint %I', current_primary_key);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'p'
  ) then
    alter table public.profiles add constraint profiles_pkey primary key (id);
  end if;
end $$;

alter table public.profiles alter column id set not null;
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles
  add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  product_name text not null,
  product_image text,
  file_name text,
  file_path text not null,
  purchase_type text not null check (purchase_type in ('paid', 'free', 'free_first')),
  status text not null default 'owned' check (status = 'owned'),
  license_type text not null default 'personal' check (license_type in ('personal', 'commercial')),
  order_id text,
  claimed_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  customer_name text not null,
  customer_email text not null,
  product_id text not null,
  product_name text not null,
  license_type text not null check (license_type in ('personal', 'commercial')),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  purchase_date timestamptz not null default now(),
  payment_status text not null,
  created_at timestamptz not null default now()
);

alter table public.orders add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.orders add column if not exists payment_id text;
alter table public.orders add column if not exists failure_message text;
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check check (payment_status in ('free', 'free_claim', 'paid', 'success', 'failed', 'pending', 'refunded'));
create index if not exists purchases_user_id_idx on public.purchases(user_id, claimed_at desc);
create index if not exists account_orders_user_id_idx on public.orders(user_id, purchase_date desc);

create or replace function public.handle_new_crowmint_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), new.email)
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_crowmint on auth.users;
create trigger on_auth_user_created_crowmint
after insert or update of email on auth.users
for each row execute function public.handle_new_crowmint_user();

insert into public.profiles (id, full_name, email)
select id, coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name'), email
from auth.users
on conflict (id) do update set email = excluded.email, updated_at = now();

create or replace function public.claim_free_product(p_product_id text, p_license_type text default 'personal')
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  claim_user_id uuid := auth.uid();
  claimed_product public.products%rowtype;
  existing_purchase public.purchases%rowtype;
  saved_purchase public.purchases%rowtype;
  account_email text;
  account_name text;
  selected_price numeric;
  base_free boolean;
  offer_free boolean;
  generated_order_id text;
begin
  if claim_user_id is null then raise exception 'Login is required.'; end if;
  if p_license_type not in ('personal', 'commercial') then raise exception 'Invalid license type.'; end if;

  select * into claimed_product
  from public.products
  where id::text = p_product_id and status = 'published'
  for update;
  if not found then raise exception 'Product is not available.'; end if;

  select * into existing_purchase from public.purchases
  where user_id = claim_user_id and product_id = p_product_id;
  if found then return to_jsonb(existing_purchase); end if;

  selected_price := case when p_license_type = 'commercial' then claimed_product.commercial_price else claimed_product.personal_price end;
  base_free := coalesce(claimed_product.is_free, false) or coalesce(selected_price, claimed_product.price, 0) = 0;
  offer_free := coalesce(claimed_product.free_for_first_enabled, false)
    and coalesce(claimed_product.free_for_first_limit, 0) > 0
    and claimed_product.free_for_first_claimed_count < claimed_product.free_for_first_limit;
  if not base_free and not offer_free then raise exception 'Payment is required for this product.'; end if;
  if claimed_product.file_path is null or claimed_product.file_path = '' then
    raise exception 'Product file is not available. Please contact support.';
  end if;

  select email, coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', email)
  into account_email, account_name from auth.users where id = claim_user_id;
  generated_order_id := 'FREE-' || gen_random_uuid()::text;

  insert into public.purchases (user_id, product_id, product_name, product_image, file_name, file_path, purchase_type, license_type, order_id)
  values (claim_user_id, p_product_id, claimed_product.name, claimed_product.image_url, claimed_product.file_name, claimed_product.file_path,
    case when offer_free and not base_free then 'free_first' else 'free' end, p_license_type, generated_order_id)
  returning * into saved_purchase;

  if offer_free and not base_free then
    update public.products set free_for_first_claimed_count = free_for_first_claimed_count + 1 where id::text = p_product_id;
  end if;

  insert into public.orders (order_id, user_id, customer_name, customer_email, product_id, product_name, license_type, amount_paid, purchase_date, payment_status)
  values (generated_order_id, claim_user_id, account_name, account_email, p_product_id, claimed_product.name, p_license_type, 0, now(), 'free_claim');

  return to_jsonb(saved_purchase);
end;
$$;

revoke all on function public.claim_free_product(text, text) from public, anon;
grant execute on function public.claim_free_product(text, text) to authenticated;

alter table public.products enable row level security;
alter table public.categories enable row level security;
alter table public.profiles enable row level security;
alter table public.purchases enable row level security;
alter table public.orders enable row level security;

do $$ declare policy_row record; begin
  for policy_row in select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in ('products','categories','profiles','purchases','orders')
  loop execute format('drop policy if exists %I on %I.%I', policy_row.policyname, policy_row.schemaname, policy_row.tablename); end loop;
end $$;

create policy "Public reads published products" on public.products for select to anon, authenticated
using (status = 'published');
create policy "Admin reads all products" on public.products for select to authenticated
using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');
create policy "Admin inserts products" on public.products for insert to authenticated
with check (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');
create policy "Admin updates products" on public.products for update to authenticated
using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com') with check (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');
create policy "Admin deletes products" on public.products for delete to authenticated
using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');

create policy "Public reads categories" on public.categories for select to anon, authenticated using (true);
create policy "Admin inserts categories" on public.categories for insert to authenticated with check (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');
create policy "Admin updates categories" on public.categories for update to authenticated using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com') with check (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');
create policy "Admin deletes categories" on public.categories for delete to authenticated using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');

create policy "Users read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "Users create own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "Users update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "Admin reads profiles" on public.profiles for select to authenticated using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');
create policy "Users read own purchases" on public.purchases for select to authenticated using (user_id = auth.uid());
create policy "Admin reads purchases" on public.purchases for select to authenticated using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');
create policy "Users read own orders" on public.orders for select to authenticated using (user_id = auth.uid());
create policy "Admin reads orders" on public.orders for select to authenticated using (lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com');

drop policy if exists "CrowMint admin uploads product files" on storage.objects;
create policy "CrowMint admin uploads product files"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'product-files'
  and lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com'
);

drop policy if exists "CrowMint admin updates product files" on storage.objects;
create policy "CrowMint admin updates product files"
on storage.objects for update to authenticated
using (
  bucket_id = 'product-files'
  and lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com'
)
with check (
  bucket_id = 'product-files'
  and lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com'
);

drop policy if exists "CrowMint admin deletes product files" on storage.objects;
create policy "CrowMint admin deletes product files"
on storage.objects for delete to authenticated
using (
  bucket_id = 'product-files'
  and lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com'
);

drop policy if exists "CrowMint delivers published free product files" on storage.objects;
drop policy if exists "CrowMint account owners download product files" on storage.objects;
drop policy if exists "CrowMint direct free and owned downloads" on storage.objects;
create policy "CrowMint direct free and owned downloads" on storage.objects for select to anon, authenticated
using (
  bucket_id = 'product-files' and (
    lower(auth.jwt() ->> 'email') = 'kandhamalaivasann@gmail.com'
    or exists (
      select 1 from public.products product
      where product.file_path = storage.objects.name
        and product.status = 'published'
        and (
          product.is_free = true
          or product.personal_price = 0
          or product.commercial_price = 0
        )
    )
    or exists (
      select 1 from public.purchases purchase
      where purchase.user_id = auth.uid() and purchase.file_path = storage.objects.name and purchase.status = 'owned'
    )
  )
);
