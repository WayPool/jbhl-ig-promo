#!/usr/bin/env node
/**
 * fase-marketplace-migrate.mjs — Migración del MARKETPLACE de casos externos
 * (Modelo A → Modelo B) AUTOCONTENIDA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN:
 *   1. organizations: ADD COLUMN accepts_external_cases (tinyint, default 0) +
 *      ADD COLUMN marketplace_json (json) — opt-in al directorio + perfil público.
 *   2. CREATE TABLE IF NOT EXISTS case_proposals (SIN FK, igual que 0081).
 *   3. VERIFICACIÓN: la tabla case_proposals existe y tiene sus índices; las
 *      columnas de organizations existen.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa el patrón de
 * "ya existe" (Duplicate / exists), se LOGUEA y se continúa. Cualquier OTRO
 * error ABORTA con process.exit(1). Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada que tenga `mysql2` en node_modules,
 * p. ej. el backend del portal; el runner resuelve mysql2 desde el cwd):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-marketplace-migrate.mjs \
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
    '[mkt] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Constantes (deben coincidir con packages/db/src/constants.ts y el schema TS).
// ───────────────────────────────────────────────────────────────────────────
const JBH_ORG_ID = '00000000-0000-4000-8000-0000000a1b01';

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
    console.error(`[mkt] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[mkt] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Ejecución idempotente
// ───────────────────────────────────────────────────────────────────────────
async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[mkt] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[mkt] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[mkt] FATAL ${label}: ${err.message}`);
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

/** ¿Existe la tabla? */
async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

/** ¿Existe la columna en la tabla? */
async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
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
  console.log(`[mkt] Conectado. env=${env}`);

  // ── 1) organizations — opt-in + perfil de marketplace (idempotente) ────────
  if (!(await columnExists(conn, 'organizations', 'accepts_external_cases'))) {
    await runIdempotent(
      conn,
      'ALTER organizations ADD accepts_external_cases',
      `ALTER TABLE \`organizations\`
         ADD COLUMN \`accepts_external_cases\` tinyint NOT NULL DEFAULT 0`,
    );
  } else {
    console.log('[mkt] SKIP  ALTER organizations ADD accepts_external_cases (ya existe)');
  }
  if (!(await columnExists(conn, 'organizations', 'marketplace_json'))) {
    await runIdempotent(
      conn,
      'ALTER organizations ADD marketplace_json',
      `ALTER TABLE \`organizations\`
         ADD COLUMN \`marketplace_json\` json NULL`,
    );
  } else {
    console.log('[mkt] SKIP  ALTER organizations ADD marketplace_json (ya existe)');
  }

  // ── 2) case_proposals (SIN FK, idéntico a 0081, idempotente) ───────────────
  await runIdempotent(
    conn,
    'CREATE TABLE case_proposals',
    `CREATE TABLE IF NOT EXISTS case_proposals (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       org_id varchar(36) NOT NULL DEFAULT '${JBH_ORG_ID}',
       source_intake_id varchar(36) NULL,
       source_case_id varchar(36) NULL,
       client_user_id varchar(36) NOT NULL,
       client_name varchar(255) NULL,
       client_email varchar(255) NULL,
       area varchar(50) NULL,
       summary text NULL,
       status varchar(20) NOT NULL DEFAULT 'pending',
       accepted_case_id varchar(36) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       responded_at datetime NULL,
       responded_by_id varchar(36) NULL,
       PRIMARY KEY (id),
       KEY idx_case_proposals_org_status (org_id, status),
       KEY idx_case_proposals_client (client_user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  // ── 3) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[mkt] --- Verificación ---');
  let ok = true;

  // 3a) organizations: columnas de marketplace presentes.
  for (const col of ['accepts_external_cases', 'marketplace_json']) {
    if (!(await columnExists(conn, 'organizations', col))) {
      console.error(`[mkt] VERIFY FAIL: organizations.${col} no existe.`);
      ok = false;
    } else {
      console.log(`[mkt] VERIFY OK: organizations.${col} presente.`);
    }
  }

  // 3b) case_proposals: tabla + índices.
  if (!(await tableExists(conn, 'case_proposals'))) {
    console.error('[mkt] VERIFY FAIL: la tabla case_proposals no existe.');
    ok = false;
  } else {
    console.log('[mkt] VERIFY OK: tabla case_proposals presente.');
    for (const idx of ['idx_case_proposals_org_status', 'idx_case_proposals_client']) {
      if (!(await indexExists(conn, 'case_proposals', idx))) {
        console.error(`[mkt] VERIFY FAIL: falta el índice ${idx}.`);
        ok = false;
      } else {
        console.log(`[mkt] VERIFY OK: índice ${idx} presente.`);
      }
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[mkt] OK marketplace listo (organizations + case_proposals).');
    process.exit(0);
  }
  console.error('[mkt] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[mkt] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
