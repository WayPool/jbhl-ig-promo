import { readFileSync } from 'node:fs'; import { randomUUID } from 'node:crypto'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
// caso de Jared
const [[ca]]=await c.query("SELECT id,expediente_num,status,causa_id FROM cases WHERE expediente_num='JBH-2026-004' AND deleted_at IS NULL");
if(!ca){console.log('NO se encontró JBH-2026-004');process.exit(0);}
console.log('Caso', ca.expediente_num, ca.id, 'status', ca.status, 'causa', ca.causa_id);
// cuestionario draft + nº preguntas activas (antes)
const [[q]]=await c.query("SELECT id,round,status,generated_at FROM case_questionnaires WHERE case_id=? ORDER BY round DESC LIMIT 1",[ca.id]);
const [[qa]]=await c.query("SELECT COUNT(*) n FROM questionnaire_questions WHERE questionnaire_id=? AND status='active'",[q.id]);
console.log('ANTES: cuestionario ronda',q.round,'status',q.status,'preguntas_activas',qa.n,'generated_at',q.generated_at);
if(q.status!=='draft'){console.log('⚠️ NO está en draft -> regenerar sería AUGMENT, no reemplazo. Abortando por seguridad.');process.exit(0);}
// columnas de la cola
const [cols]=await c.query("SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.columns WHERE table_name='document_analysis_jobs' AND table_schema=DATABASE()");
const names=cols.map(x=>x.COLUMN_NAME);
// coalesce: borra jobs questionnaire pendientes de este caso
const [del]=await c.query("DELETE FROM document_analysis_jobs WHERE case_id=? AND scope='questionnaire' AND status='pending'",[ca.id]);
console.log('jobs pendientes borrados:', del.affectedRows);
// inserta job
const row={ scope:'questionnaire', case_id: ca.id, process_after: new Date(), status:'pending' };
if(names.includes('id')) row.id = randomUUID();
if(names.includes('created_at')) row.created_at = new Date();
if(names.includes('updated_at')) row.updated_at = new Date();
if(names.includes('attempts')) row.attempts = 0;
const keys=Object.keys(row).filter(k=>names.includes(k));
const sql=`INSERT INTO document_analysis_jobs (${keys.map(k=>'`'+k+'`').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`;
await c.query(sql, keys.map(k=>row[k]));
console.log('✅ job de cuestionario encolado para', ca.expediente_num, '— el worker regenerará el borrador (consciente de la causa).');
await c.end();
