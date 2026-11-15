import {restrictedAdapter} from './restricted-adapter.mjs';
import {contractValidator} from './contract-adapter.mjs';
import {bankNumber} from './router.mjs';
import {paidEvidence,providerResult,paymentResponse} from './payment-adapter.mjs';
import {pollPayments} from './worker.mjs';
export const productionReady=false;
const fail=(code,status=503)=>{throw Object.assign(new Error(code),{status});};
const checkRequest=(signal,deadline)=>{
 if(signal?.aborted||!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline-Date.now()>2147483647) fail('REQUEST_CANCELLED',504);
};
// Trusted composition only. No public provisioning, owner resolver or SQL fallback.
export function createGateway({executors,identity,verifyCatalog,auth,provider,notifier,recipients,paymentOrigins=[],evidencePolicy}={}) {
 const adapters=Object.fromEntries(['create','status','callback','internal'].map(role=>[role,restrictedAdapter({executor:executors?.[role],role})]));
 const worker=adapters.internal;
 const validate=contractValidator({ownerEndpoint:identity?.ownerEndpoint,verifyCatalog});
 async function deliver(o,context) {
  for(const recipient of o.recipients) {
   if(context.signal.aborted||Date.now()>=context.deadline) break;
   const key=`v2:telegram:${o.id}:${recipient}`;
   if(!await worker.claim(key,o.id,'telegram')) continue;
   if(context.signal.aborted||Date.now()>=context.deadline){await worker.finish(key,'failed');break;}
   try{const r=await notifier.send({order:o,recipient,key,...context});await worker.finish(key,r?.outcome==='confirmed'?'succeeded':r?.outcome==='not_sent'?'failed':'unknown');}
   catch{await worker.finish(key,'unknown');}
  }
 }
 async function execute(o,e,context) {
  if(context.signal.aborted||Date.now()>=context.deadline) return;
  if(o.method==='cash_on_delivery') {
   if(o.status==='received') await worker.status(o.id,'accepted');
   await deliver(await worker.get(o.id),context);
  } else {
   const key=`v2:bank:${o.id}`;
   if(!await worker.claim(key,o.id,'bank')) return;
   if(context.signal.aborted||Date.now()>=context.deadline){await worker.finish(key,'failed');return;}
   try {
    const r=await provider.register({order:o,key,...context});
    if(r?.outcome==='confirmed'){const result=providerResult(r,o,paymentOrigins);await worker.bind(o.id,result.paymentId,result);await worker.finish(key,'succeeded');}
    else if(r?.outcome==='not_sent') await worker.finish(key,'failed');
    else {await worker.finish(key,'unknown');await worker.status(o.id,'pending_review');}
   }catch{await worker.finish(key,'unknown');await worker.status(o.id,'pending_review');}
  }
 }
 const response=o=>({...identity,orderId:o.id,status:o.status});
 return async function gateway({route,body,credentials,signal,deadline}={}) {
  try {
   const context={signal,deadline};
   const scope=route?.startsWith('internal-')?'internal':route;
   if(!['create','status','callback','internal-poll','internal-retry'].includes(route)) fail('ROUTE_NOT_FOUND',404);
   if(identity?.apiVersion!=='2'||identity?.fingerprintVersion!=='sha256-canonical-json-v1'||!identity?.ownerEndpoint) fail('CONFIG_UNAVAILABLE');
   checkRequest(signal,deadline);
   await adapters[scope].gate(context);
   checkRequest(signal,deadline);
   if(route==='status') {
    const o=await adapters.status.status(credentials,body?.orderId,context);
    if(!o) fail('NOT_FOUND',404);
    return {status:200,body:paymentResponse(o,identity,paymentOrigins)};
   }
   if(!Number.isSafeInteger(deadline)||deadline-Date.now()>2147483647||deadline<=Date.now()||signal?.aborted) fail('DEADLINE_INVALID');
   if(!notifier||typeof notifier.send!=='function') fail('PROVIDER_UNAVAILABLE');
   const run=async options=>{
    let completionError;
    const result=await pollPayments({...options,deadline,signal,complete:async(...args)=>{
     try{return await options.complete(...args);}catch(e){completionError=e;throw e;}
    }});
    if(completionError) throw completionError;
    return result;
   };
   if(route==='create') {
    if(!Array.isArray(recipients)||!recipients.length||recipients.length>20||recipients.some(r=>typeof r!=='string'||!r)) fail('RECIPIENTS_MISSING');
    const v=await validate(body);
    if(v.method==='card'&&typeof provider?.register!=='function') fail('PROVIDER_UNAVAILABLE');
    checkRequest(signal,deadline);
    const admitted=await adapters.create.create(credentials,v,bankNumber(),[...new Set(recipients)],context);
    // Only a successful capability-bound admission can dispatch this exact ID.
    await worker.gate();
    await run({store:{pollable:async()=>[await worker.get(admitted.id)]},provider:{evidence:async()=>true},complete:execute});
    return {status:200,body:response(await worker.get(admitted.id))};
   }
   if(route==='callback') {
    if(typeof auth?.callback!=='function'||!await auth.callback(credentials,body)) fail('UNAUTHORIZED',401);
    if(typeof provider?.evidence!=='function') fail('PROVIDER_UNAVAILABLE');
    const o=await adapters.callback.byPayment(body?.paymentId);
    if(!o) fail('NOT_FOUND',404);
    let recovered=false;
    await run({store:{pollable:async()=>[o]},provider,complete:async(order,e,context)=>{
     if(!paidEvidence(e,order,evidencePolicy)) fail('EVIDENCE_UNCERTAIN',409);
     if(!await adapters.callback.recover(order,e)) fail('OWNERSHIP',409);
     recovered=true;
     await worker.gate();await deliver(await worker.get(order.id),context);
    }});
    if(!recovered) fail('EVIDENCE_UNCERTAIN',409);
    return {status:200,body:response(await worker.get(o.id))};
   }
   if(typeof auth?.internal!=='function'||!await auth.internal(credentials)) fail('UNAUTHORIZED',401);
   if(route==='internal-poll'&&typeof provider?.evidence!=='function') fail('PROVIDER_UNAVAILABLE');
   const result=await run({batch:body?.batch??20,store:route==='internal-poll'?worker:{pollable:n=>worker.pending(n)},provider:route==='internal-poll'?provider:{evidence:async()=>true},complete:async(o,e,context)=>{
    if(route==='internal-retry') return deliver(o,context);
    if(paidEvidence(e,o,evidencePolicy)&&await worker.recover(o,e)) await deliver(await worker.get(o.id),context);
   }});
   return {status:200,body:result};
  }catch(e){
   const codes={UNAUTHORIZED:401,CONFLICT:409,NOT_FOUND:404,CREATE_CLOSED:503,RATE_LIMITED:429};
   const code=Object.hasOwn(codes,e.message)?e.message:null;
   return {status:e.status||codes[code]||503,...(code==='RATE_LIMITED'?{headers:{'Retry-After':String(Number.isSafeInteger(Number(e.detail))&&Number(e.detail)>0?Number(e.detail):1)}}:{}),body:{error:code||(e.status?e.message:'BACKEND_UNAVAILABLE')}};
  }
 };
}
