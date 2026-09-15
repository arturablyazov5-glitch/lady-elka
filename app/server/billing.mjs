import './db.mjs';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createBilling} from '../../supabase/functions/_shared/billing.mjs';
const file=fileURLToPath(new URL('../data/billing.private.json',import.meta.url));
let queue=Promise.resolve();
async function read(){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {payments:[]};throw e;}}
function update(fn){const task=queue.then(async()=>{const state=await read();fn(state);await fs.writeFile(file+'.tmp',JSON.stringify(state),{mode:0o600});await fs.rename(file+'.tmp',file);});queue=task.catch(()=>{});return task;}
export const billing=createBilling({read,update,env:key=>process.env[key]});
