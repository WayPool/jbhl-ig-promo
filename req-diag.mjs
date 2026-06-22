import { execSync } from 'node:child_process'; import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const HOME=process.env.HOME, B='/var/www/vhosts/jbhasesorialegal.com';
// error message lines (antes del sql:)
try {
  const out = execSync(`${HOME}/.npm-global/bin/pm2 jlist`, { encoding:'utf8', env:{...process.env, PATH:'/opt/plesk/node/22/bin:'+(process.env.PATH||'')} });
  const p = JSON.parse(out).find(x=>x.name==='jbhlegal-portal');
  const log = readFileSync(p.pm2_env.pm_err_log_path,'utf8').split('\n');
  const idx = log.map((l,i)=>l.includes('org_custom_plan_requests')&&l.includes('sql:')?i:-1).filter(i=>i>=0).pop();
  if (idx) console.log('== error block ==\n'+log.slice(Math.max(0,idx-10), idx+1).join('\n'));
} catch(e){ console.log('log err', e.message); }
// columnas reales
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [cols]=await c.query("SELECT column_name cn, data_type dt FROM information_schema.columns WHERE table_name='org_custom_plan_requests' ORDER BY ordinal_position");
console.log('== org_custom_plan_requests cols ==', cols.map(r=>(r.cn||r.column_name||r.COLUMN_NAME)).join(','));
await c.end();
