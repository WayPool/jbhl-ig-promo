import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [orgs]=await c.query("SELECT id,name,type,colegiado_verified_at,colegiado_name,colegiado_num FROM organizations ORDER BY type,name");
for(const o of orgs){
  const [owner]=await c.query("SELECT u.email FROM memberships mem JOIN users u ON u.id=mem.user_id WHERE mem.org_id=? AND mem.role IN ('OWNER','FIRM_ADMIN') LIMIT 1",[o.id]);
  console.log(`[${o.type}] ${o.name}  id=${o.id}  verif=${o.colegiado_verified_at?'SI('+o.colegiado_name+')':'NO'}  owner=${owner[0]?.email||'-'}`);
}
await c.end();
