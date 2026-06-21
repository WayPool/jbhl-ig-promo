import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module'; import { randomUUID } from 'node:crypto';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');
const url = readFileSync('/var/www/vhosts/jbhasesorialegal.com/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const mysql = require('mysql2/promise'); const c = await mysql.createConnection(url);
const USER='31babca6-5b81-11f1-88c8-ee5423879f46'; const JBH='00000000-0000-4000-8000-0000000a1b01';
const log=(...a)=>console.log('[conv-a]',...a);
try{
  // 1) rol -> LAWYER
  await c.query("UPDATE users SET role='LAWYER' WHERE id=?",[USER]); log('rol -> LAWYER');
  // 2) org law_firm (idempotente por owner)
  let [o]=await c.query("SELECT id,slug FROM organizations WHERE owner_user_id=? AND type='law_firm' LIMIT 1",[USER]);
  let orgId, slug;
  if(o.length){orgId=o[0].id; slug=o[0].slug; log('org reutilizada',orgId);}
  else{
    const base='despacho-lorenzo-ballanti'; slug=base;
    for(let i=2;i<60;i++){const[e]=await c.query("SELECT id FROM organizations WHERE slug=? LIMIT 1",[slug]); if(!e.length)break; slug=base+'-'+i;}
    orgId=randomUUID();
    await c.query("INSERT INTO organizations (id,type,name,slug,owner_user_id,status) VALUES (?,?,?,?,?,?)",[orgId,'law_firm','Despacho Lorenzo Ballanti',slug,USER,'active']);
    log('org creada',orgId,slug);
  }
  // 3) membership OWNER (idempotente)
  const [m]=await c.query("SELECT id FROM memberships WHERE user_id=? AND org_id=? LIMIT 1",[USER,orgId]);
  if(!m.length){await c.query("INSERT INTO memberships (id,user_id,org_id,role,status) VALUES (?,?,?,?,?)",[randomUUID(),USER,orgId,'OWNER','active']); log('membership OWNER creada');} else log('membership OWNER ya existe');
  // 4) organization_subscriptions plan individual / status none (idempotente)
  const [s]=await c.query("SELECT id FROM organization_subscriptions WHERE org_id=? LIMIT 1",[orgId]);
  if(!s.length){await c.query("INSERT INTO organization_subscriptions (id,org_id,plan,status,seats_included) VALUES (?,?,?,?,?)",[randomUUID(),orgId,'individual','none',1]); log('suscripcion individual/none creada');} else log('suscripcion ya existe');
  // 5) quitar membership COLLABORATOR en JBH
  const [d]=await c.query("DELETE FROM memberships WHERE user_id=? AND org_id=?",[USER,JBH]); log('membership JBH borrada filas=',d.affectedRows);
  // 6) localizar los 2 casos
  const [cs]=await c.query("SELECT id,expediente_num FROM cases WHERE expediente_num IN ('JBH-2026-002','JBH-2026-003')");
  const ids=cs.map(x=>x.id); log('casos:',cs.map(x=>x.expediente_num+'='+x.id.slice(0,8)).join(', '));
  if(!ids.length){log('NO hay casos que mover'); await c.end(); process.exit(0);}
  // 7) mover casos
  const [uc]=await c.query("UPDATE cases SET org_id=?, lead_lawyer_id=?, case_model='firm_managed' WHERE id IN (?)",[orgId,USER,ids]); log('cases movidos=',uc.affectedRows);
  // 8) todas las tablas con org_id + case_id
  const [tabs]=await c.query(`SELECT DISTINCT a.TABLE_NAME tn FROM information_schema.COLUMNS a JOIN information_schema.COLUMNS b ON a.TABLE_SCHEMA=b.TABLE_SCHEMA AND a.TABLE_NAME=b.TABLE_NAME WHERE a.TABLE_SCHEMA=DATABASE() AND a.COLUMN_NAME='org_id' AND b.COLUMN_NAME='case_id'`);
  for(const {tn} of tabs){ if(tn==='cases')continue; try{const[r]=await c.query("UPDATE `"+tn+"` SET org_id=? WHERE case_id IN (?)",[orgId,ids]); if(r.affectedRows)log('  '+tn+' org_id actualizadas=',r.affectedRows);}catch(e){log('  ! '+tn,e.code||e.message);} }
  // 9) descendientes de cuestionario (via join)
  try{const[r]=await c.query("UPDATE questionnaire_questions qq JOIN case_questionnaires cq ON cq.id=qq.questionnaire_id SET qq.org_id=? WHERE cq.case_id IN (?)",[orgId,ids]); log('questionnaire_questions=',r.affectedRows);}catch(e){log('! qq',e.code||e.message);}
  try{const[r]=await c.query("UPDATE questionnaire_answers qa JOIN questionnaire_questions qq ON qq.id=qa.question_id JOIN case_questionnaires cq ON cq.id=qq.questionnaire_id SET qa.org_id=? WHERE cq.case_id IN (?)",[orgId,ids]); log('questionnaire_answers=',r.affectedRows);}catch(e){log('! qa',e.code||e.message);}
  // verificacion
  const [chk]=await c.query("SELECT expediente_num,org_id,lead_lawyer_id,case_model FROM cases WHERE id IN (?)",[ids]);
  for(const x of chk) log('VERIF',x.expediente_num,'org='+x.org_id.slice(0,8),'lead='+x.lead_lawyer_id.slice(0,8),x.case_model);
  log('OK org='+orgId+' slug='+slug);
  await c.end(); process.exit(0);
}catch(e){log('FATAL',e.message); try{await c.end()}catch{}; process.exit(1);}
