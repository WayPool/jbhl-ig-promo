import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const tables=['client_invitations','member_invitations','case_proposals','colegiado_identities','colegiado_challenges','superadmin_audit'];
for(const t of tables){
  const [[r]]=await c.query("SELECT table_collation FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",[t]);
  if(!r){console.log(`${t}: NO EXISTE (skip)`);continue;}
  if(r.table_collation==='utf8mb4_general_ci'){console.log(`${t}: ya general_ci ✓`);continue;}
  console.log(`${t}: ${r.table_collation} -> convirtiendo...`);
  await c.query(`ALTER TABLE \`${t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  const [[r2]]=await c.query("SELECT table_collation FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",[t]);
  console.log(`  ✅ ${t}: ahora ${r2.table_collation}`);
}
await c.end();
