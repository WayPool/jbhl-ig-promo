#!/usr/bin/env node
/**
 * fase0-migrate.mjs — Migración Fase 0 (Pasos C–E) AUTOCONTENIDA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN:
 *   1. CREATE TABLE IF NOT EXISTS organizations + memberships (igual que 0077).
 *   2. Siembra la organización JBH (id = JBH_ORG_ID, type=jbh_platform, slug=jbh).
 *   3. Crea memberships idempotentes para los usuarios con rol de portal actual
 *      (ADMIN/COORDINADOR/COLABORADOR/PERITO) → role mapeado, status='active'.
 *   4. Por cada tabla TENANT-OWNED: ADD COLUMN org_id varchar(36) NOT NULL
 *      DEFAULT '<JBH_ORG_ID>'  +  índice idx_<tabla>_org (org_id).
 *      Las filas EXISTENTES se auto-rellenan con JBH por el DEFAULT (backfill).
 *   5. cases: ADD COLUMN case_model varchar(20) NOT NULL DEFAULT 'jbh_direct'.
 *   6. VERIFICACIÓN final: la org JBH existe; una muestra de tablas no tiene
 *      org_id NULL/''; imprime "OK tablas=N filas_backfilled=...".
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa el patrón de
 * "ya existe" (Duplicate column / Duplicate key / check that column ... exists),
 * se LOGUEA y se continúa. Cualquier OTRO error ABORTA con process.exit(1).
 * Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada que tenga `mysql2` en node_modules,
 * p. ej. el backend del portal; el runner resuelve mysql2 desde el cwd):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase0-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional; por defecto:
 *   /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 * Del env se lee la variable DATABASE_URL (igual que packages/db/src/client.ts).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// mysql2 se resuelve desde el cwd (node_modules de la app desplegada), NO desde
// la ubicación de este script (que vive fuera de cualquier app).
const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[fase0] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Constantes (deben coincidir con packages/db/src/constants.ts y el schema TS).
// ───────────────────────────────────────────────────────────────────────────
const JBH_ORG_ID = '00000000-0000-4000-8000-0000000a1b01';

/**
 * Lista DEFINITIVA de tablas tenant-owned (auditoría Paso C). DEBE coincidir con
 * `TENANT_OWNED_TABLES` de packages/db/src/tenant.ts y con las tablas que tienen
 * `org_id` en el schema TS / en 0078_orgid_tenant_columns.sql.
 */
const TENANT_OWNED_TABLES = [
  'cases',
  'causas',
  'intakes',
  'intake_notes',
  'intake_events',
  'intake_documents',
  'leads',
  'case_documents',
  'case_messages',
  'case_message_attachments',
  'case_milestones',
  'case_tasks',
  'case_meetings',
  'case_court_events',
  'case_collaborators',
  'case_payments',
  'case_questionnaires',
  'questionnaire_questions',
  'questionnaire_answers',
  'case_drafts',
  'case_draft_versions',
  'case_clarifications',
  'case_fianza_consents',
  'case_prognosis_snapshots',
  'case_analyses',
  'case_answer_evaluations',
  'case_executive_summaries',
  'case_events',
  'case_chat_threads',
  'case_chat_messages',
  'causa_analyses',
  'causa_comparativa_contradicciones',
  'causa_core_questions',
  'causa_drafts',
  'document_analyses',
  'document_analysis_jobs',
  'signature_requests',
  'signatures',
  'notifications',
  'message_notification_queue',
  'dsr_requests',
  'bookings',
  'booking_audit_events',
  'lawyer_availability',
  'lawyer_calendars',
  'lawyer_booking_settings',
  'whatsapp_links',
  'whatsapp_events',
  'content_pieces',
  'ai_request_log',
  'herencia_consultas',
  'herencia_answers',
  'herencia_questions',
  'herencia_documents',
  'herencia_document_analyses',
  'herencia_herederos',
  'herencia_inventario',
  'herencia_payments',
  'herencia_reports',
];

// Mapeo rol de portal (users.role) → rol de membership en la org JBH.
// CLIENT/ANONYMIZED NO reciben membership (no son personal del despacho).
const ROLE_MAP = {
  ADMIN: 'OWNER',
  COORDINADOR: 'FIRM_ADMIN',
  COLABORADOR: 'COLLABORATOR',
  PERITO: 'PERITO',
};

// Índice corto y estable (< 64 chars) por tabla.
const idxName = (t) => `idx_${t}_org`;

// Reconoce errores "ya aplicado" → idempotencia (loguear y continuar).
const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;

// ───────────────────────────────────────────────────────────────────────────
// Args / env
// ───────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { env: '/var/www/vhosts/jbhasesorialegal.com/shared/portal.env' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--env') out.env = argv[++i];
  }
  return out;
}

/** Lee DATABASE_URL de un .env (sin dependencias; soporta comillas y `export`). */
function readDatabaseUrl(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (e) {
    console.error(`[fase0] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[1].trim();
    // quitar comentario inline solo si no está entre comillas
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) return v;
  }
  console.error(`[fase0] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Ejecución idempotente
// ───────────────────────────────────────────────────────────────────────────
async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[fase0] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[fase0] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[fase0] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

/** ¿Existe ya un índice con ese nombre en la tabla? (information_schema). */
async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  );
  return rows.length > 0;
}

/** ¿Existe la tabla? (evita ALTER sobre una tabla inexistente → error no idempotente). */
async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function main() {
  const { env } = parseArgs(process.argv);
  const databaseUrl = readDatabaseUrl(env);

  const conn = await mysql.createConnection({
    uri: databaseUrl,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  console.log(`[fase0] Conectado. env=${env}`);

  // ── 1) organizations + memberships (idéntico a 0077, idempotente) ──────────
  await runIdempotent(
    conn,
    'CREATE TABLE organizations',
    `CREATE TABLE IF NOT EXISTS organizations (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       type varchar(20) NOT NULL,
       name varchar(255) NOT NULL,
       slug varchar(100) NOT NULL,
       legal_name varchar(255) NULL,
       nif varchar(20) NULL,
       colegio_profesional varchar(100) NULL,
       num_colegiado varchar(50) NULL,
       branding_json json NULL,
       owner_user_id varchar(36) NULL,
       status varchar(20) NOT NULL DEFAULT 'active',
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_org_slug (slug),
       KEY idx_org_type (type)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  await runIdempotent(
    conn,
    'CREATE TABLE memberships',
    `CREATE TABLE IF NOT EXISTS memberships (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       user_id varchar(36) NOT NULL,
       org_id varchar(36) NOT NULL,
       role varchar(20) NOT NULL,
       status varchar(20) NOT NULL DEFAULT 'active',
       permissions_json json NULL,
       invited_by_id varchar(36) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_membership_user_org (user_id, org_id),
       KEY idx_membership_org (org_id),
       KEY idx_membership_user (user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 2) Seed org JBH (idempotente) ──────────────────────────────────────────
  await runIdempotent(
    conn,
    'SEED organizations(JBH)',
    `INSERT INTO organizations (id, type, name, slug, status)
     VALUES (?, 'jbh_platform', 'JBH Legal', 'jbh', 'active')
     ON DUPLICATE KEY UPDATE type = VALUES(type), name = VALUES(name), status = VALUES(status)`,
    [JBH_ORG_ID],
  );

  // ── 3) Memberships idempotentes para el personal de portal ─────────────────
  for (const [portalRole, membershipRole] of Object.entries(ROLE_MAP)) {
    // INSERT ... SELECT: una membership por cada user con ese rol, sin duplicar
    // (uq_membership_user_org + INSERT IGNORE). id vía UUID().
    await runIdempotent(
      conn,
      `SEED memberships(${portalRole}->${membershipRole})`,
      `INSERT IGNORE INTO memberships (id, user_id, org_id, role, status)
         SELECT UUID(), u.id, ?, ?, 'active'
           FROM users u
          WHERE u.role = ?`,
      [JBH_ORG_ID, membershipRole, portalRole],
    );
  }

  // ── 4) org_id en cada tabla tenant-owned + índice (idempotente, backfill) ───
  for (const table of TENANT_OWNED_TABLES) {
    if (!(await tableExists(conn, table))) {
      console.log(`[fase0] WARN  tabla "${table}" no existe en esta BD; se omite.`);
      continue;
    }
    await runIdempotent(
      conn,
      `ALTER ${table} ADD org_id`,
      `ALTER TABLE \`${table}\`
         ADD COLUMN org_id varchar(36) NOT NULL DEFAULT '${JBH_ORG_ID}'`,
    );
    if (!(await indexExists(conn, table, idxName(table)))) {
      await runIdempotent(
        conn,
        `CREATE INDEX ${idxName(table)}`,
        `ALTER TABLE \`${table}\` ADD INDEX \`${idxName(table)}\` (org_id)`,
      );
    } else {
      console.log(`[fase0] SKIP  CREATE INDEX ${idxName(table)} (ya existe)`);
    }
  }

  // ── 5) cases.case_model ─────────────────────────────────────────────────────
  await runIdempotent(
    conn,
    'ALTER cases ADD case_model',
    `ALTER TABLE \`cases\`
       ADD COLUMN case_model varchar(20) NOT NULL DEFAULT 'jbh_direct'`,
  );

  // ── 6) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[fase0] --- Verificación ---');
  let ok = true;

  // 6a) La org JBH existe.
  const [orgRows] = await conn.query(
    `SELECT id FROM organizations WHERE id = ? LIMIT 1`,
    [JBH_ORG_ID],
  );
  if (orgRows.length !== 1) {
    console.error('[fase0] VERIFY FAIL: la organización JBH no existe.');
    ok = false;
  } else {
    console.log('[fase0] VERIFY OK: organización JBH presente.');
  }

  // 6b) Muestra de tablas tenant-owned: ninguna fila con org_id NULL o ''.
  const sample = ['cases', 'causas', 'intakes', 'case_documents', 'case_messages', 'leads'];
  let checkedTables = 0;
  let backfilled = 0;
  for (const table of sample) {
    if (!(await tableExists(conn, table))) continue;
    checkedTables++;
    const [bad] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE org_id IS NULL OR org_id = ''`,
    );
    const [total] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE org_id = ?`,
      [JBH_ORG_ID],
    );
    const badN = Number(bad[0].n);
    backfilled += Number(total[0].n);
    if (badN > 0) {
      console.error(`[fase0] VERIFY FAIL: ${table} tiene ${badN} filas con org_id NULL/''.`);
      ok = false;
    } else {
      console.log(`[fase0] VERIFY OK: ${table} sin org_id NULL/'' (JBH=${total[0].n}).`);
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log(`[fase0] OK tablas=${checkedTables} filas_backfilled=${backfilled}`);
    process.exit(0);
  }
  console.error('[fase0] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fase0] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
