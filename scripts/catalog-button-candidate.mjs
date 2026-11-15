// Isolate TASK-BUTTON from pending login-limit changes: production v8 + publication only.
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
const backup='agent-context/catalog-v8-backup';
const target='agent-context/catalog-button-candidate';
const live=await readFile(backup+'/supabase/functions/catalog/index.ts','utf8');
const local=await readFile('supabase/functions/catalog/index.ts','utf8');
const start=local.indexOf('// GitHub credential lives only');
const end=local.indexOf('Deno.serve(async req => {',start);
const routesStart=local.indexOf("    if (route === '/api/publish-site'");
const routesEnd=local.indexOf("    if(route.startsWith('/api/billing/'))",routesStart);
if([start,end,routesStart,routesEnd].some(i=>i<0))throw new Error('Publication source markers missing');
let source=live.replace('Deno.serve(async req => {',local.slice(start,end).replaceAll('extraHeaders','feedWarnings')+'Deno.serve(async req => {');
source=source.replace("    if(route.startsWith('/api/billing/'))",local.slice(routesStart,routesEnd)+"    if(route.startsWith('/api/billing/'))");
source=source.replace("'Access-Control-Expose-Headers': 'X-Feed-Warning'", "'Access-Control-Expose-Headers': 'X-Feed-Warning, Retry-After'");
await mkdir(target+'/supabase/functions/catalog',{recursive:true});
await cp(backup+'/supabase/functions/_shared',target+'/supabase/functions/_shared',{recursive:true});
await writeFile(target+'/supabase/functions/catalog/index.ts',source);
await writeFile(target+'/supabase/config.toml','[functions.catalog]\nverify_jwt = false\n');
console.log('Prepared v8-based catalog publication candidate (no deployment)');
