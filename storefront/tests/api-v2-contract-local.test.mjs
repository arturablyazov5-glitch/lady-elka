import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderPayload } from '../client/order-payload.js';
import { createOrderStore } from '../../supabase/functions/_shared/order-store.mjs';
import { createV2OrderId, createEnvelope, serializePending, restorePending, assertReplay, validateEnvelope, validateStatus, fingerprintPayload, canonicalPayload } from '../api-v2/contract.mjs';
const ownerEndpoint = 'https://api.example.invalid/orders-v2';
const policy = { ownerEndpoint };
const fixture = (method = 'card') => { const payload=buildOrderPayload([
  { productId:'synthetic-tree', variantId:'synthetic-180', kind:'tree', title:'Synthetic', quantity:2, price:100,
    options:{height:180,category:'synthetic'} }
], {name:'Synthetic',email:'buyer@example.invalid',phone:'+70000000000',address:'Synthetic address',contactPref:'email',comment:''},null,
'http://localhost:4176',1791000000000,method);
  // Adapter for a NEW synthetic payload only; production builder remains untouched.
  payload.orderId=createV2OrderId(1791000000000,'1234abcd');
  payload.successUrl=`http://localhost:4176/spasibo?oid=${payload.orderId}`;
  payload.failUrl=`http://localhost:4176/pay-return?fail=1&oid=${payload.orderId}`;
  return createEnvelope(payload,ownerEndpoint);
};
const rejects = (fn,code) => assert.throws(fn,e => e.code === code && e.preservePending === true);
test('exact real builder payload survives serialization/F5 without ID generation or normalization',() => {
  const saved=fixture(); const bytes=serializePending(saved,policy);
  assert.deepEqual(restorePending(bytes,policy),saved);
  assert.equal(serializePending(restorePending(bytes,policy),policy),bytes);
  assert.equal(assertReplay(saved,restorePending(bytes,policy),policy),saved);
});
test('canonical fingerprint matches existing store and includes every business field',async () => {
  const e=fixture(); let inserted;
  const store=createOrderStore(async (_path,options) => {inserted=JSON.parse(options.body);return {ok:true,status:200,json:async()=>[inserted]};});
  await store.reserve(e.orderId,e.payload);
  assert.equal(await fingerprintPayload(e.payload),inserted.fingerprint);
  assert.equal(await fingerprintPayload({...e.payload,customer:{...e.payload.customer,comment:'changed'}}) === inserted.fingerprint,false);
  assert.equal(canonicalPayload({...e.payload,items:e.payload.items}),canonicalPayload(e.payload));
});
test('legacy pending/raw legacy pay are rejected without migration',() => {
  for (const old of [{signature:'old',payload:fixture().payload},{orderId:'legacy',amount:100}])
    rejects(()=>restorePending(JSON.stringify(old),policy),'LEGACY_PENDING_UNSUPPORTED');
});
test('wrong owner/version/fingerprint/ID reject, exact pending remains intact',() => {
  const e=fixture(), before=JSON.stringify(e);
  rejects(()=>validateEnvelope({...e,ownerEndpoint:'https://api.example.invalid/other'},policy),'OWNER_ENDPOINT_MISMATCH');
  rejects(()=>validateEnvelope({...e,apiVersion:'1'},policy),'VERSION_EXPIRED');
  rejects(()=>validateEnvelope({...e,fingerprintVersion:'unknown'},policy),'FINGERPRINT_VERSION_UNSUPPORTED');
  rejects(()=>validateEnvelope({...e,orderId:'different'},policy),'ORDER_ID_CONFLICT');
  rejects(()=>createEnvelope(e.payload,'https://api.example.invalid/functions/v1/pay'),'OWNER_ENDPOINT_INVALID');
  rejects(()=>restorePending(before,{...policy,versionExpired:true}),'VERSION_EXPIRED');
  assert.equal(JSON.stringify(e),before);
});
test('same ID with changed valid payload conflicts, no new ID on replay',() => {
  const e=fixture();const changed=structuredClone(e);changed.payload.customer.comment='changed';
  rejects(()=>assertReplay(e,changed,policy),'ORDER_ID_CONFLICT');
  assert.equal(e.orderId,changed.orderId);
});
test('unknown bank, accepted COD and expired status retain pending and explicit identity',() => {
  const e=fixture(),bytes=serializePending(e,policy);
  const identity={apiVersion:e.apiVersion,fingerprintVersion:e.fingerprintVersion,ownerEndpoint,orderId:e.orderId};
  assert.equal(validateStatus({...identity,status:'pending_review',error:'BANK_RESULT_UNKNOWN'},e,policy).nextAction,'status_only');
  assert.equal(validateStatus({...identity,status:'version_expired',error:'VERSION_EXPIRED'},e,policy).nextAction,'contact_owner');
  rejects(()=>validateStatus({...identity,orderId:'wrong',status:'paid'},e,policy),'STATUS_IDENTITY_MISMATCH');
  rejects(()=>validateStatus({...identity,status:'paid',error:'BANK_RESULT_UNKNOWN'},e,policy),'STATUS_INVALID');
  const cod=fixture('cash_on_delivery');
  assert.equal(validateStatus({...identity,orderId:cod.orderId,status:'accepted',error:'DELIVERY_PENDING'},cod,policy).nextAction,'confirm_accepted');
  assert.equal(serializePending(e,policy),bytes);
});
test('structured validation rejects unsafe JSON, missing items and return identity tampering',() => {
  const e=fixture();const noItems=structuredClone(e);delete noItems.payload.items;
  rejects(()=>validateEnvelope(noItems,policy),'INVALID_ITEMS');
  const url=structuredClone(e);url.payload.successUrl+='&oid=wrong';rejects(()=>validateEnvelope(url,policy),'INVALID_RETURN_URL');
  rejects(()=>canonicalPayload({amount:NaN}),'INVALID_JSON');
  rejects(()=>canonicalPayload({get amount(){throw new Error('must not execute');}}),'INVALID_JSON');
  rejects(()=>restorePending('{',policy),'PENDING_CORRUPT');
});

test('new v2 IDs are deterministic explicit namespace <=32; legacy IDs never renamed',()=> {
  assert.equal(createV2OrderId(1791000000000,'1234abcd'),'LE-1791000000000-V2-1234abcd');
  assert.ok(createV2OrderId(1791000000000,'1234abcd').length <= 32);
  rejects(()=>createV2OrderId(1791000000000,'invalid'),'ORDER_ID_INVALID');
  const e=fixture();const old=structuredClone(e);old.orderId=old.payload.orderId='LE-1791000000000-180-1234abcd';
  old.payload.successUrl=`http://localhost:4176/spasibo?oid=${old.orderId}`;old.payload.failUrl=`http://localhost:4176/pay-return?fail=1&oid=${old.orderId}`;
  rejects(()=>validateEnvelope(old,policy),'ORDER_ID_INVALID');
  assert.equal(old.orderId,'LE-1791000000000-180-1234abcd');
});
