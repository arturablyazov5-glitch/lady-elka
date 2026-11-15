import {createEnvelope,serializePending,restorePending,validateStatus} from '../../storefront/api-v2/contract.mjs';
import {validatePaymentResponse} from '../payment-adapter.mjs';
const key='fixture_v2_pending',legacy='lady_elka_pending_order_v1';
const policy={ownerEndpoint:location.origin+'/pay-v2',versionExpired:new URL(location.href).searchParams.has('expired')};
const origins=['https://mock-bank.invalid'];
let pending,lastError;
const notice=document.querySelector('output');
const show=x=>{notice.textContent=x;};
async function post(route,body,capability='alice') {
 const r=await fetch('/pay-v2',{method:'POST',headers:{'Content-Type':'application/json','X-Fixture-Capability':capability},body:JSON.stringify({route,body})});
 const b=await r.json();if(!r.ok){const e=new Error(b.error);e.status=r.status;e.retryAfter=r.headers.get('Retry-After');lastError={message:e.message,status:e.status,retryAfter:e.retryAfter};throw e;}lastError=null;return b;
}
function restore(){try{
 if(sessionStorage.getItem(legacy)){show('LEGACY_PENDING_UNSUPPORTED');return;}
 const raw=sessionStorage.getItem(key);if(raw)pending=restorePending(raw,policy);
 show(pending?'pending restored':'ready');
}catch(e){show(e.code||e.message);}}
window.qa={key,legacy,ready:true,
 async start(envelope){try{
  if(sessionStorage.getItem(key)||sessionStorage.getItem(legacy))throw new Error('UNRESOLVED_PENDING');
  const raw=serializePending(createEnvelope(envelope.payload,policy.ownerEndpoint),policy);
  sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw new Error('STORAGE_READBACK_FAILED');
  pending=restorePending(sessionStorage.getItem(key),policy);
  show(validateStatus(await post('create',pending),pending,policy).status);
 }catch(e){show(e.code||e.message);}},
 async replay(){try{pending=restorePending(sessionStorage.getItem(key),policy);show(validateStatus(await post('create',pending),pending,policy).status);}catch(e){show(e.code||e.message);}},
 async status(capability='alice'){const r=validatePaymentResponse(await post('status',{orderId:pending.orderId},capability),pending,policy,origins);show(r.nextAction);return r;},
 async payment(){const r=await this.status();if(r.paymentURL)location.href=r.paymentURL;},
 async returnStatus(){const oid=new URL(location.href).searchParams.get('oid');if(oid!==pending?.orderId)throw new Error('RETURN_ID_MISMATCH');return this.status();},
 validateResponse(response){return validatePaymentResponse(response,pending,policy,origins);},
 snapshot(){return {lastError,notice:notice.textContent,raw:sessionStorage.getItem(key),legacy:sessionStorage.getItem(legacy)};}
};
restore();
document.querySelector('#replay').onclick=()=>qa.replay();
document.querySelector('#status').onclick=()=>qa.status().catch(e=>show(e.message));
