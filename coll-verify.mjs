import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const q=`SELECT table_name t, column_name col, collation_name coll FROM information_schema.columns WHERE (table_name='org_custom_plan_requests' AND column_name IN ('org_id','requested_by_user_id','id')) OR (table_name='organizations' AND column_name='id') OR (table_name='users' AND column_name='id')`;
const [rows]=await c.query(q);
for(const r of rows) console.log(`${r.t||r.T}.${r.col||r.COL}: ${r.coll||r.COLL||r.collation_name}`);
await c.end();
