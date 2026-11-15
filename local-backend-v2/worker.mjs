// One bounded pass, no scheduler and no registration retries. Adapters must honor signal.
export async function pollPayments({store,provider,complete,batch=20,deadline,signal,now=Date.now}) {
 if(!Number.isInteger(batch)||batch<1||batch>20||!Number.isSafeInteger(deadline)||deadline-now()>2147483647) throw new Error('WORKER_CONFIG_INVALID');
 const controller=new AbortController();
 const abort=()=>controller.abort();
 signal?.addEventListener('abort',abort,{once:true});
 if(signal?.aborted) abort();
 const timer=setTimeout(abort,Math.max(0,deadline-now()));
 let processed=0;
 const bounded=async task=>{
  if(controller.signal.aborted||now()>=deadline) return null;
  let listener;
  const cancelled=new Promise(resolve=>{listener=()=>resolve(null);controller.signal.addEventListener('abort',listener,{once:true});});
  try{return await Promise.race([Promise.resolve().then(task),cancelled]);}
  finally{controller.signal.removeEventListener('abort',listener);}
 };
 try {
  const orders=await bounded(()=>store.pollable(batch));
  for(const o of orders||[]) {
   if(controller.signal.aborted||now()>=deadline) break;
   try {
    const e=await bounded(()=>provider.evidence(o.payment_id,{signal:controller.signal,deadline}));
    if(controller.signal.aborted||now()>=deadline) break;
    if(e) await bounded(()=>complete(o,e,{signal:controller.signal,deadline}));
    processed++;
   } catch {processed++;} // uncertain evidence stays queued; no in-pass retry
  }
  return {processed,stopped:controller.signal.aborted||now()>=deadline};
 } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
