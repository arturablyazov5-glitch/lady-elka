import {validateStatus} from '../storefront/api-v2/contract.mjs';
export function validatePaymentURL(value, origins=[]) {
 if(typeof value!=='string'||value.length>2048) throw new Error('PAYMENT_URL_INVALID');
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.hash||!origins.includes(u.origin)) throw new Error('PAYMENT_URL_INVALID');
 return u.href;
}
export function providerResult(result,order,origins) {
 if(result?.outcome!=='confirmed'||typeof result.paymentId!=='string'||!result.paymentId||result.paymentId.length>256
 ||result.bankNumber!==order.bank_number||result.amount!==Number(order.amount)) throw new Error('REGISTRATION_UNCERTAIN');
 return {paymentId:result.paymentId,bankNumber:result.bankNumber,amount:result.amount,paymentURL:validatePaymentURL(result.paymentURL,origins)};
}
export function paidEvidence(e,o,{now=Date.now,maxAgeMs=60000}={}) {
 return typeof o.payment_id==='string'&&o.payment_id.length>0&&e?.verified===true&&e.status==='paid'&&e.paymentId===o.payment_id&&e.bankNumber===o.bank_number
 &&e.amount===Number(o.amount)&&Number.isSafeInteger(e.observedAt)&&e.observedAt<=now()&&now()-e.observedAt<=maxAgeMs;
}
// Separate local envelope: never add fields to the shared pure status contract.
export function paymentResponse(o,identity,origins) {
 const status={...identity,orderId:o.id,status:o.status};
 return {status,paymentURL:o.status==='awaiting_payment'&&o.payment_url?validatePaymentURL(o.payment_url,origins):null};
}
export function validatePaymentResponse(response,pending,policy,origins) {
 if(!response||Object.keys(response).some(k=>!['status','paymentURL'].includes(k))) throw new Error('PAYMENT_RESPONSE_INVALID');
 const status=validateStatus(response.status,pending,policy);
 if(response.paymentURL!==null&&status.status!=='awaiting_payment') throw new Error('PAYMENT_RESPONSE_INVALID');
 return {...status,paymentURL:response.paymentURL===null?null:validatePaymentURL(response.paymentURL,origins)};
}
