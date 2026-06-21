import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');
const url = readFileSync('/var/www/vhosts/jbhasesorialegal.com/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const mysql = require('mysql2/promise'); const c = await mysql.createConnection(url);
const JBH='00000000-0000-4000-8000-0000000a1b01';
console.log('=== Expedientes activos GLOBAL (lo que vería el superadmin) ===');
const [rows] = await c.query(
  "SELECT c.expediente_num, o.name org, c.status, c.org_id=? jbh FROM cases c JOIN organizations o ON o.id=c.org_id WHERE c.deleted_at IS NULL AND c.status <> 'cerrado' ORDER BY c.updated_at DESC",[JBH]);
for (const r of rows) console.log(`  ${r.expediente_num} | ${r.org} | ${r.status} | ${r.jbh? 'JBH':'despacho'}`);
console.log('total activos:', rows.length);
console.log('=== en JBH (lo que muestra el Resumen) ===');
const [j] = await c.query("SELECT COUNT(*) n FROM cases WHERE org_id=? AND deleted_at IS NULL AND status<>'cerrado'",[JBH]);
console.log('  JBH activos:', j[0].n);
await c.end();
