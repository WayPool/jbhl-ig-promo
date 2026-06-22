import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const ORG='850720c1-82fa-4a9b-b1cd-0569d20abff9';
const m = require('mysql2/promise'); const c = await m.createConnection(url);
await c.query(
  "UPDATE organizations SET colegiado_verified_at=NOW(), "+
  "colegiado_name=COALESCE(colegiado_name,'Lorenzo Ballanti Morán'), "+
  "colegiado_num=COALESCE(NULLIF(colegiado_num,''), NULLIF(num_colegiado,''), 'TEST-ACA-0001'), "+
  "colegiado_cert_serial=COALESCE(colegiado_cert_serial,'TEST-VERIFICACION-MANUAL') "+
  "WHERE id=? AND type='law_firm'", [ORG]);
const [r]=await c.query("SELECT name,type,colegiado_verified_at,colegiado_name,colegiado_num,colegiado_cert_serial FROM organizations WHERE id=?",[ORG]);
console.log('UPDATED', JSON.stringify(r[0]));
await c.end();
