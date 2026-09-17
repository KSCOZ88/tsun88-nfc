-- TSUN88 × Lucky88：创建不可编辑的 NFC 宠物档案
-- 这个函数只把公开编号返回给客户，不返回数据库里的私密 edit_token。

create or replace function public.create_locked_pet_profile(p_profile jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created jsonb;
begin
  v_created := public.create_pet_profile(p_profile);
  return jsonb_build_object('public_slug', v_created ->> 'public_slug');
end;
$$;

revoke all on function public.create_locked_pet_profile(jsonb) from public;
grant execute on function public.create_locked_pet_profile(jsonb) to anon, authenticated;

comment on function public.create_locked_pet_profile(jsonb) is
'Creates a locked NFC pet profile and returns only its public slug. The edit token is never exposed to the customer.';
