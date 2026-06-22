import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const env = readFileSync(B+'/shared/portal.env','utf8');
const get=(k)=>env.split('\n').find(l=>l.startsWith(k+'='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
console.log('R2 endpoint:', get('R2_ENDPOINT')||get('STORAGE_ENDPOINT')||'(?)');
console.log('R2 bucket prod:', get('R2_BUCKET_PROD')||get('R2_BUCKET')||'(?)','| quarantine:', get('R2_BUCKET_QUARANTINE')||'(?)');
const url = env.split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
for (const [t,col] of [['case_documents','size_bytes'],['intake_documents','size_bytes']]) {
  try { const [r]=await c.query(`SELECT COUNT(*) n, COALESCE(SUM(${col}),0) b FROM ${t} WHERE deleted_at IS NULL`); const n=r[0].n||r[0].N, b=Number(r[0].b||r[0].B||0); console.log(`${t}: ${n} docs, ${(b/1073741824).toFixed(3)} GB`); }
  catch(e){ console.log(`${t}: ${e.message.slice(0,60)}`); }
}
await c.end();
