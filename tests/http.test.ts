import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError, createService } from '../src/service.js';
import { commands } from '../src/schema.js';
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';

const config = loadConfig({ DATABASE_URL:'postgres://test:test@localhost/test', PUBLIC_URL:'http://localhost:3000', OWNER_ID:'11111111-1111-4111-8111-111111111111', OWNER_KEY_HASH:createHash('sha256').update('test-owner-key').digest('hex'), COOKIE_KEY:'test-cookie-key-at-least-32-characters',OIDC_JWKS:'{"keys":[]}' });
const fakeService = {
  async command(action: keyof typeof commands, input: unknown) { return {action,input:commands[action].parse(input)}; },
  async query(input: unknown) { return {rows:[],input}; },
};
const app = createApp(config, async auth => { if(auth !== 'Bearer test') throw new AppError(401,'authentication_required'); return fakeService; });
const decode = (response: any) => response.text.startsWith('event:') ? JSON.parse(response.text.split('data: ')[1].trim()) : response.body;
const post = (path: string) => request(app).post(path).set('Host','localhost:3000');

test('HTTP rejects missing credentials and advertises OAuth resource metadata', async () => {
  const result = await post('/v1/query').send({collection:'games'});
  assert.equal(result.status,401); assert.match(result.headers['www-authenticate']!,/oauth-protected-resource\/mcp/);
});
test('metadata advertises the exact resource and provider', async () => {
  const result = await request(app).get('/.well-known/oauth-protected-resource/mcp').set('Host','localhost:3000');
  assert.equal(result.body.resource,'http://localhost:3000/mcp');
  assert.deepEqual(result.body.authorization_servers,['http://localhost:3000']);
});
test('HTTP rejects unknown fields, malformed JSON, oversized bodies and hostile origins', async () => {
  assert.equal((await post('/v1/commands/create_game').set('Authorization','Bearer test').send({title:'test',platform:'test',game_version:'test',owner_id:'attack'})).status,422);
  assert.equal((await post('/v1/query').type('json').send('{bad')).status,400);
  assert.equal((await post('/v1/query').send({body:'x'.repeat(110000)})).status,413);
  assert.equal((await post('/v1/query').set('Origin','https://attack.invalid').send({})).status,403);
  assert.equal((await request(app).get('/healthz').set('Host','attack.invalid')).status,403);
});
test('safe errors contain no token, original message or database details', async () => {
  const broken = createApp(config,async () => {throw new Error('secret token and private SQL');});
  const result = await request(broken).post('/v1/query').set('Host','localhost:3000').send({});
  assert.deepEqual(result.body,{error:'internal_error'});
});
test('MCP legacy initialize, discovery and tool call use the shared service', async () => {
  const rpc = (body: object) => post('/mcp').set('Authorization','Bearer test').set('Accept','application/json, text/event-stream').send(body);
  const initialized = await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});
  assert.equal(initialized.status,200); assert.equal(decode(initialized).result.serverInfo.name,'game-companion');
  const tools = await rpc({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  assert.equal(tools.status,200); assert.ok(decode(tools).result.tools.some((tool: any)=>tool.name==='submit_message'));
  const result = await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'create_game',arguments:{title:'Test fixture',platform:'test',game_version:'test'}}});
  assert.equal(JSON.parse(decode(result).result.content[0].text).action,'create_game');
});
test('MCP modern discovery uses the current protocol entry point', async () => {
  const result = await post('/mcp').set('Authorization','Bearer test').set('MCP-Protocol-Version','2026-07-28').set('Mcp-Method','tools/list').set('Accept','application/json, text/event-stream').send({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}});
  assert.equal(result.status,200); assert.ok(decode(result).result.tools.length>=10);
});
test('durable submit reports saved message when processing fails', async () => {
  const calls:string[]=[];
  const client={release(){},async query(sql:string,args?:any[]){if(sql.includes('gc_command')) {calls.push(args![0]);if(args![0]==='record_message')return {rows:[{result:{id:'saved-id',status:'pending'}}]};throw Object.assign(new Error('conflict'),{code:'40001'});}return {rows:[]};}};
  const pool={connect:async()=>client} as unknown as Pool;
  const result:any=await createService(pool,config.ownerId).command('submit_message',{profile_id:config.ownerId,idempotency_key:'22222222-2222-4222-8222-222222222222',body:'I am level 35',expected_revision:0});
  assert.deepEqual(calls,['record_message','process_message']);assert.equal(result.message.id,'saved-id');assert.equal(result.processing_error,'conflict');assert.equal(result.retryable,true);
});
test('public mode fails closed without HTTPS and generated credentials',()=>{
  assert.throws(()=>loadConfig({PUBLIC_URL:'http://public.example.com'}));
});
