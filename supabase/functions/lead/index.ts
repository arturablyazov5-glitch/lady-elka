import { createLeadHandler } from './handler.mjs';
Deno.serve(createLeadHandler({ env: (key: string) => Deno.env.get(key) }));
