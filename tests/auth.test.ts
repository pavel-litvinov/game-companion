import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Provider} from 'oidc-provider';
import {createAuthenticator} from '../src/auth.js';
import {loadConfig} from '../src/config.js';
const key='test-owner-key';
const config=loadConfig({DATABASE_URL:'postgres://test:test@localhost/test',PUBLIC_URL:'http://localhost:3000',OWNER_ID:'11111111-1111-4111-8111-111111111111',OWNER_KEY_HASH:createHash('sha256').update(key).digest('hex'),COOKIE_KEY:'test-cookie-key-at-least-32-characters',OIDC_JWKS:'{"keys":[]}'});
const service={command:async()=>({}),query:async()=>({})};
const valid={isExpired:false,accountId:config.ownerId,aud:config.publicUrl+'/mcp',scope:'companion',grantId:'grant'};
function auth(access:any=valid,grant:any={}) {return createAuthenticator(config,{AccessToken:{find:async()=>access},Grant:{find:async()=>grant}} as unknown as Provider,service);}
test('resource-bound owner OAuth tokens authenticate',async()=>{assert.equal(await auth()('Bearer opaque-token',true),service);});
test('missing tokens, expired tokens, other owners, resources and scopes fail closed',async()=>{
 await assert.rejects(auth()(undefined,true),/authentication_required/);
 for(const access of [null,{...valid,isExpired:true},{...valid,accountId:'other'},{...valid,aud:'https://other.invalid/mcp'},{...valid,scope:'openid'}]) await assert.rejects(auth(access)('Bearer opaque-token',true),/invalid_token/);
});
test('revoked grants invalidate access immediately',async()=>{await assert.rejects(auth(valid,null)('Bearer opaque-token',true),/revoked_token/);});
test('owner key is accepted by local REST but never as MCP OAuth token',async()=>{
 assert.equal(await auth(null)(`Bearer ${key}`,false),service);
 await assert.rejects(auth(null)(`Bearer ${key}`,true),/invalid_token/);
});
