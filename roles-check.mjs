import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [users]=await c.query("SELECT id,email,role FROM users WHERE email LIKE '%lballanti%' OR email LIKE '%perito%' ORDER BY email");
for(const u of users){
  const [extra]=await c.query("SELECT role FROM user_roles WHERE user_id=?",[u.id]);
  console.log(`${u.email}  canonico=${u.role}  extra=[${extra.map(r=>r.role).join(',')}]`);
}
await c.end();
