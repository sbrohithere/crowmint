-- CrowMint product reviews, ownership-gated and Supabase free-tier compatible.
-- Run this once in the Supabase SQL editor after account-database.sql.

create extension if not exists pgcrypto;

create table if not exists public.product_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text not null check (char_length(trim(comment)) between 1 and 1000),
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, user_id)
);

create index if not exists product_reviews_product_id_idx on public.product_reviews(product_id, created_at desc);
create index if not exists product_reviews_user_id_idx on public.product_reviews(user_id);

create or replace function public.touch_product_review_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists product_reviews_touch_updated_at on public.product_reviews;
create trigger product_reviews_touch_updated_at
before update on public.product_reviews
for each row execute function public.touch_product_review_updated_at();

alter table public.product_reviews enable row level security;

drop policy if exists "Public reads product reviews" on public.product_reviews;
drop policy if exists "Owners create product reviews" on public.product_reviews;
drop policy if exists "Owners update own product reviews" on public.product_reviews;
drop policy if exists "Users delete own product reviews" on public.product_reviews;

create policy "Public reads product reviews" on public.product_reviews
for select to anon, authenticated
using (true);

create policy "Owners create product reviews" on public.product_reviews
for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.purchases purchase
    where purchase.user_id = auth.uid()
      and purchase.product_id = product_reviews.product_id
      and purchase.status = 'owned'
  )
);

create policy "Owners update own product reviews" on public.product_reviews
for update to authenticated
using (
  user_id = auth.uid()
  and exists (
    select 1 from public.purchases purchase
    where purchase.user_id = auth.uid()
      and purchase.product_id = product_reviews.product_id
      and purchase.status = 'owned'
  )
)
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.purchases purchase
    where purchase.user_id = auth.uid()
      and purchase.product_id = product_reviews.product_id
      and purchase.status = 'owned'
  )
);

create policy "Users delete own product reviews" on public.product_reviews
for delete to authenticated
using (user_id = auth.uid());
