#!/usr/bin/env node
/**
 * fase2-migrate.mjs — Migración Fase 2 (Paso 1) AUTOCONTENIDA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN:
 *   1. CREATE TABLE IF NOT EXISTS client_invitations (SIN FK, igual que 0080).
 *   2. VERIFICACIÓN: la tabla existe y tiene el índice único uq_client_inv_token.
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
 *   node /ruta/a/infra/saas-migrations/fase2-migrate.mjs \
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
    '[fase2] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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
    console.error(`[fase2] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[fase2] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Ejecución idempotente
// ───────────────────────────────────────────────────────────────────────────
async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[fase2] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[fase2] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[fase2] FATAL ${label}: ${err.message}`);
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

async function main() {
  const { env } = parseArgs(process.argv);
  const databaseUrl = readDatabaseUrl(env);

  const conn = await mysql.createConnection({
    uri: databaseUrl,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  console.log(`[fase2] Conectado. env=${env}`);

  // ── 1) client_invitations (SIN FK, idéntico a 0080, idempotente) ───────────
  await runIdempotent(
    conn,
    'CREATE TABLE client_invitations',
    `CREATE TABLE IF NOT EXISTS client_invitations (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       org_id varchar(36) NOT NULL DEFAULT '${JBH_ORG_ID}',
       case_id varchar(36) NOT NULL,
       client_email_snapshot varchar(255) NOT NULL,
       client_name_snapshot varchar(255) NULL,
       token_hash varchar(64) NOT NULL,
       invited_by_id varchar(36) NULL,
       status varchar(20) NOT NULL DEFAULT 'pending',
       expires_at datetime NOT NULL,
       consumed_at datetime NULL,
       revoked_at datetime NULL,
       revoked_by_id varchar(36) NULL,
       attempts int NOT NULL DEFAULT 0,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_client_inv_token (token_hash),
       KEY idx_client_inv_org (org_id),
       KEY idx_client_inv_case (case_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  // ── 2) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[fase2] --- Verificación ---');
  let ok = true;

  if (!(await tableExists(conn, 'client_invitations'))) {
    console.error('[fase2] VERIFY FAIL: la tabla client_invitations no existe.');
    ok = false;
  } else {
    console.log('[fase2] VERIFY OK: tabla client_invitations presente.');
    if (!(await indexExists(conn, 'client_invitations', 'uq_client_inv_token'))) {
      console.error('[fase2] VERIFY FAIL: falta el índice único uq_client_inv_token.');
      ok = false;
    } else {
      console.log('[fase2] VERIFY OK: índice único uq_client_inv_token presente.');
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[fase2] OK client_invitations lista.');
    process.exit(0);
  }
  console.error('[fase2] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fase2] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
