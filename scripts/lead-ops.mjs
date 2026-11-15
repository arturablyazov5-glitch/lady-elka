import { leadEnv } from './lead-env.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createLeadHandler } from '../supabase/functions/lead/handler.mjs';
const env = await leadEnv();
const project = 'mgnotvaahftrbifqtahf';
if (env.SUPABASE_PROJECT_REF && env.SUPABASE_PROJECT_REF !== project) throw new Error('Unexpected project');
const flag = process.argv[2];
const leadMigrationFiles = ['supabase/migrations/20261008090000_leads.sql','supabase/migrations/20261008120000_lead_retry.sql','supabase/migrations/20261008125000_lead_claim_backoff.sql'];
async function management(path, body) {
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN unavailable');
  const r = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, { method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  if (!r.ok) throw new Error(`Supabase management HTTP ${r.status}`);
  return r.json();
}
try {
 if (flag === '--deploy') {
  // Both lead migrations, always in order: 090000 alone would revert retry/backoff RPCs to the old versions.
  for (const file of leadMigrationFiles) {
    const query = await readFile(file,'utf8');
    await management('database/query',{query:'begin;\n'+query+'\ncommit;'});
    console.log('Applied', file.split('/').at(-1));
  }
  console.log('Lead migrations applied (only these additive SQL files, no unrelated migrations).');
  const code = await new Promise((resolve,reject)=>{const child=spawn('supabase',['functions','deploy','lead','--project-ref',project,'--no-verify-jwt','--use-api'],{env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('exit',code=>{
      // Never forward raw CLI output; retain only non-sensitive outcome.
      console.log('Supabase CLI deploy exit:',code);resolve(code);
    });});
  if (code !== 0) throw new Error('Function deployment failed');
  const response=await fetch(`${env.SUPABASE_URL}/functions/v1/lead`,{method:'OPTIONS',headers:{Origin:'https://lady-elka.ru'}});
  console.log('Deployed function OPTIONS:',response.status);
  if (response.status!==204) throw new Error('Deployed function preflight failed');
  await writeFile('agent-context/forms-deploy-report.json',JSON.stringify({project,function:'lead',migrations:leadMigrationFiles.map(f=>f.split('/').at(-1)),cliExit:code,preflight:response.status,time:new Date().toISOString()},null,2)+'\n');
 } else if (flag === '--live-test') {
  const ids=(env.TG_CHAT_IDS||'').split(/[\s,;]+/).filter(id=>/^\d+$/.test(id));
  if(ids.length!==1 || !env.TG_BOT_TOKEN) throw new Error('Exactly one positive personal chat ID and bot token required');
  const id=crypto.randomUUID(),observed=[];
  const isolated={...env,TG_CHAT_IDS:ids[0],CORS_ORIGIN:'http://localhost:4174'};
  // Persistent isolated inbox: never put this personal-only test in the production retry queue.
  // The outbox records a delivered_to acknowledgement for the personal recipient.
  const payload={id,type:'consultation',name:'ТЕСТ — проверка нового вида',phone:'+79990000000',comment:'ТЕСТ. Проверка нового вида уведомления о заявке (баннер, блоки, кнопки). Отправлено только в личку; отвечать не нужно.',page:'https://lady-elka.ru/catalog',consent:true,website:''};
  const request=async(url,options)=>{
    if (url.startsWith('https://api.telegram.org/')) {
      const body=JSON.parse(options.body);if(String(body.chat_id)!==ids[0] || Number(body.chat_id)<=0) throw new Error('Group delivery forbidden');
      const r=await fetch(url,options),j=await r.clone().json();
      observed.push({method:url.split('/').at(-1),photo:Boolean(body.photo),buttons:(body.reply_markup?.inline_keyboard||[]).flat().map(b=>b.text),captionLength:body.caption?.length,http:r.status,ok:j.ok===true,photoSent:Array.isArray(j.result?.photo),privateChat:Number(j.result?.chat?.id)>0,recipientMatches:String(j.result?.chat?.id)===ids[0],messageAcknowledged:Boolean(j.result?.message_id)});return r;
    }
    return fetch(url,options);
  };
  const handler=createLeadHandler({env:k=>isolated[k],fetch:request});
  const r=await handler(new Request('http://localhost:4174/functions/v1/lead',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:4174','x-forwarded-for':'live-private-test'},body:JSON.stringify(payload)}));
  const body=await r.json();
  const success=r.status===200&&body.notification==='delivered'&&observed.length===1&&observed[0].method==='sendPhoto'&&observed[0].photoSent&&observed[0].ok&&observed[0].privateChat&&observed[0].recipientMatches&&observed[0].messageAcknowledged;
  const report={time:new Date().toISOString(),id,shortId:id.slice(0,8),status:r.status,notification:body.notification,telegram:observed,success};
  await writeFile('agent-context/lead-design-live-test-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  if(!success)throw new Error('Personal Telegram live test not confirmed');
 } else if (flag === '--retry') {
  // Local administrative execution; no public ability to select recipients.
  const secret = crypto.randomUUID();
  const settings = {...env, LEAD_RETRY_TOKEN: secret};
  const handler = createLeadHandler({env:k=>settings[k]});
  // manual:true bypasses the enabled switch and the max-age filter (owner's explicit action), not leases/attempt limits.
  const response = await handler(new Request('https://internal.test/lead?action=retry',{method:'POST',headers:{'x-lead-retry-token':secret,'Content-Type':'application/json'},body:JSON.stringify({manual:true})}));
  const body = await response.json();
  console.log(JSON.stringify({status:response.status,attempted:body.attempted,delivered:body.delivered,failed:body.failed,alerts:body.alerts}));
  if (!response.ok) throw new Error('Lead queue retry failed');
 } else if (flag === '--retry-status') {
  // Read-only aggregates (no personal data): queue, switch and pg_cron job state.
  const [status] = await management('database/query',{query:"select public.le_lead_retry_status() as status, (select to_jsonb(s) - 'function_url' from public.le_lead_retry_settings s where id=1) as settings, (select jsonb_agg(jsonb_build_object('jobid',jobid,'schedule',schedule,'active',active)) from cron.job where jobname='lady-elka-lead-retry') as cron, (select count(*) from vault.secrets where name='lady_elka_lead_retry_token') as vault_token"});
  console.log(JSON.stringify(status,null,2));
 } else if (flag === '--provision-retry-token') {
  // Creates ONE random token in both Vault and Edge secrets, only if neither exists. Never prints it. Does not enable anything.
  const [{n}] = await management('database/query',{query:"select count(*)::int as n from vault.secrets where name='lady_elka_lead_retry_token'"});
  const names = await (await fetch(`https://api.supabase.com/v1/projects/${project}/secrets`,{headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`},signal:AbortSignal.timeout(60000)})).json();
  const edge = names.some(x=>x.name==='LEAD_RETRY_TOKEN');
  if (n || edge) { console.log(JSON.stringify({vault:n>0,edge,changed:false,note:'already provisioned (or half-provisioned) - not overwritten'})); }
  else {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    await management('database/query',{query:`select vault.create_secret('${token}','lady_elka_lead_retry_token','Lady Elka lead outbox retry (pg_cron -> lead?action=retry)')`});
    const r = await fetch(`https://api.supabase.com/v1/projects/${project}/secrets`,{method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify([{name:'LEAD_RETRY_TOKEN',value:token}]),signal:AbortSignal.timeout(60000)});
    if (!r.ok) throw new Error(`Edge secret HTTP ${r.status}`);
    console.log(JSON.stringify({vault:true,edge:true,changed:true}));
  }
 } else throw new Error('Use --deploy, --live-test, --retry, --retry-status or --provision-retry-token');
} catch (error) { console.error(error.message.includes('http')?'Lead operation failed (details suppressed to protect secrets)':error.message);process.exitCode=1; }
