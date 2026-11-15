import {providerResult,paidEvidence,paymentResponse} from './payment-adapter.mjs';
import {pollPayments} from './worker.mjs';
import { randomBytes } from 'node:crypto';
export const productionReady = false;
export const bankNumber = () => `LE2${randomBytes(14).toString('hex')}`; // 31 chars; no truncation
const fail = (code,status=503)=>{throw Object.assign(new Error(code),{status});};
// validator validates the shared envelope AND server catalog/pricing/freshness;
// returns {id,fingerprint,amount (integer minor units),method}. No independent wire validator.
export function createRouter({store,validator,auth,provider,notifier,recipients=[],budget,effectBudgets,createOpen=false,identity,paymentOrigins=[],evidencePolicy,requestBudgets}) {
 async function deliver(o,context={}) {
  for(const recipient of o.recipients) {
   if(context.signal?.aborted) break;
   const key=`v2:telegram:${o.id}:${recipient}`;
   if(!await store.claim(key,o.id,effectBudgets.telegram)) continue;
   if(context.signal?.aborted) {await store.finish(key,'failed');break;}
   try {
    const r=await notifier.send({order:o,recipient,key,...context});
    if(r?.outcome==='confirmed') await store.finish(key,'succeeded');
    else if(r?.outcome==='not_sent') await store.finish(key,'failed');
    else await store.finish(key,'unknown');
   } catch { await store.finish(key,'unknown'); }
  }
 }
 async function owned(id,owner) {
  const o=await store.get(id);
  if(!o || o.owner!==owner) fail('NOT_FOUND',404);
  return o;
 }
 const response=o=>({apiVersion:identity.apiVersion,fingerprintVersion:identity.fingerprintVersion,ownerEndpoint:identity.ownerEndpoint,orderId:o.id,status:o.status});
 return async function route({route,body,credentials,signal,deadline}) {
  try {
   if(!['create','status','callback','internal-retry','internal-poll'].includes(route)) fail('ROUTE_NOT_FOUND',404);
   if(!store||!auth||!identity||!budget||!effectBudgets?.bank||!effectBudgets?.telegram) fail('CONFIG_UNAVAILABLE');
   if(identity.apiVersion!=='2' || identity.fingerprintVersion!=='sha256-canonical-json-v1' || !identity.ownerEndpoint) fail('CONFIG_UNAVAILABLE');
   await store.ready();
   if(!requestBudgets || !store.consume) fail('CONFIG_UNAVAILABLE');
   await store.consume(requestBudgets.request,'untrusted');
   const scope=route==='callback'?'callback':route.startsWith('internal-')?'internal':route;
   if(scope==='callback'||scope==='internal') await store.consume(requestBudgets[scope],'untrusted');
   if(route==='callback') {
    if(!await auth.callback(credentials,body)) fail('UNAUTHORIZED',401);
    const o=await store.byPayment(body?.paymentId);
    if(!o || !/^LE2[0-9a-f]{28}$/.test(o.bank_number)) fail('NOT_FOUND',404);
    if(!provider || !notifier) fail('PROVIDER_UNAVAILABLE');
    const e=await provider.evidence(o.payment_id);
    if(!paidEvidence(e,o,evidencePolicy)) fail('EVIDENCE_UNCERTAIN',409);
    if(!await store.recover(o,e)) fail('OWNERSHIP',409);
    await deliver(await store.get(o.id));
    return {status:200,body:response(await store.get(o.id))};
   }
   if(route==='internal-poll') {
    if(!await auth.internal(credentials)) fail('UNAUTHORIZED',401);
    if(!provider||!notifier) fail('PROVIDER_UNAVAILABLE');
    const result=await pollPayments({store,provider,batch:body?.batch??20,deadline,signal,complete:async(o,e,context)=>{
     if(!paidEvidence(e,o,evidencePolicy)||context.signal.aborted) return;
     if(await store.recover(o,e)) await deliver(await store.get(o.id),context);
    }});
    return {status:200,body:result};
   }
   if(route==='internal-retry') {
    if(!await auth.internal(credentials)) fail('UNAUTHORIZED',401);
    if(!notifier) fail('PROVIDER_UNAVAILABLE');
    const result=await pollPayments({store:{pollable:limit=>store.pending(limit)},provider:{evidence:async()=>true},batch:body?.batch??20,deadline,signal,complete:async(o,e,context)=>deliver(o,context)});
    return {status:200,body:result};
   }
   const owner=await auth.caller(credentials);
   if(!owner) fail('UNAUTHORIZED',401);
   await store.consume(requestBudgets.ownerRequest,owner);
   await store.consume(requestBudgets[route==='status'?'status':'replay'],owner);
   if(route==='status') return {status:200,body:paymentResponse(await owned(body?.orderId,owner),identity,paymentOrigins)};
   const v=await validator(body);
   if(!v || !Number.isSafeInteger(v.amount)||v.amount<=0 || !['card','cash_on_delivery'].includes(v.method)) fail('VALIDATION_UNAVAILABLE');
   if(!recipients.length || recipients.length>20 || recipients.some(r=>typeof r!=='string'||!r)) fail('RECIPIENTS_MISSING');
   if(!notifier || (v.method==='card'&&!provider)) fail('PROVIDER_UNAVAILABLE');
   let o=await store.reserve({...v,owner,bankNumber:bankNumber(),recipients:[...new Set(recipients)],budget,open:createOpen});
   if(o.method==='cash_on_delivery') {
    if(o.status==='received') await store.status(o.id,'accepted');
    await deliver(await store.get(o.id));
   } else {
    const key=`v2:bank:${o.id}`;
    if(await store.claim(key,o.id,effectBudgets.bank)) {
     try {
      const r=await provider.register({order:o,key});
      if(r?.outcome==='confirmed') {
       const result=providerResult(r,o,paymentOrigins);
       await store.bind(o.id,result.paymentId,result); await store.finish(key,'succeeded');
      } else if(r?.outcome==='not_sent') await store.finish(key,'failed');
      else {await store.finish(key,'unknown');await store.status(o.id,'pending_review');}
     } catch {await store.finish(key,'unknown');await store.status(o.id,'pending_review');}
    }
   }
   return {status:200,body:response(await store.get(o.id))};
  } catch(e) {
   const codes={CONFLICT:409,NOT_FOUND:404,CREATE_CLOSED:503,RATE_LIMITED:429};
   const code=Object.keys(codes).find(k=>e.message===k);
   return {status:e.status||codes[code]||503,...(code==='RATE_LIMITED'?{headers:{'Retry-After':String(Number.isSafeInteger(Number(e.detail))&&Number(e.detail)>0?Number(e.detail):1)}}:{}),body:{error:code|| (e.status ? e.message:'BACKEND_UNAVAILABLE')}};
  }
 };
}
