// Inject a local SQL executor. This is NOT a PostgREST/service_role adapter.
export function sqlStore(db) {
 const q = async (sql,args=[]) => (await db.query(sql,args)).rows;
 return {
  ready: async()=> { await q('SELECT id FROM le_checkout_v2.orders LIMIT 0'); },
  consume: async (budget,owner)=>q('SELECT le_checkout_v2.consume_window($1,$2)',[budget,owner]),
  reserve: async x => (await q('SELECT * FROM le_checkout_v2.reserve_order($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',[x.id,x.owner,x.fingerprint,x.bankNumber,x.amount,x.method,JSON.stringify(x.recipients),x.budget,x.open]))[0],
  get: async id => (await q('SELECT * FROM le_checkout_v2.orders WHERE id=$1',[id]))[0],
  byPayment: async id => (await q('SELECT * FROM le_checkout_v2.orders WHERE payment_id=$1',[id]))[0],
  claim: async (key,id,budget) => (await q('SELECT le_checkout_v2.claim_effect($1,$2,$3) AS ok',[key,id,budget]))[0].ok,
  finish: async (key,state,result=null) => q("UPDATE le_checkout_v2.effects SET state=$2,result=$3::jsonb WHERE key=$1 AND state='running'",[key,state,JSON.stringify(result)]),
  bind: async (id,payment,result) => db.transaction(async tx=> {
   await tx.query("UPDATE le_checkout_v2.orders SET payment_id=$2,status='awaiting_payment',payment_url=$3,provider_result=$4::jsonb WHERE id=$1 AND payment_id IS NULL",[id,payment,result?.paymentURL||null,JSON.stringify(result||null)]);
   await tx.query('INSERT INTO le_checkout_v2.bank_queue VALUES($1,$2)',[id,payment]);
  }),
  // Review cannot overwrite a durable provider binding or terminal payment.
  status: async(id,status)=>q("UPDATE le_checkout_v2.orders SET status=$2 WHERE id=$1 AND status<>'paid' AND ($2<>'pending_review' OR payment_id IS NULL)",[id,status]),
  recover: async(o,e)=>(await q('SELECT le_checkout_v2.recover_bank_order($1,$2,$3,$4,$5::jsonb) AS ok',[o.id,e.paymentId,e.bankNumber,e.amount,JSON.stringify({verified:e.verified,status:e.status,paymentId:e.paymentId,bankNumber:e.bankNumber,amount:e.amount,observedAt:e.observedAt})]))[0].ok,
  pollable: async(limit)=>q("SELECT o.* FROM le_checkout_v2.bank_queue q JOIN le_checkout_v2.orders o ON o.id=q.order_id AND o.payment_id=q.payment_id WHERE o.method='card' AND o.status='awaiting_payment' ORDER BY o.id LIMIT $1",[limit]),
  pending: async(limit)=>(await q("SELECT * FROM le_checkout_v2.orders WHERE status IN ('accepted','paid') ORDER BY id LIMIT $1",[limit])),
 };
}
