// Local cabinet forwards authenticated requests to catalog; GitHub credentials stay in Edge.
import {createHmac,randomUUID} from 'node:crypto';
const endpoint='https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/catalog';
export async function forwardSitePublish(route,{env=process.env,request=fetch}={}){
 if(!['/api/publish-site','/api/publish-status'].includes(route))throw new Error('Unknown publication route');
 const secret=env.CATALOG_SESSION_SECRET;
 if(!secret)return {status:503,data:{error:'Не настроено подключение кабинета к публикации сайта.'},headers:{}};
 const payload=Buffer.from(JSON.stringify({exp:Date.now()+60000,nonce:randomUUID()})).toString('base64url');
 const token=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
 try{
  const res=await request(endpoint+route,{method:route==='/api/publish-site'?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Catalog-Request':'1'},...(route==='/api/publish-site'?{body:'{}'}:{}),signal:AbortSignal.timeout(25000)});
  const data=await res.json();
  const retry=Number(res.headers.get('Retry-After'));
  return {status:res.status,data,headers:retry>0?{'Retry-After':String(Math.min(60,Math.ceil(retry)))}:{}};
 }catch{return {status:502,data:{error:'Нет подтверждения от сервера публикации. Проверьте статус перед повторной отправкой.'},headers:{}};}
}
