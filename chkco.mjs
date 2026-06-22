import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [[r]]=await c.query("SELECT table_collation FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='superadmin_audit'");
if(!r){console.log('superadmin_audit: NO EXISTE');}
else if(r.table_collation==='utf8mb4_general_ci'){console.log('superadmin_audit: general_ci ✓');}
else{console.log('superadmin_audit:',r.table_collation,'-> convirtiendo'); await c.query("ALTER TABLE `superadmin_audit` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"); console.log('  ✅ convertida');}
// resumen final de las 6
const [rows]=await c.query("SELECT table_name,table_collation FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('client_invitations','member_invitations','case_proposals','colegiado_identities','colegiado_challenges','superadmin_audit')");
console.log('RESUMEN:'); rows.forEach(x=>console.log(`  ${x.TABLE_NAME||x.table_name}: ${x.TABLE_COLLATION||x.table_collation}`));
await c.end();
