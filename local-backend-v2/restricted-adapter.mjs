// Executors must be separate role-bound connections, never an admin pool with SET ROLE.
export const productionReady = false;
export function restrictedAdapter({executor,role}={}) {
 const names={create:'le_v2_create',status:'le_v2_status',callback:'le_v2_callback',internal:'le_v2_internal'};
 const check=context=>{if(context&&(context.signal?.aborted||!Number.isSafeInteger(context.deadline)||context.deadline<=Date.now()))throw Object.assign(new Error('REQUEST_CANCELLED'),{status:504});};
 async function q(sql,args=[],context) {
  check(context);
  if(!names[role]||typeof executor?.query!=='function') throw new Error('CONFIG_UNAVAILABLE');
  const identity=(await executor.query('SELECT session_user,current_user')).rows?.[0];
  if(identity?.session_user!==names[role]||identity?.current_user!==names[role]) throw new Error('ROLE_INVALID');
  check(context);
  return (await executor.query(sql,args)).rows;
 }
 const internal=async(op,x={})=>(await q('SELECT le_checkout_v2.api_internal($1,$2::jsonb) AS result',[op,JSON.stringify(x)]))[0].result;
 const evidence=e=>JSON.stringify({verified:e.verified,status:e.status,paymentId:e.paymentId,bankNumber:e.bankNumber,amount:e.amount,observedAt:e.observedAt});
 const adapter={gate:context=>q('SELECT le_checkout_v2.api_gate()',[],context)};
 if(role==='create') adapter.create=async(c,v,n,r,context)=>(await q('SELECT * FROM le_checkout_v2.api_create($1,$2,$3,$4,$5,$6,$7::jsonb)',[c,v.id,v.fingerprint,n,v.amount,v.method,JSON.stringify(r)],context))[0];
 if(role==='status') adapter.status=async(c,id,context)=>(await q('SELECT * FROM le_checkout_v2.api_status($1,$2)',[c,id],context))[0];
 if(role==='callback'||role==='internal') Object.assign(adapter,{
  byPayment:async p=>(await q('SELECT * FROM le_checkout_v2.api_callback_lookup($1)',[p]))[0],
  recover:async(o,e)=>(await q('SELECT le_checkout_v2.api_callback_recover($1,$2,$3,$4,$5::jsonb) AS ok',[o.id,e.paymentId,e.bankNumber,e.amount,evidence(e)]))[0].ok,
 });
 if(role==='internal') Object.assign(adapter,{
  get:id=>internal('get',{id}),
  claim:(key,id,kind)=>internal('claim',{key,id,kind}),
  finish:(key,state,result=null)=>internal('finish',{key,state,result}),
  bind:(id,paymentId,result)=>internal('bind',{id,paymentId,paymentURL:result.paymentURL,result}),
  status:(id,status)=>internal('status',{id,status}),
  pollable:async limit=>(await internal('poll')).slice(0,limit),
  pending:async limit=>(await internal('pending')).slice(0,limit),
 });
 return Object.freeze(adapter);
}
