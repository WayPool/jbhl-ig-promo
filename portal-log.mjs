import { execSync } from 'node:child_process'; import { readFileSync } from 'node:fs';
const HOME=process.env.HOME;
try {
  const out = execSync(`${HOME}/.npm-global/bin/pm2 jlist`, { encoding:'utf8', env:{...process.env, PATH:'/opt/plesk/node/22/bin:'+(process.env.PATH||'')} });
  const a = JSON.parse(out); const p = a.find(x=>x.name==='jbhlegal-portal');
  const errPath = p?.pm2_env?.pm_err_log_path, outPath = p?.pm2_env?.pm_out_log_path;
  console.log('errPath:', errPath); console.log('outPath:', outPath);
  for (const [lbl,path] of [['ERR',errPath],['OUT',outPath]]) {
    try { const log = readFileSync(path,'utf8').split('\n'); console.log(`== ${lbl} last 45 ==`); console.log(log.slice(-45).join('\n')); } catch(e){ console.log(lbl,'read err',e.message); }
  }
} catch(e){ console.log('jlist err', e.message); }
