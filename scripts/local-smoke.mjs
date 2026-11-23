import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
const env=Object.fromEntries((await readFile('.local/api.env','utf8')).trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
const key=(await readFile('.local/owner-key.txt','utf8')).trim();
const call=(path,input)=>new Promise((resolve,reject)=>{
 const req=http.request({host:'127.0.0.1',port:3000,path,method:'POST',headers:{Host:new URL(env.PUBLIC_URL).host,'Content-Type':'application/json',Authorization:`Bearer ${key}`}},res=>{
  let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try {const data=JSON.parse(body);assert.equal(res.statusCode,200,JSON.stringify(data));resolve(data);}catch(error){reject(error);}});
 });req.on('error',reject);req.end(JSON.stringify(input));
});
let game;
try {
 game=await call('/v1/commands/create_game',{title:'SMOKE TEST ONLY',platform:'test-only',game_version:'test-only'});
 const profile=await call('/v1/commands/create_profile',{game_id:game.id,name:'SMOKE TEST ONLY'});
 const input={profile_id:profile.id,idempotency_key:randomUUID(),body:'Мій рівень: 35.',expected_revision:0};
 const applied=await call('/v1/commands/submit_message',input);assert.equal(applied.profile.state.level,35);
 const replay=await call('/v1/commands/submit_message',input);assert.equal(replay.event.id,applied.event.id);
 const undo=await call('/v1/commands/undo',{event_id:applied.event.id,expected_revision:1});assert.deepEqual(undo.after_state,{});
 console.info('Plain PostgreSQL + Docker API + submit/retry/undo passed.');
} finally {
 if(game) {
  assert.match(game.id,/^[a-f0-9-]{36}$/);
  const sql=`begin; delete from public.gc_events where profile_id in(select id from public.gc_profiles where game_id='${game.id}') and kind='undo'; delete from public.gc_events where profile_id in(select id from public.gc_profiles where game_id='${game.id}'); delete from public.gc_messages where profile_id in(select id from public.gc_profiles where game_id='${game.id}'); delete from public.gc_profiles where game_id='${game.id}'; delete from public.gc_games where id='${game.id}'; commit;`;
  execFileSync('docker',['compose','exec','-T','db','psql','-U','postgres','-d','game_companion','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','pipe','pipe']});
  console.info('Removed all synthetic game/profile/message/event fixtures.');
 }
}
