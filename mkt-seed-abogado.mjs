import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const B='/var/www/vhosts/jbhasesorialegal.com';
const LOG=B+'/site2/.well-known/_seed.txt';
const log=(s)=>{ try{appendFileSync(LOG,s+'\n');}catch{} };
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
log('START seed abogado '+new Date().toISOString());
const [o]=await c.query("SELECT audiences,enabled_channels FROM marketing_settings WHERE id='global'");
const origChannels = o[0].enabled_channels;
await c.query("UPDATE marketing_settings SET audiences=?, enabled_channels=? WHERE id='global'", [JSON.stringify(["abogado"]), JSON.stringify(["blog"])]);
const N=5;
for(let i=1;i<=N;i++){
  await c.query("UPDATE marketing_settings SET last_run_at=NULL WHERE id='global'");
  try{
    const out=execSync(`/opt/plesk/node/22/bin/node --env-file=${B}/shared/portal.env ${B}/workers/marketing-worker-entry.cjs`,{encoding:'utf8',timeout:150000});
    const last=out.trim().split('\n').filter(Boolean).pop();
    log(`#${i} ${last}`);
  }catch(e){ log(`#${i} ERR ${(e.message||'').slice(0,120)}`); }
}
await c.query("UPDATE marketing_settings SET audiences=?, enabled_channels=? WHERE id='global'", [JSON.stringify(["cliente","abogado","perito"]), origChannels]);
const [pieces]=await c.query("SELECT title,slug,status,channel FROM content_pieces WHERE audience='abogado' ORDER BY created_at DESC LIMIT 12");
log('PIECES_ABOGADO='+pieces.length);
for(const p of pieces) log(`  [${p.status}/${p.channel}] ${p.title} -> /insights/${p.slug}`);
log('DONE restaurado audiences=[cliente,abogado,perito]');
await c.end();
