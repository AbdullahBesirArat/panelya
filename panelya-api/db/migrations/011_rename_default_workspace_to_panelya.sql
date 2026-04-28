do $$
declare
  old_slug text := 'mave' || 'ran';
begin
  if exists (select 1 from organizations where slug = old_slug)
     and not exists (select 1 from organizations where slug = 'panelya') then
    update organizations
    set name = 'Panelya',
        slug = 'panelya',
        updated_at = now()
    where slug = old_slug;
  end if;
end $$;
