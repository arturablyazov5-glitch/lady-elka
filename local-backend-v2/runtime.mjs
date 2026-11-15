import {createHttpAuth} from './http-auth.mjs';
import {createGateway} from './gateway.mjs';
import {createServer} from './http-server.mjs';
export const productionReady=false;
const configError=field=>{throw new TypeError(`RUNTIME_CONFIG:${field}`);};
const fn=(x,field)=>{if(typeof x!=='function')configError(field);};
function safeURL(value,originOnly=false){
 try{const u=new URL(value);return typeof value==='string'&&!u.username&&!u.password&&!u.hash&&
  (u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname)))&&
  (!originOnly||u.origin===value);}catch{return false;}
}
export function createRuntime(options={}){
 const {executors,identity,verifyCatalog,verifySession,capabilityStore,verifyCallback,verifyInternal,provider,notifier,recipients,origins,paymentOrigins,localCreateEnabled=false,cleanup,shutdownMs=1000,maxBodyBytes,timeoutMs,evidencePolicy}=options;
 for(const role of ['create','status','callback','internal'])fn(executors?.[role]?.query,`executors.${role}`);
 if(identity?.apiVersion!=='2'||identity?.fingerprintVersion!=='sha256-canonical-json-v1'||!safeURL(identity?.ownerEndpoint))configError('identity');
 for(const [field,value] of Object.entries({verifyCatalog,verifySession,verifyCallback,verifyInternal}))fn(value,field);
 fn(capabilityStore?.resolve,'capabilityStore.resolve');fn(provider?.register,'provider.register');fn(provider?.evidence,'provider.evidence');fn(notifier?.send,'notifier.send');
 if(!Array.isArray(recipients)||!recipients.length||recipients.length>20||recipients.some(r=>typeof r!=='string'||!r))configError('recipients');
 for(const [field,value] of Object.entries({origins,paymentOrigins}))if(!Array.isArray(value)||value.some(o=>!safeURL(o,true)))configError(field);
 if(typeof localCreateEnabled!=='boolean')configError('localCreateEnabled');
 if(cleanup!==undefined)fn(cleanup,'cleanup');
 if(!Number.isSafeInteger(shutdownMs)||shutdownMs<1||shutdownMs>2147483647)configError('shutdownMs');
 const auth=createHttpAuth({verifySession,capabilityStore,verifyCallback,verifyInternal});
 // Freeze public identity fields to prevent accidentally serializing private config.
 const gateway=createGateway({executors,identity:{apiVersion:identity.apiVersion,fingerprintVersion:identity.fingerprintVersion,ownerEndpoint:identity.ownerEndpoint},verifyCatalog,auth:auth.auth,provider,notifier,recipients:[...recipients],paymentOrigins:[...paymentOrigins],evidencePolicy});
 const active=new Set(),sockets=new Set();let state='new',shutdownPromise;
 const server=createServer({origins:[...origins],maxBodyBytes,timeoutMs,gateway:async input=>{
  if(state==='closing'||state==='closed')return {status:503,body:{error:'RUNTIME_CLOSING'}};
  if(input.route==='create'&&!localCreateEnabled)return {status:503,body:{error:'CREATE_CLOSED'}};
  const controller=new AbortController();const abort=()=>controller.abort();
  input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();active.add(controller);
  try{return await auth.dispatch(gateway,{...input,signal:controller.signal});}
  finally{active.delete(controller);input.signal.removeEventListener('abort',abort);}
 }});
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));if(state==='closing'||state==='closed')socket.destroy();});
 async function listen({port=0,host='127.0.0.1'}={}){
  if(state!=='new')throw new Error('RUNTIME_LISTEN_STATE');
  if(!Number.isInteger(port)||port<0||port>65535||!['127.0.0.1','::1'].includes(host))configError('listen');
  state='listening';
  await new Promise((resolve,reject)=>{
   const error=e=>{server.removeListener('listening',ready);if(state==='listening')state='new';reject(e);};
   const ready=()=>{server.removeListener('error',error);resolve();};server.once('error',error);server.once('listening',ready);server.listen({port,host});
  });
  if(state!=='listening')throw new Error('RUNTIME_CLOSING');
  return server.address();
 }
 function shutdown(){
  if(shutdownPromise)return shutdownPromise;
  state='closing';const deadline=Date.now()+shutdownMs;const controller=new AbortController();
  for(const request of active)request.abort();
  const closed=new Promise(resolve=>server.close(()=>resolve()));
  for(const socket of sockets)socket.destroy();server.closeAllConnections();
  shutdownPromise=(async()=>{
   let timer;const bounded=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({timedOut:true});},shutdownMs);});
   const work=(async()=>{await closed;if(cleanup)await cleanup({signal:controller.signal,deadline});return {timedOut:false};})().catch(()=>({timedOut:false,cleanupFailed:true}));
   try{return await Promise.race([work,bounded]);}finally{clearTimeout(timer);state='closed';}
  })();
  return shutdownPromise;
 }
 return Object.freeze({listen,shutdown});
}
