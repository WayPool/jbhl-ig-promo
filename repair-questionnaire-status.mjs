/**
 * repair-questionnaire-status.mjs — Corrige `case_questionnaires` marcados 'answered'
 * que en realidad tienen preguntas activas SIN responder → 'partially_answered'.
 * (Datos previos al fix de "enviar no bloquea las pendientes".) Idempotente.
 *   node repair-questionnaire-status.mjs --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');

function envVal(path, key) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*?)\\s*$'));
    if (m) { let v = m[1].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return v; }
  }
  return null;
}

const args = process.argv.slice(2);
const envPath = args.includes('--env') ? args[args.indexOf('--env') + 1] : '/var/www/vhosts/jbhasesorialegal.com/shared/portal.env';
const url = envVal(envPath, 'DATABASE_URL');
if (!url) { console.log('[repair] FATAL: falta DATABASE_URL'); process.exit(1); }

const mysql = require('mysql2/promise');

const SQL = `
UPDATE case_questionnaires cq
JOIN (
  SELECT qq.questionnaire_id AS qid
  FROM questionnaire_questions qq
  LEFT JOIN questionnaire_answers qa
    ON qa.question_id = qq.id
   AND (TRIM(COALESCE(qa.answer_text,'')) <> '' OR JSON_LENGTH(COALESCE(qa.attachment_doc_ids, JSON_ARRAY())) > 0)
  WHERE qq.status = 'active'
  GROUP BY qq.questionnaire_id
  HAVING COUNT(qq.id) > COUNT(qa.question_id)
) pend ON pend.qid = cq.id
SET cq.status = 'partially_answered', cq.updated_at = NOW()
WHERE cq.status = 'answered'`;

(async () => {
  let conn;
  try {
    conn = await mysql.createConnection(url);
    const [res] = await conn.query(SQL);
    console.log(`[repair] OK filas corregidas (answered -> partially_answered): ${res.affectedRows}`);
    // Estado del caso reportado por el usuario, para confirmar
    const [rows] = await conn.query(
      "SELECT id, round, status FROM case_questionnaires WHERE case_id = '06c96f56-a0b3-4de1-a6ad-d98e33c8e4aa'",
    );
    for (const r of rows) console.log(`[repair] caso 06c96f56 ronda ${r.round}: status=${r.status}`);
    if (!rows.length) console.log('[repair] (sin cuestionarios para el caso 06c96f56)');
    process.exit(0);
  } catch (e) {
    console.log('[repair] FATAL: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  } finally { if (conn) await conn.end(); }
})();
