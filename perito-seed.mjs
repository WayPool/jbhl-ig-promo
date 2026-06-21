import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module'; import { randomUUID } from 'node:crypto';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');
const url = readFileSync('/var/www/vhosts/jbhasesorialegal.com/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const mysql = require('mysql2/promise'); const c = await mysql.createConnection(url);
const log=(...a)=>console.log('[perito]',...a);
try{
  const EMAIL='lballanti.lb+perito@gmail.com', LAWYER='31babca6-5b81-11f1-88c8-ee5423879f46', ORG='850720c1-82fa-4a9b-b1cd-0569d20abff9', CASE='06c96f56-a0b3-4de1-a6ad-d98e33c8e4aa';
  const SPEC=['blockchain_cripto','informatica_forense','contable_financiera_forense','caligrafica_documentoscopia'];
  let [u]=await c.query("SELECT id,role FROM users WHERE email=?",[EMAIL]); let pid;
  if(u.length){pid=u[0].id; await c.query("UPDATE users SET role='PERITO' WHERE id=?",[pid]); log('user existe, rol→PERITO',pid.slice(0,8));}
  else{pid=randomUUID(); await c.query("INSERT INTO users (id,email,name,role) VALUES (?,?,?,?)",[pid,EMAIL,'Perito de Prueba (Lorenzo)','PERITO']); log('user creado',pid.slice(0,8));}
  const [pp]=await c.query("SELECT id FROM professional_profiles WHERE user_id=?",[pid]);
  if(!pp.length){await c.query("INSERT INTO professional_profiles (id,user_id,type,display_name,specialties,city,bio,accepts_requests,verified_at) VALUES (?,?,?,?,?,?,?,?,?)",[randomUUID(),pid,'PERITO','Perito de Prueba (Lorenzo)',JSON.stringify(SPEC),'Madrid','Perito de prueba para validar el circuito (blockchain/cripto, informática, contable, documentoscopia).',1,new Date()]); log('perfil creado, especialidades:',SPEC.join(','));}
  else{await c.query("UPDATE professional_profiles SET specialties=?, accepts_requests=1, verified_at=COALESCE(verified_at,NOW()) WHERE user_id=?",[JSON.stringify(SPEC),pid]); log('perfil actualizado');}
  const [g]=await c.query("SELECT id FROM perito_case_grants WHERE case_id=? AND perito_user_id=?",[CASE,pid]);
  if(!g.length){await c.query("INSERT INTO perito_case_grants (id,case_id,perito_user_id,org_id,granted_by_user_id,status,note) VALUES (?,?,?,?,?,?,?)",[randomUUID(),CASE,pid,ORG,LAWYER,'active','Peritaje informático-forense y trazabilidad de fondos (cripto) sobre la documentación aportada.']); log('grant de caso creado (active)');}
  else{await c.query("UPDATE perito_case_grants SET status='active' WHERE id=?",[g[0].id]); log('grant ya existía, →active');}
  const [docs]=await c.query("SELECT id,original_filename FROM case_documents WHERE case_id=? AND deleted_at IS NULL LIMIT 4",[CASE]);
  let shared=0;
  for(const d of docs){const [e]=await c.query("SELECT id FROM perito_doc_grants WHERE perito_user_id=? AND document_id=?",[pid,d.id]); if(!e.length){await c.query("INSERT INTO perito_doc_grants (id,case_id,perito_user_id,document_id,granted_by_user_id) VALUES (?,?,?,?,?)",[randomUUID(),CASE,pid,d.id,LAWYER]); shared++;}}
  log('documentos compartidos con el perito:',shared,'(de',docs.length,'disponibles)');
  log('OK · email perito='+EMAIL+' · caso=JBH-2026-002');
  await c.end(); process.exit(0);
}catch(e){log('FATAL',e.message); try{await c.end()}catch{}; process.exit(1);}
