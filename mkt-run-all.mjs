import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const B='/var/www/vhosts/jbhasesorialegal.com';
const LOG=B+'/site2/.well-known/_all.txt';
const log=(s)=>{ try{appendFileSync(LOG,s+'\n');}catch{} };
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
log('START run-all '+new Date().toISOString());
const [o]=await c.query("SELECT enabled_channels FROM marketing_settings WHERE id='global'");
const origCh=o[0].enabled_channels;
// solo blog para esta corrida (evita avisos de social) + limpia dedup del día
await c.query("UPDATE marketing_settings SET enabled_channels=?, last_run_at=NULL WHERE id='global'", [JSON.stringify(["blog"])]);
try{
  const out=execSync(`/opt/plesk/node/22/bin/node --env-file=${B}/shared/portal.env ${B}/workers/marketing-worker-entry.cjs`,{encoding:'utf8',timeout:300000});
  log('WORKER '+out.trim().split('\n').filter(Boolean).pop());
}catch(e){ log('ERR '+(e.message||'').slice(0,200)); }
await c.query("UPDATE marketing_settings SET enabled_channels=? WHERE id='global'", [origCh]);
// piezas creadas hoy por audiencia
const [pieces]=await c.query("SELECT audience,title,slug,status FROM content_pieces WHERE channel='blog' AND created_at >= UTC_DATE() ORDER BY created_at DESC LIMIT 12");
log('BLOGS_HOY='+pieces.length);
for(const p of pieces) log(`  [${p.audience}/${p.status}] ${p.title} -> /insights/${p.slug}`);
log('DONE (canales restaurados)');
await c.end();
