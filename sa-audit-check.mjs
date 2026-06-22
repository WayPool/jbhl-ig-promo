import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [cols]=await c.query("SELECT column_name cn FROM information_schema.columns WHERE table_name='superadmin_audit'");
console.log('superadmin_audit cols:', cols.map(r=>r.cn||r.CN||r.column_name||r.COLUMN_NAME).join(','));
// intenta el insert que hace la consola
try { await c.query("INSERT INTO superadmin_audit (id, actor_user_id, actor_email, action, target_org_id, target_user_id, detail, ip_hash, created_at) VALUES (UUID(),'x','x@x','console_view',NULL,NULL,NULL,'h',NOW())"); console.log('INSERT con target_user_id/detail: OK'); await c.query("DELETE FROM superadmin_audit WHERE actor_user_id='x'"); }
catch(e){ console.log('INSERT FALLA:', e.message); }
await c.end();
