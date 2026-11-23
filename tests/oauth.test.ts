import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {createHash,generateKeyPairSync,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.js';
import {createOAuth} from '../src/oauth.js';
import {createApp} from '../src/app.js';
import {createAuthenticator} from '../src/auth.js';
import {adapterFactory} from '../src/oidc-adapter.js';

test('OAuth PKCE, resource binding, refresh rotation, replay protection and revocation work end-to-end',async()=>{
  const db=new PGlite();
  try {
    await db.exec('create schema gc_private');await db.exec(await readFile('db/migrations/003_oauth.sql','utf8'));
    const pool={query:async(sql:string,params:unknown[])=>{const result=await db.query(sql,params);return {...result,rowCount:result.affectedRows};}} as unknown as Pool;
    const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'});
    Object.assign(key,{kid:'test-only',alg:'RS256',use:'sig'});
    const ownerKey='test-only-local-owner-key';
    const config=loadConfig({DATABASE_URL:'postgres://test:test@localhost/test',PUBLIC_URL:'http://localhost:3000',OWNER_ID:'11111111-1111-4111-8111-111111111111',OWNER_KEY_HASH:createHash('sha256').update(ownerKey).digest('hex'),COOKIE_KEY:'test-cookie-key-at-least-32-characters',OIDC_JWKS:JSON.stringify({keys:[key]})});
    const provider=createOAuth(config,pool);
    const service={command:async()=>({}),query:async()=>({rows:[]})};
    const app=createApp(config,createAuthenticator(config,provider,service),provider);
    const agent=request.agent(app);
    const get=(path:string)=>agent.get(path).set('Host','localhost:3000');
    const post=(path:string)=>agent.post(path).set('Host','localhost:3000');
    const registered=await post('/reg').send({client_name:'Synthetic OAuth test client',redirect_uris:['https://client.example/callback'],response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'});
    assert.equal(registered.status,201,JSON.stringify(registered.body));
    const clientId=registered.body.client_id;
    const verifier=randomBytes(32).toString('base64url');
    const challenge=createHash('sha256').update(verifier).digest('base64url');
    const resource=config.publicUrl+'/mcp';
    const params=new URLSearchParams({client_id:clientId,redirect_uri:'https://client.example/callback',response_type:'code',scope:'companion offline_access',resource,code_challenge:challenge,code_challenge_method:'S256',state:'test-only-state'});
    const noPkce=new URLSearchParams(params);noPkce.delete('code_challenge');noPkce.delete('code_challenge_method');
    const missingProof=await get('/auth?'+noPkce);
    assert.ok(missingProof.status===400||new URL(missingProof.headers.location!,config.publicUrl).searchParams.has('error'),'PKCE is mandatory');
    let response=await get('/auth?'+params);
    let code:string|null=null;
    for(let i=0;i<12&&!code;i++) {
      const location=response.headers.location;
      assert.ok(location,`OAuth step ${i}: ${response.status} ${response.text}`);
      const target=new URL(location,config.publicUrl);
      if(target.origin==='https://client.example') {code=target.searchParams.get('code');assert.equal(target.searchParams.get('state'),'test-only-state');break;}
      assert.equal(target.origin,config.publicUrl);
      response=await get(target.pathname+target.search);
      if(target.pathname.startsWith('/interaction/')) {
        assert.equal(response.status,200,response.text);
        const csrf=/name="csrf" value="([a-f0-9]+)"/.exec(response.text)?.[1];assert.ok(csrf);
        const invalid=await post(target.pathname).set('Origin','null').type('form').send({csrf:'invalid',owner_key:ownerKey,decision:'allow'});
        assert.equal(invalid.status,403,'Opaque origins never bypass the interaction CSRF token');
        response=await post(target.pathname).set('Origin','null').type('form').send({csrf,owner_key:ownerKey,decision:'allow'});
      }
    }
    assert.ok(code,'Authorization code must be issued after owner login and consent');
    const exchange={grant_type:'authorization_code',client_id:clientId,code,redirect_uri:'https://client.example/callback',code_verifier:verifier,resource};
    const tokens=await post('/token').type('form').send(exchange);
    assert.equal(tokens.status,200,JSON.stringify(tokens.body));assert.ok(tokens.body.access_token);assert.ok(tokens.body.refresh_token);
    const bearer=tokens.body.access_token;
    const tool=await post('/mcp').set('Authorization',`Bearer ${bearer}`).set('Accept','application/json, text/event-stream').send({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
    assert.equal(tool.status,200,JSON.stringify(tool.body));assert.ok(tool.body.result.tools.length>=10);
    const refreshed=await post('/token').type('form').send({grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.body.refresh_token,resource});
    assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));assert.notEqual(refreshed.body.refresh_token,tokens.body.refresh_token);
    const access=await provider.AccessToken.find(refreshed.body.access_token);assert.ok(access?.grantId);
    const grant=await provider.Grant.find(access.grantId);assert.ok(grant);await grant.destroy();
    const denied=await post('/mcp').set('Authorization',`Bearer ${refreshed.body.access_token}`).send({jsonrpc:'2.0',id:2,method:'tools/list'});
    assert.equal(denied.status,401);
    const replay=await post('/token').type('form').send(exchange);assert.equal(replay.status,400);
    // A fresh provider instance reads persisted registrations from PostgreSQL.
    assert.ok(await createOAuth(config,pool).Client.find(clientId));
    const Adapter=adapterFactory(pool);const adapter=new Adapter('AuthorizationCode');
    await adapter.upsert('single-use',{test:true},60);await adapter.consume('single-use');
    await assert.rejects(adapter.consume('single-use'),/invalid_grant/);
  } finally {await db.close();}
});
