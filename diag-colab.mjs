import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');
const url = readFileSync('/var/www/vhosts/jbhasesorialegal.com/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const mysql = require('mysql2/promise');
const c = await mysql.createConnection(url);
const [us] = await c.query("SELECT id,name,email,role FROM users WHERE name LIKE '%Lorenzo%' OR email LIKE '%lorenzo%' OR email LIKE '%lballanti%'");
console.log('USERS:'); for (const u of us) console.log(`  ${u.id} | ${u.role} | ${u.email} | ${u.name}`);
const ids = us.map(u=>u.id);
if (ids.length){
  const [ms] = await c.query("SELECT user_id,org_id,role,status FROM memberships WHERE user_id IN (?)",[ids]);
  console.log('MEMBERSHIPS:'); for (const m of ms) console.log(`  user=${m.user_id.slice(0,8)} org=${m.org_id} role=${m.role} ${m.status}`);
  const [cs] = await c.query("SELECT id,expediente_num,org_id,lead_lawyer_id,case_model,status FROM cases WHERE lead_lawyer_id IN (?) OR client_user_id IN (?) ORDER BY created_at DESC LIMIT 15",[ids,ids]);
  console.log('CASES (lead o cliente = Lorenzo):'); for (const x of cs) console.log(`  ${x.expediente_num||x.id.slice(0,8)} org=${x.org_id} lead=${(x.lead_lawyer_id||'—').slice(0,8)} model=${x.case_model} ${x.status}`);
}
const [orgs] = await c.query("SELECT id,type,name FROM organizations");
console.log('ORGS:'); for (const o of orgs) console.log(`  ${o.id} ${o.type} ${o.name}`);
await c.end();
