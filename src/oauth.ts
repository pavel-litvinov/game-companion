import {Provider,errors,type Configuration} from 'oidc-provider';
import type {Pool} from 'pg';
import type {Express} from 'express';
import express from 'express';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {adapterFactory} from './oidc-adapter.js';
import type {Config} from './config.js';
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function createOAuth(config:Config,pool:Pool) {
  const resource=config.publicUrl+'/mcp';
  const settings:Configuration={
    adapter:adapterFactory(pool),cookies:{keys:[config.cookieKey],short:{sameSite:'lax'},long:{sameSite:'lax'}},
    jwks:JSON.parse(config.jwks),clients:[],scopes:['openid','offline_access','companion'],responseTypes:['code'],
    pkce:{required:()=>true},rotateRefreshToken:true,
    // Companion is an explicitly consented OAuth API scope. Refresh access is
    // bound to that grant and does not depend on a browser's login session.
    issueRefreshToken:(_ctx,client,source)=>client.grantTypeAllowed('refresh_token')&&source.scopes.has('companion'),
    expiresWithSession:()=>false,
    features:{devInteractions:{enabled:false},registration:{enabled:true,initialAccessToken:false},revocation:{enabled:true},
      resourceIndicators:{enabled:true,defaultResource:()=>resource,useGrantedResource:()=>true,
        getResourceServerInfo:(_ctx,target)=>{if(target!==resource) throw new errors.InvalidTarget();return {scope:'companion',audience:resource,accessTokenTTL:3600};}}},
    interactions:{url:(_ctx,interaction)=>`/interaction/${interaction.uid}`},
    findAccount:async (_ctx,id)=>id===config.ownerId?{accountId:id,claims:async()=>({sub:id})}:undefined,
    ttl:{AccessToken:3600,AuthorizationCode:120,RefreshToken:30*24*3600,Session:24*3600,Interaction:600,Grant:30*24*3600},
  };
  const provider=new Provider(config.publicUrl,settings);
  // The application itself verifies the Host header. Its only published port
  // is loopback and the configured local Cloudflare process offloads HTTPS.
  provider.proxy=true;
  provider.on('server_error',()=>console.error('OAuth provider request failed'));
  return provider;
}
export function installOAuthRoutes(app:Express,config:Config,provider:Provider) {
  const csrf=(uid:string)=>createHmac('sha256',config.cookieKey).update(uid).digest('hex');
  app.get('/interaction/:uid',async(req,res)=>{
    const details=await provider.interactionDetails(req,res);
    const client=await provider.Client.find(String(details.params.client_id));
    const login=details.prompt.name==='login';
    res.type('html').send(`<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Game Companion — доступ</title><h1>Game Companion</h1><p>Локальний PostgreSQL. Email та сторонній акаунт не потрібні.</p><h2>${login?'Вхід власника':'Дозвіл для плагіна'}</h2><p>Клієнт: ${escape(client?.clientName??details.params.client_id)}</p><p>Повернення: ${escape(details.params.redirect_uri)}</p><p>Доступ: читання профілів, збереження повідомлень, зміна прогресу та джерел.</p><form method="post" action="/interaction/${escape(details.uid)}"><input type="hidden" name="csrf" value="${csrf(details.uid)}">${login?'<label>Ключ власника <input name="owner_key" type="password" autocomplete="off" required></label><p>Ключ створений на цьому Mac у файлі .local/owner-key.txt. Не надсилайте його в чат.</p>':''}<button name="decision" value="allow">${login?'Увійти':'Дозволити'}</button><button name="decision" value="deny" formnovalidate>Відхилити</button></form></html>`);
  });
  app.post('/interaction/:uid',express.urlencoded({extended:false,limit:'8kb'}),async(req,res)=>{
    const details=await provider.interactionDetails(req,res);
    const expected=Buffer.from(csrf(details.uid));const actual=Buffer.from(String(req.body.csrf??''));
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual)) {res.status(403).send('Невірний запит');return;}
    if(req.body.decision==='deny') {await provider.interactionFinished(req,res,{error:'access_denied'},{mergeWithLastSubmission:false});return;}
    if(details.prompt.name==='login') {
      const hash=createHash('sha256').update(String(req.body.owner_key??'')).digest('hex');
      if(!timingSafeEqual(Buffer.from(hash),Buffer.from(config.ownerKeyHash))) {res.status(401).send('Невірний ключ власника');return;}
      await provider.interactionFinished(req,res,{login:{accountId:config.ownerId,remember:false}},{mergeWithLastSubmission:false});return;
    }
    if(details.prompt.name!=='consent'||details.session?.accountId!==config.ownerId) {res.status(403).send('Вхід потрібен');return;}
    const grant=details.grantId?await provider.Grant.find(details.grantId):new provider.Grant({accountId:config.ownerId,clientId:String(details.params.client_id)});
    if(!grant) throw new Error('missing_grant');
    const prompt=details.prompt.details as {missingOIDCScope?:string[];missingResourceScopes?:Record<string,string[]>};
    if(prompt.missingOIDCScope) grant.addOIDCScope(prompt.missingOIDCScope);
    for(const [target,scopes] of Object.entries(prompt.missingResourceScopes??{})) {
      if(target!==config.publicUrl+'/mcp') {res.status(403).send('Невірний ресурс');return;}
      grant.addResourceScope(target,scopes);
    }
    const grantId=await grant.save();await provider.interactionFinished(req,res,{consent:{grantId}},{mergeWithLastSubmission:true});
  });
  // oidc-provider must receive its original, unconsumed form bodies.
  app.use(provider.callback());
}
