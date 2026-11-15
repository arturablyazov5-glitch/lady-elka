import {createServer as nodeServer} from 'node:http';
export const productionReady=false;
const routes=new Map([
 ['/v2/create','create'],['/v2/status','status'],['/v2/callback','callback'],
 ['/v2/internal/poll','internal-poll'],['/v2/internal/retry','internal-retry'],
]);
// Trusted composition only; credentials are forwarded unchanged, never provisioned here.
export function createServer({gateway,origins=[],maxBodyBytes=64*1024,timeoutMs=5000}={}) {
 if(typeof gateway!=='function'||!Array.isArray(origins)||origins.some(o=>{try{return new URL(o).origin!==o||o==='null';}catch{return true;}})||!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647) throw new TypeError('INVALID_CONFIG');
 const allowed=new Set(origins);
 const server=nodeServer((req,res)=>{
  const controller=new AbortController();
  const deadline=Date.now()+timeoutMs;
  let done=false,size=0,chunks=[];
  const origin=req.headers.origin;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(origin&&allowed.has(origin)) Object.assign(headers,{'Access-Control-Allow-Origin':origin});
  const finish=(status,body,extra={})=>{
   if(done)return;done=true;clearTimeout(timer);chunks=[];
   if(!res.destroyed){res.writeHead(status,{...headers,...extra});res.end(JSON.stringify(body));}
  };
  const timer=setTimeout(()=>{controller.abort();finish(504,{error:'GATEWAY_TIMEOUT'});},timeoutMs);
  const disconnect=()=>{controller.abort();if(!done){done=true;clearTimeout(timer);chunks=[];}};
  req.on('aborted',disconnect);req.on('error',disconnect);
  res.on('close',()=>{if(!res.writableFinished)disconnect();});
  // Exact paths only: no query-based route or credential selection.
  const route=routes.get(req.url);
  if(!route){finish(404,{error:'ROUTE_NOT_FOUND'});req.resume();return;}
  if(origin&&!allowed.has(origin)){finish(403,{error:'ORIGIN_FORBIDDEN'});req.resume();return;}
  if(req.method==='OPTIONS'){
   if(!origin||req.headers['access-control-request-method']!=='POST'||(req.headers['access-control-request-headers']||'').split(',').some(h=>h.trim()&&!['content-type','authorization'].includes(h.trim().toLowerCase())))finish(403,{error:'PREFLIGHT_FORBIDDEN'});
   else finish(204,undefined,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Authorization'});
   req.resume();return;
  }
  if(req.method!=='POST'){finish(405,{error:'METHOD_NOT_ALLOWED'},{Allow:'POST, OPTIONS'});req.resume();return;}
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')){finish(415,{error:'UNSUPPORTED_MEDIA_TYPE'});req.resume();return;}
  if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'){finish(415,{error:'UNSUPPORTED_ENCODING'});req.resume();return;}
  req.on('data',chunk=>{
   if(done)return;size+=chunk.length;
   if(size>maxBodyBytes){controller.abort();finish(413,{error:'BODY_TOO_LARGE'});req.resume();return;}
   chunks.push(chunk);
  });
  req.on('end',async()=>{
   if(done)return;
   let body;
   const rawBody=Buffer.concat(chunks);
   try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody));if(body===null||Array.isArray(body)||typeof body!=='object')throw Error();}
   catch{finish(400,{error:'INVALID_JSON'});return;}
   chunks=[];
   try{
    const result=await gateway({route,body,credentials:req.headers.authorization,request:{method:req.method,url:req.url,headers:{...req.headers},rawBody},signal:controller.signal,deadline});
    if(done)return;
    if(!Number.isInteger(result?.status)||result.status<200||result.status>599||result.body===undefined)throw Error();
    const extra={};
    if(result.status===429){const retry=result.headers?.['Retry-After'];extra['Retry-After']=/^\d+$/.test(String(retry))&&Number(retry)>0?String(retry):'1';}
    // No arbitrary gateway headers, thrown error messages or request metadata reach clients.
    const serialized=JSON.stringify(result.body);
    if(serialized===undefined)throw Error();
    finish(result.status,result.body,extra);
   }catch{finish(503,{error:'BACKEND_UNAVAILABLE'});}
  });
 });
 server.requestTimeout=timeoutMs;server.headersTimeout=timeoutMs;server.timeout=timeoutMs;
 const listen=server.listen.bind(server);
 server.listen=(...args)=>{
  if(args.length===0)args=[0,'127.0.0.1'];
  else if(args[0]&&typeof args[0]==='object')args[0]={...args[0],host:args[0].host??'127.0.0.1'};
  else if(typeof args[0]==='number'&&(args.length===1||typeof args[1]==='function'))args.splice(1,0,'127.0.0.1');
  return listen(...args);
 };
 return server;
}
