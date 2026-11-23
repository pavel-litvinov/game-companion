import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
const secret=()=>randomBytes(32).toString('base64url');
await mkdir('.local',{recursive:true,mode:0o700});
const existing=await readFile('.local/api.env','utf8').catch(()=>null);
if(!existing) {
 const adminPassword=secret(),appPassword=secret(),ownerKey=secret(),ownerId=randomUUID();
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'});
 Object.assign(key,{kid:randomUUID(),alg:'RS256',use:'sig'});
 const publicUrl=process.env.GC_PUBLIC_URL??'http://localhost:3000';
 const write=(path,text)=>writeFile(path,text+'\n',{mode:0o600});
 await write('.local/postgres.env',`POSTGRES_DB=game_companion\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${adminPassword}`);
 await write('.local/migrate.env',`ADMIN_DATABASE_URL=postgresql://postgres:${adminPassword}@db:5432/game_companion\nAPP_DATABASE_PASSWORD=${appPassword}\nOWNER_ID=${ownerId}`);
 await write('.local/api.env',`DATABASE_URL=postgresql://gc_app:${appPassword}@db:5432/game_companion\nPUBLIC_URL=${publicUrl}\nOWNER_ID=${ownerId}\nOWNER_KEY_HASH=${createHash('sha256').update(ownerKey).digest('hex')}\nCOOKIE_KEY=${secret()}\nOIDC_JWKS=${JSON.stringify({keys:[key]})}`);
 await write('.local/owner-key.txt',ownerKey);
 console.info('Generated private local credentials. The owner key is in .local/owner-key.txt; no email account is needed.');
}
if(process.env.GC_PUBLIC_URL&&existing) {
 await writeFile('.local/api.env',existing.replace(/^PUBLIC_URL=.*$/m,`PUBLIC_URL=${process.env.GC_PUBLIC_URL}`),{mode:0o600});
}
await new Promise((resolve,reject)=>{
 const child=spawn('docker',['compose','up','--build','-d'],{stdio:'inherit'});
 child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Docker startup failed')));
});
console.info('Game Companion + plain PostgreSQL are running locally. Data persists in the PostgreSQL Docker volume.');
