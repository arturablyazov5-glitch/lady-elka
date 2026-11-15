// Reuse existing local checkout browser scenarios with a current masked-phone fixture.
// The original runner predates phone-mask.js and expects its raw value after F5.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const source=await readFile('storefront/tests/checkout-browser-offline-run.mjs','utf8');
const before="value='+79990000000'";
if(!source.includes(before))throw new Error('Checkout fixture changed; review adaptation');
const directory=await mkdtemp(join(process.cwd(),'storefront/tests/.forms-checkout-'));
try {
 const script=join(directory,'runner.mjs');await writeFile(script,source.replace(before,"value='+7 (999) 000-00-00'"));
 const {stdout}=await promisify(execFile)(process.execPath,[script],{cwd:process.cwd(),maxBuffer:4*1024*1024,timeout:60000});
 const report=JSON.parse(stdout.slice(stdout.indexOf('{'),stdout.lastIndexOf('}')+1));
 await writeFile('agent-context/forms-checkout-browser-report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({scenarios:report.scenarios,browser:'Chrome',fixture:'masked phone',network:'local only'}));
}finally{await rm(directory,{recursive:true,force:true});}
