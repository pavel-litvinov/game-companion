import {z} from 'zod';
export function loadConfig(env:NodeJS.ProcessEnv=process.env) {
  const c=z.object({databaseUrl:z.string().min(10),publicUrl:z.url(),ownerId:z.uuid(),ownerKeyHash:z.string().regex(/^[a-f0-9]{64}$/),cookieKey:z.string().min(32),jwks:z.string().min(10),host:z.string(),port:z.coerce.number().int().min(1).max(65535)})
    .parse({databaseUrl:env.DATABASE_URL,publicUrl:(env.PUBLIC_URL??'http://localhost:3000').replace(/\/+$/,''),ownerId:env.OWNER_ID,ownerKeyHash:env.OWNER_KEY_HASH,cookieKey:env.COOKIE_KEY,jwks:env.OIDC_JWKS,host:env.HOST??'127.0.0.1',port:env.PORT??3000});
  const url=new URL(c.publicUrl);
  if(url.pathname!=='/'||url.search||url.hash||url.username||url.password) throw new Error('PUBLIC_URL must be an origin');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.protocol!=='https:') throw new Error('Public access requires HTTPS');
  return c;
}
export type Config=ReturnType<typeof loadConfig>;
