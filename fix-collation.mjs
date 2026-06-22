import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
// colación objetivo = la de organizations (unicode_ci)
const [[org]]=await c.query("SELECT table_collation tc FROM information_schema.tables WHERE table_name='organizations'");
const target = org.tc || org.TABLE_COLLATION || 'utf8mb4_unicode_ci';
console.log('target collation:', target);
await c.query(`ALTER TABLE org_custom_plan_requests CONVERT TO CHARACTER SET utf8mb4 COLLATE ${target}`);
console.log('CONVERT OK');
// verifica la consulta que fallaba
const [r]=await c.query("SELECT r.id, o.name, u.name FROM org_custom_plan_requests r LEFT JOIN organizations o ON o.id=r.org_id LEFT JOIN users u ON u.id=r.requested_by_user_id WHERE r.status='pending' ORDER BY r.created_at DESC");
console.log('JOIN query OK, filas:', r.length);
await c.end();
