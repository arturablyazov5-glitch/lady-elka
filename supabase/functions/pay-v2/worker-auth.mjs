// pg_net queue may be readable to public roles. Never put the reusable worker secret in it.
export async function workerSignature(secret, action, timestamp, nonce) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${action}:${timestamp}:${nonce}`));
  return [...new Uint8Array(signature)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function authenticateWorker(request,{secret,claim,now=()=>Date.now()}) {
 const action=new URL(request.url).searchParams.get('action');
 const time=request.headers.get('x-worker-time')||'',nonce=request.headers.get('x-worker-nonce')||'',signature=request.headers.get('x-worker-signature')||'';
 if(!secret||secret.length<32||!/^\d{10}$/.test(time)||Math.abs(Math.floor(now()/1000)-Number(time))>120
   ||!/^[0-9a-f-]{36}$/i.test(nonce)||!/^[0-9a-f]{64}$/.test(signature))return 401;
 const expected=await workerSignature(secret,action,time,nonce);let diff=0;
 for(let i=0;i<64;i++)diff|=signature.charCodeAt(i)^expected.charCodeAt(i);
 if(diff)return 401;
 try {return await claim(`v2-worker:${action}:${nonce}`)?0:409;}catch{return 503;}
}
