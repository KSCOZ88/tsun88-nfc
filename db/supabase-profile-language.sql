begin;

alter table public.pet_profiles
  add column if not exists profile_language text
    check (profile_language in ('en', 'zh-Hant'));

-- Keep the existing RPC signature and its grants. Localize only the profile
-- just created by this call, without exposing edit tokens or order data.
create or replace function public.create_locked_pet_profile(p_profile jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_slug text;
  profile_locale text := p_profile->>'profile_language';
begin
  profile_slug := public.create_pet_profile(p_profile)->>'public_slug';
  if profile_locale in ('en', 'zh-Hant') then
    update public.pet_profiles
      set profile_language = profile_locale
      where public_slug = profile_slug;
  end if;
  return jsonb_build_object('public_slug', profile_slug);
end;
$$;

commit;
