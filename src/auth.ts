import {createHash,timingSafeEqual} from 'node:crypto';
import type {Provider} from 'oidc-provider';
import type {Config} from './config.js';
import {AppError,type CompanionService} from './service.js';
export type Authenticate=(authorization:string|undefined,mcp:boolean)=>Promise<CompanionService>;
export function createAuthenticator(config:Config,provider:Provider,service:CompanionService):Authenticate {
  return async(authorization,mcp)=>{
    const match=/^Bearer ([A-Za-z0-9_.~-]+)$/.exec(authorization??'');
    const token=match?.[1];if(!token||token.length>16000) throw new AppError(401,'authentication_required');
    // The owner key is for direct local REST/stdio only, never an MCP OAuth token.
    if(!mcp) {const hash=createHash('sha256').update(token).digest('hex');if(timingSafeEqual(Buffer.from(hash),Buffer.from(config.ownerKeyHash))) return service;}
    const access=await provider.AccessToken.find(token);
    if(!access||access.isExpired||access.accountId!==config.ownerId||access.aud!==config.publicUrl+'/mcp'||!access.scope?.split(' ').includes('companion')) throw new AppError(401,'invalid_token');
    if(!access.grantId||!(await provider.Grant.find(access.grantId))) throw new AppError(401,'revoked_token');
    return service;
  };
}
