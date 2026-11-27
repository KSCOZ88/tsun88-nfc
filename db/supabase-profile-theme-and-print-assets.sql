begin;

alter table public.pet_profiles
  add column base_variant text
    check (base_variant ~ '^(green|grey|orange|pink|red|white|yellow)[1-7]$');

-- Preserve the public profile RPC and its existing grants.
create or replace function public.create_locked_pet_profile(p_profile jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_slug text;
  profile_locale text := p_profile->>'profile_language';
  profile_variant text := p_profile->>'base_variant';
begin
  profile_slug := public.create_pet_profile(p_profile)->>'public_slug';
  if profile_locale in ('en', 'zh-Hant') or profile_variant ~ '^(green|grey|orange|pink|red|white|yellow)[1-7]$' then
    update public.pet_profiles
    set profile_language = case when profile_locale in ('en', 'zh-Hant') then profile_locale end,
        base_variant = case when profile_variant ~ '^(green|grey|orange|pink|red|white|yellow)[1-7]$' then profile_variant end
    where public_slug = profile_slug;
  end if;
  return jsonb_build_object('public_slug', profile_slug);
end;
$$;

-- Keep the existing full-tag review images and store the print layers separately.
alter table public.tsun_order_review_images
  drop constraint tsun_order_review_images_side_check,
  add constraint tsun_order_review_images_side_check
    check (side in ('front', 'back', 'print_front', 'print_back', 'print_dog')),
  add constraint tsun_order_review_images_print_size_check
    check (side in ('front', 'back') or octet_length(image_png) <= 300000);

commit;
