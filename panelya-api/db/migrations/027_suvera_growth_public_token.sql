update organizations
set public_access_token = encode(gen_random_bytes(32), 'hex'),
    updated_at = now()
where coalesce(public_access_token, '') = '';

update organizations
set plan = 'growth',
    updated_at = now()
where slug = 'suvera'
  and plan <> 'growth';
