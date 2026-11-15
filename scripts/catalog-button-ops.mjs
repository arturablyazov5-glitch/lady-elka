// Explicit operational steps only. Never db push or deploy unrelated functions.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {leadEnv} from './lead-env.mjs';
const project='mgnotvaahftrbifqtahf',backup='agent-context/catalog-v8-backup',candidate='agent-context/catalog-button-candidate';
const migration='supabase/migrations/20261010120000_catalog_publish_limit.sql';
const mode=process.argv[2],env=await leadEnv();
async function cli(args,input){
 const child=spawn('supabase',args,{env,stdio:['pipe','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();child.stdin.end(input);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 if(code!==0)throw new Error('Supabase CLI operation failed (output suppressed)');
}
async function setDispatchSecret(){
 const dir=await mkdtemp(join(tmpdir(),'le-dispatch-'));
 try{
  const file=join(dir,'secret.env');
  await writeFile(file,`GITHUB_DISPATCH_TOKEN=${env.GITHUB_DISPATCH_TOKEN}\n`,{mode:0o600});
  await cli(['secrets','set','--project-ref',project,'--env-file',file]);
 }finally{await rm(dir,{recursive:true,force:true});}
}
function current(){
 return JSON.parse(execFileSync('supabase',['functions','list','--project-ref',project,'-o','json'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']})).find(f=>f.slug==='catalog');
}
async function verifyBackup(){
 const manifest=JSON.parse(await readFile(backup+'/manifest.json','utf8'));
 if(manifest.catalog.version!==8||manifest.catalog.verify_jwt!==false)throw new Error('Invalid rollback manifest');
 for(const [file,hash] of Object.entries(manifest.hashes))if(createHash('sha256').update(await readFile(backup+'/supabase/functions/'+file)).digest('hex')!==hash)throw new Error('Rollback file changed');
 return manifest;
}
async function query(sql){
 if(!env.SUPABASE_ACCESS_TOKEN)throw new Error('SUPABASE_ACCESS_TOKEN unavailable for targeted migration');
 const res=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(60000)});
 if(!res.ok)throw new Error('Targeted migration failed (details suppressed)');return res.json();
}
try{
 if(mode==='--set-secret'){
  execFileSync('git',['check-ignore','--quiet','Переменные окружения.ini']);
  if(!env.GITHUB_DISPATCH_TOKEN)throw new Error('Owner must first create scoped GitHub PAT; token unavailable');
  if(!/^github_pat_[a-zA-Z0-9_]+$/.test(env.GITHUB_DISPATCH_TOKEN))throw new Error('Expected fine-grained GitHub PAT');
  await setDispatchSecret();
  console.log('GITHUB_DISPATCH_TOKEN set through temporary 0600 env file, removed; value not logged');
 }else if(mode==='--deploy'){
  if(!env.GITHUB_DISPATCH_TOKEN)throw new Error('Token unavailable; no migration or deployment performed');
  if(!/^github_pat_[a-zA-Z0-9_]+$/.test(env.GITHUB_DISPATCH_TOKEN))throw new Error('Expected fine-grained GitHub PAT');
  const manifest=await verifyBackup(),before=current();
  // Updating project secrets can increment the version without changing the v8 bundle.
  if(before.version<8||before.ezbr_sha256!==manifest.catalog.ezbr_sha256||before.verify_jwt!==manifest.catalog.verify_jwt)throw new Error('Live function changed; recapture rollback and review before deploying');
  // Candidate generator overlays only new publication code onto captured v8.
  execFileSync(process.execPath,['scripts/catalog-button-candidate.mjs'],{stdio:'ignore'});
  await setDispatchSecret();
  await query('begin;\n'+await readFile(migration,'utf8')+'\ncommit;');
  console.log('Applied only '+migration);
  await cli(['functions','deploy','catalog','--project-ref',project,'--no-verify-jwt','--use-api','--workdir',candidate]);
  const after=current();
  await writeFile('agent-context/task-button-deploy.json',JSON.stringify({time:new Date().toISOString(),before:before.version,after:after.version,migration,workdir:candidate},null,2)+'\n');
  console.log('Deployed catalog version '+after.version+'; run post-deployment checks before trial');
 }else if(mode==='--rollback'){
  await verifyBackup();
  await cli(['functions','deploy','catalog','--project-ref',project,'--no-verify-jwt','--use-api','--workdir',backup]);
  console.log('Restored captured v8 code; Supabase assigns new version '+current().version+'. Admission migration retained safely.');
 }else throw new Error('Use --set-secret, --deploy or --rollback');
}catch(error){console.error(/^[A-Za-z0-9_ ;:.\/-]+$/.test(error.message)?error.message:'Catalog operation failed (details suppressed)');process.exitCode=1;}
