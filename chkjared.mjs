import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [[ca]]=await c.query("SELECT id FROM cases WHERE expediente_num='JBH-2026-004' AND deleted_at IS NULL");
const [[q]]=await c.query("SELECT id,status,generated_at FROM case_questionnaires WHERE case_id=? ORDER BY round DESC LIMIT 1",[ca.id]);
const [[act]]=await c.query("SELECT COUNT(*) n FROM questionnaire_questions WHERE questionnaire_id=? AND status='active'",[q.id]);
const [[rem]]=await c.query("SELECT COUNT(*) n FROM questionnaire_questions WHERE questionnaire_id=? AND status='removed'",[q.id]);
console.log('DESPUÉS: status',q.status,'generated_at',q.generated_at,'| activas',act.n,'removed(viejas)',rem.n);
// estado del job
const [[job]]=await c.query("SELECT status,error,process_after FROM document_analysis_jobs WHERE case_id=? AND scope='questionnaire' ORDER BY process_after DESC LIMIT 1",[ca.id]);
console.log('JOB:', job? job.status+(job.error?(' err='+String(job.error).slice(0,120)):'') : '(ninguno -> procesado y limpiado)');
// muestra de 4 preguntas nuevas
const [qs]=await c.query("SELECT block,text FROM questionnaire_questions WHERE questionnaire_id=? AND status='active' ORDER BY block_order,question_order LIMIT 4",[q.id]);
console.log('MUESTRA preguntas nuevas:'); qs.forEach((x,i)=>console.log(`  ${i+1}. [${x.block}] ${x.text}`));
await c.end();
