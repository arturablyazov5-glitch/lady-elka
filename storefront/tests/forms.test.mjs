import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { annotateLeadForms, leadForms } from '../client/lead-schema.js';
import { validLeadPhone } from '../client/forms.js';
import { runtimeConfig } from '../config/runtime.mjs';
import { leadEndpoint } from '../client/config.js';

test('every audited contact template has explicit fields; unknown forms fail the build',async()=>{
 for(const [id,schema] of Object.entries(leadForms)) {
  const html=id==='iawvkogkq_0'?await readFile('storefront/components/question-form-section.html','utf8'):
   await readFile(id==='ibfs75na0_0'?'storefront/public/decor.html':id==='i1hecfw24_0'?'storefront/public/tree/miranda.html':id==='iu4a9894i_0'?'storefront/public/index.html':'storefront/public/o-nas.html','utf8');
  const raw=html.match(new RegExp(`<form\\b[^>]*id=['"]${id}['"][^>]*>[\\s\\S]*?<\\/form>`))[0];
  const converted=annotateLeadForms(raw);
  assert.match(converted,new RegExp(`data-lead-type="${schema.type}"`));
  assert.deepEqual([...converted.matchAll(/data-lead-field="([^"]+)"/g)].map(m=>m[1]),schema.fields);
 }
 assert.throws(()=>annotateLeadForms('<form id="unknown"><input type="tel"></form>'),/Unmapped contact form/);
 assert.equal(annotateLeadForms('<form><input type="tel"><button data-pay-now></button></form>'),'<form><input type="tel"><button data-pay-now></button></form>');
});
test('front phone validation is strict; production/preview/fixture endpoints are explicit',()=>{
 for(const v of ['9991234567','89991234567','+7 (999) 123-45-67'])assert.equal(validLeadPhone(v),true);
 for(const v of ['','123','799912345678','letters79991234567','+19991234567'])assert.equal(validLeadPhone(v),false);
 const previous=globalThis.__LE_STOREFRONT_CONFIG__;
 try {
  globalThis.__LE_STOREFRONT_CONFIG__=runtimeConfig('preview');assert.throws(()=>leadEndpoint(),/отключена/);
  globalThis.__LE_STOREFRONT_CONFIG__=runtimeConfig('production');assert.equal(leadEndpoint(),'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/lead');
  globalThis.__LE_STOREFRONT_CONFIG__=runtimeConfig('fixture');assert.equal(leadEndpoint(),'/functions/v1/lead');
 }finally{globalThis.__LE_STOREFRONT_CONFIG__=previous;}
});
