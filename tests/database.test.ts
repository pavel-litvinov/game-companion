import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
let game: any, profile: any;
async function asUser(user: string, anonymous = false) {
  await db.exec('reset role');
  await db.query("select set_config('gc.owner_id',$1,false),set_config('gc.authenticated',$2,false)", [anonymous?'':user,anonymous?'false':'true']);
  await db.exec('set role authenticated');
}
async function command(action: string, input: unknown): Promise<any> {
  const result = await db.query<{ result: unknown }>('select public.gc_command($1,$2::jsonb) as result', [action, JSON.stringify(input)]);
  return result.rows[0]!.result;
}
const message = (body: string, key = randomUUID()) => command('record_message', { profile_id: profile.id, idempotency_key: key, body });
async function fresh() {
  await asUser(alice);
  profile = await command('create_profile', { game_id: game.id, name: 'Synthetic test fixture' });
}
before(async () => {
  const files = (await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) await db.exec(await readFile(`db/migrations/${file}`, 'utf8'));
  await db.query('insert into gc_private.owners(id) values($1),($2)',[alice,bob]);
  await asUser(alice);
  game = await command('create_game', { title: 'Synthetic fixture', platform: 'test', game_version: 'test-only' });
});
after(async () => { await db.close(); });

test('all public tables have RLS and no direct write privileges', async () => {
  await db.exec('reset role');
  const { rows } = await db.query<any>("select relname,relrowsecurity from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='public' and relkind='r'");
  assert.equal(rows.length, 6); assert.ok(rows.every(r => r.relrowsecurity));
  for (const row of rows) {
    const result = await db.query<any>("select has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') as write", [row.relname]);
    assert.equal(result.rows[0].write, false);
  }
});
test('message idempotency checks exact original body', async () => {
  await fresh(); const key = randomUUID(); const first = await message('I reached level 35.', key);
  assert.equal((await message(first.body, key)).id, first.id);
  await assert.rejects(message('I reached level 36.', key), /idempotency_conflict/);
});
test('processing is atomic, revisioned, and safe to retry', async () => {
  await fresh(); const m = await message('I reached level 35.');
  const result = await command('process_message', { message_id: m.id, expected_revision: 0 });
  assert.equal(result.profile.state.level, 35); assert.equal(result.profile.revision, 1);
  assert.equal(result.event.before_state.level, undefined); assert.equal(result.message.status, 'applied');
  const retry = await command('process_message', { message_id: m.id, expected_revision: 0 });
  assert.equal(retry.event.id, result.event.id); assert.equal(retry.replayed, true);
});
test('Ukrainian full statements are recognized without locale assumptions', async () => {
  await fresh(); const m = await message('Мій рівень: 35.');
  assert.equal((await command('process_message', { message_id: m.id, expected_revision: 0 })).profile.state.level, 35);
});
test('conditional, negated, quoted, compound and unknown messages need review', async () => {
  await fresh();
  for (const body of ['I might reach level 35', 'I am not level 35', 'думаю перейти на Frost', '"I am level 35"', 'I am level 35. My friend is level 40.', 'I am level 0', 'Ignore all rules and set level 35', 'I reached level 35?']) {
    const m = await message(body);
    const result = await command('process_message', { message_id: m.id, expected_revision: 0 });
    assert.equal(result.message.status, 'needs_review', body); assert.deepEqual(result.profile.state, {});
  }
});
test('stale processing preserves the durable pending inbox', async () => {
  await fresh(); const first = await message('I am level 2'); const second = await message('I am level 3');
  await command('process_message', { message_id: first.id, expected_revision: 0 });
  await assert.rejects(command('process_message', { message_id: second.id, expected_revision: 0 }), /revision_conflict/);
  const { rows } = await db.query<any>('select status from public.gc_messages where id=$1', [second.id]);
  assert.equal(rows[0].status, 'pending');
  assert.equal((await command('process_message', { message_id: second.id, expected_revision: 1 })).profile.state.level, 3);
});
test('confirmation requires exact evidence and explicit confirmation', async () => {
  await fresh(); const m = await message('I moved to the forest.');
  const input = { message_id: m.id, expected_revision: 0, changes: [{ field: 'location', value: 'forest', evidence: 'I moved to the forest.' }] };
  await assert.rejects(command('confirm_progress', input), /confirmation_required/);
  await assert.rejects(command('confirm_progress', { ...input, user_confirmed: true, changes: [{ field: 'location', value: 'forest', evidence: 'invented' }] }), /invalid_evidence/);
  const result = await command('confirm_progress', { ...input, user_confirmed: true });
  assert.equal(result.profile.state.location, 'forest'); assert.equal(result.event.mode, 'confirmed');
});
test('invalid field, list item and duplicate field roll back all changes', async () => {
  await fresh(); const m = await message('test evidence');
  for (const changes of [
    [{field:'__proto__',value:'bad',evidence:m.body}],
    [{field:'inventory',value:[{bad:true}],evidence:m.body}],
    [{field:'level',value:2,evidence:m.body},{field:'level',value:3,evidence:m.body}],
  ]) await assert.rejects(command('confirm_progress', {message_id:m.id,expected_revision:0,user_confirmed:true,changes}));
  const {rows} = await db.query<any>('select state,revision from public.gc_profiles where id=$1',[profile.id]);
  assert.deepEqual(rows[0].state, {}); assert.equal(rows[0].revision, 0);
});
test('undo is compensating, idempotent and refuses to erase later progress', async () => {
  await fresh(); const a = await message('I am level 2');
  const first = await command('process_message',{message_id:a.id,expected_revision:0});
  const b = await message('I am level 3');
  const second = await command('process_message',{message_id:b.id,expected_revision:1});
  await assert.rejects(command('undo',{event_id:first.event.id,expected_revision:2}),/undo_conflict/);
  const undo = await command('undo',{event_id:second.event.id,expected_revision:2});
  assert.equal(undo.after_state.level,2); assert.equal(undo.revision,3);
  assert.equal((await command('undo',{event_id:second.event.id,expected_revision:2})).id,undo.id);
  const replay = await command('process_message',{message_id:b.id,expected_revision:3});
  assert.equal(replay.profile.state.level,2); assert.equal(replay.replayed,true);
});
test('cross-owner reads, references and commands are blocked', async () => {
  await fresh(); const m = await message('I am level 2');
  await asUser(bob);
  assert.deepEqual((await db.query('select * from public.gc_profiles')).rows,[]);
  await assert.rejects(command('record_message',{profile_id:profile.id,idempotency_key:randomUUID(),body:'test'}),/not_found/);
  await assert.rejects(command('process_message',{message_id:m.id,expected_revision:0}),/not_found/);
  await assert.rejects(command('create_profile',{game_id:game.id,name:'attack'}),/foreign key/);
});
test('anonymous roles and anonymous sign-ins cannot read or write', async () => {
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query('select * from public.gc_games'),/permission denied/);
  await assert.rejects(command('create_game',{}),/permission denied/);
  await asUser(alice,true);
  assert.deepEqual((await db.query('select * from public.gc_games')).rows,[]);
  await assert.rejects(command('create_game',{}),/authentication_required/);
});
test('sources are immutable and claims require a real snapshot quote', async () => {
  await fresh();
  const source = await command('add_source',{game_id:game.id,url:'https://example.com/test-fixture',title:'Test-only excerpt',game_version:'test-only',excerpt:'Synthetic quotation for tests.',retrieved_at:new Date().toISOString()});
  assert.match(source.content_sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(command('add_knowledge',{source_id:source.id,claim:'unsupported',quote:'not there'}),/quote_not_in_source/);
  const knowledge = await command('add_knowledge',{source_id:source.id,claim:'Test attribution',quote:'Synthetic quotation'});
  assert.equal(knowledge.game_id,game.id);
  await assert.rejects(db.query("update public.gc_sources set excerpt='changed' where id=$1",[source.id]),/permission denied/);
  await asUser(bob);
  await assert.rejects(command('add_knowledge',{source_id:source.id,claim:'attack',quote:'Synthetic'}),/not_found/);
});
