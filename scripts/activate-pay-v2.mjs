// Authorized isolated checkout fix. No push, frontend publication, DNS or legacy mutation.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {leadEnv} from './lead-env.mjs';
import {preparePayV2} from './prepare-pay-v2.mjs';
if(process.argv[2]!=='--activate-isolated-v2')throw Error('Explicit isolated activation flag required');
const env=await leadEnv(),project='mgnotvaahftrbifqtahf',base=`https://api.supabase.com/v1/projects/${project}/`;
async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.SUPABASE_ACCESS_TOKEN,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Management operation HTTP '+r.status);const text=await r.text();return text?JSON.parse(text):null;}
const query=query=>api('database/query',{query});
async function baseline(){const functions=await api('functions');const pay=functions.find(f=>f.slug==='pay');const cron=await query("BEGIN READ ONLY; SELECT jobname,schedule,active,md5(command) AS command_hash FROM cron.job WHERE jobname<>'lady-elka-v2-worker' ORDER BY jobname; COMMIT;");return {pay:{version:pay.version,hash:pay.ezbr_sha256},cron};}
const before=await baseline();
await mkdir('audit/pay-v2',{recursive:true});
await writeFile('audit/pay-v2/activation-before.json',JSON.stringify(before,null,2));
const counts=await query('BEGIN READ ONLY; SELECT count(*)::int AS orders FROM public.le_v2_orders; COMMIT;');
if(counts[0].orders!==0)throw Error('Existing V2 orders need review before activation');
await preparePayV2();
const existing=await query("BEGIN READ ONLY; SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='lady_elka_v2_worker_token'; COMMIT;");
const token=existing[0]?.decrypted_secret||randomBytes(32).toString('hex');
if(!existing.length){await query(`DO $$ BEGIN PERFORM vault.create_secret('${token}','lady_elka_v2_worker_token','Restricted V2 polling/retry only'); END $$;`);}
await api('secrets',[
{name:'LE_V2_WORKER_TOKEN',value:token},
{name:'LE_V2_ADMISSION',value:'enabled'},
{name:'LE_V2_NEW_ORDER_ADMISSION',value:'open'},
{name:'LE_V2_CORS_ORIGIN',value:'https://lady-elka.ru,https://www.lady-elka.ru,https://arturablyazov5-glitch-lady-elka-cloud-preview-3626.twc1.net'}
]);
await new Promise((resolve,reject)=>{const child=spawn('supabase',['functions','deploy','pay-v2','--project-ref',project,'--no-verify-jwt','--use-api'],{env:{...process.env,SUPABASE_ACCESS_TOKEN:env.SUPABASE_ACCESS_TOKEN},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',()=>reject(Error('V2 deploy failed')));child.on('exit',c=>c===0?resolve():reject(Error('V2 deploy failed; admission verification required')));});
const ready=await(await fetch('https://'+project+'.supabase.co/functions/v1/pay-v2?action=readiness')).json();
if(ready.admission!=='open')throw Error('V2 code/admission not confirmed; no cron installed');
await query(await readFile('supabase/migrations/20261012140000_pay_v2_worker.sql','utf8'));
const requests=await query('SELECT public.le_v2_worker_tick() AS request_ids;');
const after=await baseline();
const stable=value=>JSON.stringify(value, (key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
// Supabase bumps function versions after adding project secrets, even when legacy bundles are identical.
if(before.pay.hash!==after.pay.hash||stable(before.cron)!==stable(after.cron))throw Error('Legacy code or cron baseline changed; inspect');
await mkdir('audit/pay-v2',{recursive:true});
await writeFile('audit/pay-v2/activation.json',JSON.stringify({time:new Date().toISOString(),before,after,readiness:ready,requests,legacyUnchanged:true},null,2));
console.log(JSON.stringify({readiness:ready,legacyUnchanged:true,workerRequests:requests}));
