import {createBilling} from './billing.mjs';
// Compare-and-swap prevents simultaneous callbacks from extending access twice.
export function databaseBilling(db,env){
 async function row(){const rows=await db('le_pro_billing?id=eq.1');if(!rows[0])throw new Error('Не создано хранилище подписки');return rows[0];}
 async function update(fn){for(let i=0;i<8;i++){const r=await row();fn(r.payload);const result=await db(`le_pro_billing?id=eq.1&revision=eq.${r.revision}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({payload:r.payload,revision:r.revision+1})});if(result.length)return;}throw Object.assign(new Error('Подписка обновляется. Повторите запрос.'),{status:409});}
 return createBilling({read:async()=>(await row()).payload,update,env});
}
