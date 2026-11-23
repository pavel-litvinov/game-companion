import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {errors} from 'oidc-provider';
export function adapterFactory(pool:Pool) {
  return class Adapter {
    constructor(private model:string){}
    key(id:string){return createHash('sha256').update(id).digest('hex');}
    async upsert(id:string,payload:object,expiresIn?:number) {await pool.query(`insert into gc_private.oidc_artifacts(model,id,payload,expires_at) values($1,$2,$3::jsonb,case when $4::integer is null then null else now()+$4*interval '1 second' end) on conflict(model,id) do update set payload=excluded.payload,expires_at=excluded.expires_at`,[this.model,this.key(id),JSON.stringify(payload),expiresIn??null]);}
    async find(id:string) {return (await pool.query("select payload from gc_private.oidc_artifacts where model=$1 and id=$2 and (expires_at is null or expires_at>now())",[this.model,this.key(id)])).rows[0]?.payload;}
    async findByUid(uid:string) {return (await pool.query("select payload from gc_private.oidc_artifacts where model=$1 and payload->>'uid'=$2 and (expires_at is null or expires_at>now())",[this.model,uid])).rows[0]?.payload;}
    async findByUserCode(userCode:string) {return (await pool.query("select payload from gc_private.oidc_artifacts where model=$1 and payload->>'userCode'=$2 and (expires_at is null or expires_at>now())",[this.model,userCode])).rows[0]?.payload;}
    async consume(id:string) {const result=await pool.query("update gc_private.oidc_artifacts set payload=jsonb_set(payload,'{consumed}',to_jsonb(extract(epoch from now())::bigint)) where model=$1 and id=$2 and not(payload?'consumed') returning id",[this.model,this.key(id)]);if(!result.rowCount) throw new errors.InvalidGrant('authorization_already_consumed');}
    async destroy(id:string) {await pool.query('delete from gc_private.oidc_artifacts where model=$1 and id=$2',[this.model,this.key(id)]);}
    async revokeByGrantId(grantId:string) {await pool.query("delete from gc_private.oidc_artifacts where payload->>'grantId'=$1",[grantId]);}
  };
}
