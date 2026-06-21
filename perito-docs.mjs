import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module'; import { randomUUID } from 'node:crypto';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');
const url = readFileSync('/var/www/vhosts/jbhasesorialegal.com/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const mysql = require('mysql2/promise'); const c = await mysql.createConnection(url);
const log=(...a)=>console.log('[docs]',...a);
try{
  const EMAIL='lballanti.lb+perito@gmail.com', LAWYER='31babca6-5b81-11f1-88c8-ee5423879f46', ORG='850720c1-82fa-4a9b-b1cd-0569d20abff9', CASE='06c96f56-a0b3-4de1-a6ad-d98e33c8e4aa';
  const [u]=await c.query("SELECT id FROM users WHERE email=?",[EMAIL]); const pid=u[0].id;
  const [docs]=await c.query("SELECT id FROM case_documents WHERE case_id=? AND deleted_at IS NULL LIMIT 4",[CASE]);
  let shared=0;
  for(const d of docs){const [e]=await c.query("SELECT id FROM perito_doc_grants WHERE perito_user_id=? AND document_id=?",[pid,d.id]); if(!e.length){await c.query("INSERT INTO perito_doc_grants (id,case_id,perito_user_id,org_id,document_id,granted_by_user_id) VALUES (?,?,?,?,?,?)",[randomUUID(),CASE,pid,ORG,d.id,LAWYER]); shared++;}}
  log('docs compartidos:',shared,'de',docs.length);
  log('OK perito listo: login en peritos.jbhasesorialegal.com con '+EMAIL+' (enlace mágico a tu gmail).');
  await c.end(); process.exit(0);
}catch(e){log('FATAL',e.message); try{await c.end()}catch{}; process.exit(1);}
