do $$ begin if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
create schema if not exists gc_private;
create table gc_private.owners(id uuid primary key, created_at timestamptz not null default now());
create function gc_private.owner_id() returns uuid language sql stable set search_path='' as $$ select nullif(current_setting('gc.owner_id',true),'')::uuid $$;
revoke all on function gc_private.owner_id() from public;
grant execute on function gc_private.owner_id() to authenticated;
-- No seed data. All writes are authenticated, owner-bound commands.
create schema if not exists gc_private;
revoke all on schema gc_private from public, anon;
grant usage on schema gc_private to authenticated;

create table public.gc_games (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references gc_private.owners(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  platform text not null check (length(btrim(platform)) between 1 and 100),
  game_version text not null check (length(btrim(game_version)) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);
create table public.gc_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references gc_private.owners(id) on delete cascade,
  game_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  state jsonb not null default '{}' check (jsonb_typeof(state) = 'object'),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (game_id, owner_id) references public.gc_games(id, owner_id)
);
create table public.gc_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references gc_private.owners(id) on delete cascade,
  profile_id uuid not null,
  idempotency_key uuid not null,
  body text not null check (length(btrim(body)) between 1 and 10000),
  status text not null default 'pending' check (status in ('pending','needs_review','applied')),
  created_at timestamptz not null default now(),
  unique (id, profile_id, owner_id),
  unique (profile_id, owner_id, idempotency_key),
  foreign key (profile_id, owner_id) references public.gc_profiles(id, owner_id)
);
create table public.gc_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references gc_private.owners(id) on delete cascade,
  profile_id uuid not null,
  message_id uuid,
  kind text not null check (kind in ('progress','undo')),
  mode text not null check (mode in ('automatic','confirmed','undo')),
  changes jsonb not null,
  before_state jsonb not null,
  after_state jsonb not null,
  revision bigint not null,
  reverses_event_id uuid unique references public.gc_events(id),
  created_at timestamptz not null default now(),
  unique (profile_id, revision),
  unique (message_id),
  foreign key (profile_id, owner_id) references public.gc_profiles(id, owner_id),
  foreign key (message_id, profile_id, owner_id) references public.gc_messages(id, profile_id, owner_id)
);
create table public.gc_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references gc_private.owners(id) on delete cascade,
  game_id uuid not null,
  url text not null check (url ~ '^https://[^/@[:space:]]+(/|$)' and length(url) <= 2048),
  title text not null check (length(btrim(title)) between 1 and 200),
  game_version text not null check (length(btrim(game_version)) between 1 and 100),
  excerpt text not null check (length(btrim(excerpt)) between 1 and 50000),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  retrieved_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (id, game_id, owner_id),
  foreign key (game_id, owner_id) references public.gc_games(id, owner_id)
);
create table public.gc_knowledge (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references gc_private.owners(id) on delete cascade,
  game_id uuid not null,
  source_id uuid not null,
  claim text not null check (length(btrim(claim)) between 1 and 4000),
  quote text not null check (length(btrim(quote)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (source_id, game_id, owner_id) references public.gc_sources(id, game_id, owner_id)
);

create index gc_games_owner on public.gc_games(owner_id);
create index gc_profiles_game_owner on public.gc_profiles(game_id, owner_id);
create index gc_profiles_owner on public.gc_profiles(owner_id);
create index gc_messages_owner on public.gc_messages(owner_id);
create index gc_events_owner on public.gc_events(owner_id);
create index gc_events_message on public.gc_events(message_id, profile_id, owner_id);
create index gc_sources_owner on public.gc_sources(owner_id);
create index gc_sources_game_owner on public.gc_sources(game_id, owner_id);
create index gc_knowledge_owner on public.gc_knowledge(owner_id);
create index gc_knowledge_source on public.gc_knowledge(source_id, game_id, owner_id);

-- Read-only tables for callers. The private command function is the sole write path.
do $$
declare t text;
begin
  foreach t in array array['gc_games','gc_profiles','gc_messages','gc_events','gc_sources','gc_knowledge'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select gc_private.owner_id()) = owner_id)',t);
  end loop;
end $$;

-- Full-message grammar only; unknown, conditional, quoted and negated messages
-- deliberately return NULL. Locale-independent explicit Ukrainian case variants.
create function gc_private.extract_level(body text) returns integer
language plpgsql immutable set search_path = '' as $$
declare m text[];
begin
  m := regexp_match(btrim(body), '^(?:[Ii] am level |[Ii] reached level |[Mm]y level is |[Мм]ій рівень: |[Яя] досяг рівня )([0-9]{1,4})[.!]?$');
  if m is null or m[1]::integer not between 1 and 9999 then return null; end if;
  return m[1]::integer;
end $$;
revoke all on function gc_private.extract_level(text) from public, anon, authenticated;

-- SECURITY DEFINER is confined to an unexposed schema so clients cannot edit
-- journal/state tables directly. Every path explicitly checks gc_private.owner_id() and owner.
create function gc_private.command(action text, input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := gc_private.owner_id(); p public.gc_profiles; m public.gc_messages;
  e public.gc_events; s public.gc_sources; result jsonb;
  changes jsonb; change jsonb; next_state jsonb; field text; lvl integer;
begin
  if uid is null or coalesce(current_setting('gc.authenticated',true),'') <> 'true'
     or false then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if jsonb_typeof(input) is distinct from 'object' or octet_length(input::text) > 100000 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if action = 'create_game' then
    insert into public.gc_games(owner_id,title,platform,game_version)
    values(uid,input->>'title',input->>'platform',input->>'game_version') returning to_jsonb(gc_games.*) into result;
  elsif action = 'create_profile' then
    insert into public.gc_profiles(owner_id,game_id,name)
    values(uid,(input->>'game_id')::uuid,input->>'name') returning to_jsonb(gc_profiles.*) into result;
    -- Composite foreign key guarantees the referenced game belongs to uid.
  elsif action = 'record_message' then
    select * into p from public.gc_profiles where id=(input->>'profile_id')::uuid and owner_id=uid for update;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    select * into m from public.gc_messages where profile_id=p.id and owner_id=uid and idempotency_key=(input->>'idempotency_key')::uuid;
    if found then
      if m.body is distinct from input->>'body' then raise exception 'idempotency_conflict' using errcode='23505'; end if;
      return to_jsonb(m);
    end if;
    insert into public.gc_messages(owner_id,profile_id,idempotency_key,body)
    values(uid,p.id,(input->>'idempotency_key')::uuid,input->>'body') returning to_jsonb(gc_messages.*) into result;
  elsif action in ('process_message','confirm_progress') then
    -- Always lock profile before message, including during simultaneous retries.
    select * into m from public.gc_messages where id=(input->>'message_id')::uuid and owner_id=uid;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    select * into p from public.gc_profiles where id=m.profile_id and owner_id=uid for update;
    select * into m from public.gc_messages where id=m.id and owner_id=uid for update;
    if m.status='applied' then
      select * into e from public.gc_events where message_id=m.id and owner_id=uid;
      return jsonb_build_object('message',to_jsonb(m),'event',to_jsonb(e),'profile',to_jsonb(p),'replayed',true);
    end if;
    if action='process_message' then
      lvl := gc_private.extract_level(m.body);
      if lvl is null then
        update public.gc_messages set status='needs_review' where id=m.id returning * into m;
        return jsonb_build_object('message',to_jsonb(m),'profile',to_jsonb(p));
      end if;
      changes := jsonb_build_array(jsonb_build_object('field','level','value',lvl,'evidence',m.body));
    else
      changes := input->'changes';
      if input->>'user_confirmed' is distinct from 'true' then raise exception 'confirmation_required' using errcode='22023'; end if;
    end if;
    if (input->>'expected_revision') is null or (input->>'expected_revision')::bigint <> p.revision then
      raise exception 'revision_conflict' using errcode='40001';
    end if;
    if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) not between 1 and 20 then
      raise exception 'invalid_changes' using errcode='22023';
    end if;
    next_state := p.state;
    for change in select value from jsonb_array_elements(changes) loop
      field := change->>'field';
      if field is null or field not in ('level','location','character','inventory','goals','notes')
         or not (change ? 'value') or change->'value'='null'::jsonb
         or coalesce(length(btrim(change->>'evidence')),0)=0
         or position(change->>'evidence' in m.body)=0 then
        raise exception 'invalid_evidence_or_field' using errcode='22023';
      end if;
      if field='level' and (jsonb_typeof(change->'value') <> 'number' or (change->>'value') !~ '^[0-9]{1,4}$' or (change->>'value')::integer not between 1 and 9999) then
        raise exception 'invalid_level' using errcode='22023';
      end if;
      if field in ('location','character','notes') and (jsonb_typeof(change->'value') <> 'string' or length(change->>'value') not between 1 and 4000) then
        raise exception 'invalid_text_state' using errcode='22023';
      end if;
      if field in ('inventory','goals') and (jsonb_typeof(change->'value') <> 'array' or jsonb_array_length(change->'value')>100) then
        raise exception 'invalid_list_state' using errcode='22023';
      end if;
      if field in ('inventory','goals') and exists (select 1 from jsonb_array_elements(change->'value') x where jsonb_typeof(x) <> 'string' or length(x#>>'{}') not between 1 and 200) then
        raise exception 'invalid_list_item' using errcode='22023';
      end if;
      next_state := jsonb_set(next_state,array[field],change->'value',true);
    end loop;
    if (select count(*) <> count(distinct value->>'field') from jsonb_array_elements(changes)) then
      raise exception 'duplicate_field' using errcode='22023';
    end if;
    insert into public.gc_events(owner_id,profile_id,message_id,kind,mode,changes,before_state,after_state,revision)
    values(uid,p.id,m.id,'progress',case when action='process_message' then 'automatic' else 'confirmed' end,changes,p.state,next_state,p.revision+1) returning * into e;
    update public.gc_profiles set state=next_state,revision=revision+1 where id=p.id returning * into p;
    update public.gc_messages set status='applied' where id=m.id returning * into m;
    result := jsonb_build_object('message',to_jsonb(m),'event',to_jsonb(e),'profile',to_jsonb(p),'replayed',false);
  elsif action='undo' then
    select * into e from public.gc_events where id=(input->>'event_id')::uuid and owner_id=uid;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    select * into p from public.gc_profiles where id=e.profile_id and owner_id=uid for update;
    select to_jsonb(gc_events.*) into result from public.gc_events where reverses_event_id=e.id and owner_id=uid;
    if found then return result; end if;
    if e.kind <> 'progress' or e.revision <> p.revision or (input->>'expected_revision') is null or (input->>'expected_revision')::bigint <> p.revision then
      raise exception 'undo_conflict' using errcode='40001';
    end if;
    insert into public.gc_events(owner_id,profile_id,kind,mode,changes,before_state,after_state,revision,reverses_event_id)
    values(uid,p.id,'undo','undo','[]',p.state,e.before_state,p.revision+1,e.id) returning to_jsonb(gc_events.*) into result;
    update public.gc_profiles set state=e.before_state,revision=revision+1 where id=p.id;
  elsif action='add_source' then
    if (input->>'retrieved_at')::timestamptz > now()+interval '5 minutes' then raise exception 'future_source' using errcode='22023'; end if;
    insert into public.gc_sources(owner_id,game_id,url,title,game_version,excerpt,content_sha256,retrieved_at)
    values(uid,(input->>'game_id')::uuid,input->>'url',input->>'title',input->>'game_version',input->>'excerpt',encode(sha256(convert_to(input->>'excerpt','UTF8')),'hex'),(input->>'retrieved_at')::timestamptz)
    returning to_jsonb(gc_sources.*) into result;
  elsif action='add_knowledge' then
    select * into s from public.gc_sources where id=(input->>'source_id')::uuid and owner_id=uid;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    if coalesce(length(btrim(input->>'quote')),0)=0 or position(input->>'quote' in s.excerpt)=0 then
      raise exception 'quote_not_in_source' using errcode='22023';
    end if;
    insert into public.gc_knowledge(owner_id,game_id,source_id,claim,quote)
    values(uid,s.game_id,s.id,input->>'claim',input->>'quote') returning to_jsonb(gc_knowledge.*) into result;
  else raise exception 'unknown_command' using errcode='22023';
  end if;
  return result;
end $$;
revoke all on function gc_private.command(text,jsonb) from public, anon;
grant execute on function gc_private.command(text,jsonb) to authenticated;

create function public.gc_command(action text, input jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select gc_private.command(action,input); $$;
revoke all on function public.gc_command(text,jsonb) from public, anon;
grant execute on function public.gc_command(text,jsonb) to authenticated;

