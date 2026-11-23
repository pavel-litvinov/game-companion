import {Pool} from 'pg';
import {readFile,readdir} from 'node:fs/promises';
const pool=new Pool({connectionString:process.env.ADMIN_DATABASE_URL});
const client=await pool.connect();
try {
  await client.query('select pg_advisory_lock(7382910)');
  await client.query('create table if not exists public.gc_migrations(version text primary key,applied_at timestamptz not null default now())');
  for(const file of (await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    if((await client.query('select 1 from public.gc_migrations where version=$1',[file])).rowCount) continue;
    await client.query('begin');
    try {await client.query(await readFile(`db/migrations/${file}`,'utf8'));await client.query('insert into public.gc_migrations(version) values($1)',[file]);await client.query('commit');}
    catch(error) {await client.query('rollback');throw error;}
  }
  const password=process.env.APP_DATABASE_PASSWORD;
  if(!password||!process.env.OWNER_ID) throw new Error('Missing local provisioning values');
  const literal="'"+password.replaceAll("'","''")+"'";
  await client.query("do $$ begin if not exists(select 1 from pg_roles where rolname='gc_app') then create role gc_app login; end if; end $$");
  await client.query(`alter role gc_app password ${literal}`);
  await client.query('grant authenticated to gc_app');
  await client.query('grant usage on schema gc_private to gc_app');
  await client.query('grant select,insert,update,delete on gc_private.oidc_artifacts to gc_app');
  await client.query('insert into gc_private.owners(id) values($1) on conflict do nothing',[process.env.OWNER_ID]);
  console.info('PostgreSQL migrations and local owner principal are ready.');
} finally {await client.query('select pg_advisory_unlock(7382910)');client.release();await pool.end();}
