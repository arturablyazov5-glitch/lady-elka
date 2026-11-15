import {validateEnvelope,fingerprintPayload,API_VERSION,FINGERPRINT_VERSION} from '../storefront/api-v2/contract.mjs';
// Trusted catalog verification is mandatory and injected; no client price authority.
export function contractValidator({ownerEndpoint,verifyCatalog}) {
 return async envelope=>{
  validateEnvelope(envelope,{ownerEndpoint});
  if(typeof verifyCatalog!=='function') throw new Error('CATALOG_UNAVAILABLE');
  const quote=await verifyCatalog(envelope.payload);
  if(quote?.verified!==true || quote.fresh!==true || !quote.revision || !Number.isSafeInteger(quote.amountMinor) || quote.amountMinor<=0)
   throw new Error('CATALOG_UNAVAILABLE');
  if(quote.amountMinor!==Math.round(envelope.payload.amount*100)) throw new Error('PRICE_MISMATCH');
  return {id:envelope.orderId,method:envelope.payload.paymentMethod,amount:quote.amountMinor,
   fingerprint:await fingerprintPayload({apiVersion:API_VERSION,fingerprintVersion:FINGERPRINT_VERSION,ownerEndpoint,payload:envelope.payload})};
 };
}
