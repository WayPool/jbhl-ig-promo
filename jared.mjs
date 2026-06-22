import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const url = readFileSync(B+'/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [users]=await c.query("SELECT id,name,email,role FROM users WHERE name LIKE '%Jared%' OR email LIKE '%jared%'");
for (const u of users) {
  console.log(`USER ${u.name} <${u.email}> role=${u.role}`);
  const [cases]=await c.query("SELECT id,expediente_num,status,causa_id FROM cases WHERE client_user_id=? AND deleted_at IS NULL",[u.id]);
  for (const ca of cases) {
    console.log(`  CASO ${ca.expediente_num} (${ca.id.slice(0,8)}) status=${ca.status} causa=${ca.causa_id?ca.causa_id.slice(0,8):'NO'}`);
    const [qns]=await c.query("SELECT id,round,status FROM case_questionnaires WHERE case_id=? ORDER BY round",[ca.id]);
    for (const q of qns) {
      const [[qc]]=await c.query("SELECT COUNT(*) n FROM questionnaire_questions WHERE questionnaire_id=? AND status='active'",[q.id]);
      const [[ac]]=await c.query("SELECT COUNT(*) n FROM questionnaire_answers a JOIN questionnaire_questions qq ON qq.id=a.question_id WHERE qq.questionnaire_id=? AND (a.answer_text IS NOT NULL AND a.answer_text<>'' OR a.attachment_doc_ids IS NOT NULL)",[q.id]);
      console.log(`    CUESTIONARIO ronda ${q.round} status=${q.status} preguntas_activas=${qc.n||qc.N} respondidas=${ac.n||ac.N}`);
    }
    // ¿otros investigados en la causa? (para saber si la regeneración tendrá contexto)
    if (ca.causa_id) {
      const [sib]=await c.query("SELECT id,expediente_num FROM cases WHERE causa_id=? AND id<>? AND deleted_at IS NULL",[ca.causa_id,ca.id]);
      console.log(`    otros investigados en la causa: ${sib.map(s=>s.expediente_num).join(', ')||'(ninguno)'}`);
    }
  }
}
await c.end();
