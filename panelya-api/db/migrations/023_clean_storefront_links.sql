alter table collections
  alter column link_url set default 'urunler';

update collections
set link_url = regexp_replace(link_url, '\.html(?=([?#]|$))', '', 'g')
where link_url like '%.html%'
  and link_url !~* '^https?://';
