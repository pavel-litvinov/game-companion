import type {Pool,PoolClient} from 'pg';
import {commands,querySchema,type Command} from './schema.js';
export class AppError extends Error {constructor(public status:number,public code:string){super(code);}}
export function databaseError(error:{code?:string}):AppError {
  if(['40001','23505'].includes(error.code??'')) return new AppError(409,'conflict');
  if(error.code==='P0002') return new AppError(404,'not_found');
  if(error.code==='42501') return new AppError(403,'forbidden');
  if(['22023','22P02','23502','23503','23514'].includes(error.code??'')) return new AppError(422,'invalid_input');
  return new AppError(503,'database_unavailable');
}
export interface CompanionService {command(action:Command,input:unknown):Promise<any>;query(input:unknown):Promise<any>;}
export function createService(pool:Pool,ownerId:string):CompanionService {
  async function transaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T> {
    let client:PoolClient;
    try {client=await pool.connect();} catch(error) {throw databaseError(error as {code?:string});}
    try {
      await client.query('begin');await client.query('set local role authenticated');
      await client.query("select set_config('gc.owner_id',$1,true),set_config('gc.authenticated','true',true)",[ownerId]);
      const result=await fn(client);await client.query('commit');return result;
    } catch(error) {try {await client.query('rollback');} catch {} throw databaseError(error as {code?:string});}
    finally {client.release();}
  }
  const rpc=(action:string,input:unknown)=>transaction(async client=>(await client.query('select public.gc_command($1,$2::jsonb) as result',[action,JSON.stringify(input)])).rows[0].result);
  return {
    async command(action,input) {
      const validated=commands[action].parse(input);
      if(action==='submit_message') {
        const {expected_revision,...messageInput}=commands.submit_message.parse(validated);
        const saved=await rpc('record_message',messageInput);
        try {return await rpc('process_message',{message_id:saved.id,expected_revision});}
        catch(error) {return {message:saved,processing_error:error instanceof AppError?error.code:'processing_unavailable',retryable:true};}
      }
      return rpc(action,validated);
    },
    async query(input) {
      const q=querySchema.parse(input);
      if((q.game_id&&!['profiles','sources','knowledge'].includes(q.collection))||(q.profile_id&&!['messages','events'].includes(q.collection))) throw new AppError(422,'invalid_filter');
      const values:unknown[]=[];const filters:string[]=[];
      for(const field of ['id','game_id','profile_id'] as const) if(q[field]) {values.push(q[field]);filters.push(`${field}=$${values.length}`);}
      values.push(q.limit,q.offset);
      const sql=`select * from public.gc_${q.collection}${filters.length?' where '+filters.join(' and '):''} order by ${q.collection==='sources'?'recorded_at':'created_at'} desc,id limit $${values.length-1} offset $${values.length}`;
      return transaction(async client=>({rows:(await client.query(sql,values)).rows,offset:q.offset,limit:q.limit,untrusted_content:true}));
    },
  };
}
