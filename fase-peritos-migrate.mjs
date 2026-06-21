#!/usr/bin/env node
/**
 * fase-peritos-migrate.mjs — Migración Red de PERITOS (P1) AUTOCONTENIDA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN:
 *   1. CREATE TABLE IF NOT EXISTS professional_profiles (perfil del profesional
 *      externo: perito/procurador; GLOBAL, sin org_id).
 *   2. CREATE TABLE IF NOT EXISTS perito_case_grants (acceso de un perito a un caso;
 *      tenant-owned, org_id = despacho dueño del caso).
 *   3. CREATE TABLE IF NOT EXISTS perito_doc_grants (qué documentos concretos ve el
 *      perito; tenant-owned).
 *   4. VERIFICACIÓN final: las tres tablas existen.
 *
 * ADITIVA: no toca ninguna tabla existente (ni el Modelo A). Solo crea tablas nuevas.
 * SIN FK declaradas (igual que el resto de tablas tenant-owned en prod: evita errno 150;
 * la integridad referencial se aplica en la capa de aplicación).
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa el patrón de "ya existe",
 * se LOGUEA y se continúa. Cualquier OTRO error ABORTA con process.exit(1).
 * Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada que tenga `mysql2` en node_modules,
 * p. ej. el backend del portal; el runner resuelve mysql2 desde el cwd):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-peritos-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional; por defecto:
 *   /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 * Del env se lee la variable DATABASE_URL (igual que packages/db/src/client.ts).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[peritos] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;

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
    console.error(`[peritos] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[1].trim();
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) return v;
  }
  console.error(`[peritos] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[peritos] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[peritos] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[peritos] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

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
  console.log(`[peritos] Conectado. env=${env}`);

  // ── 1) professional_profiles (GLOBAL, sin org_id, sin FK) ────────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE professional_profiles',
    `CREATE TABLE IF NOT EXISTS professional_profiles (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       user_id varchar(36) NOT NULL,
       type varchar(20) NOT NULL,
       display_name varchar(255) NOT NULL,
       specialties json NULL,
       city varchar(120) NULL,
       bio text NULL,
       contact_email varchar(255) NULL,
       phone varchar(40) NULL,
       colegio varchar(120) NULL,
       num_colegiado varchar(50) NULL,
       verified_at datetime NULL,
       accepts_requests tinyint NOT NULL DEFAULT 1,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_professional_profiles_user (user_id),
       KEY idx_professional_profiles_type (type),
       KEY idx_professional_profiles_accepts (accepts_requests)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 2) perito_case_grants (tenant-owned, org_id, sin FK) ─────────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE perito_case_grants',
    `CREATE TABLE IF NOT EXISTS perito_case_grants (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       case_id varchar(36) NOT NULL,
       perito_user_id varchar(36) NOT NULL,
       org_id varchar(36) NOT NULL,
       granted_by_user_id varchar(36) NULL,
       status varchar(20) NOT NULL DEFAULT 'invited',
       note text NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       revoked_at datetime NULL,
       PRIMARY KEY (id),
       UNIQUE KEY uq_perito_case_grants_case_perito (case_id, perito_user_id),
       KEY idx_perito_case_grants_org (org_id),
       KEY idx_perito_case_grants_case (case_id),
       KEY idx_perito_case_grants_perito (perito_user_id),
       KEY idx_perito_case_grants_status (status)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 3) perito_doc_grants (tenant-owned, org_id, sin FK) ──────────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE perito_doc_grants',
    `CREATE TABLE IF NOT EXISTS perito_doc_grants (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       case_id varchar(36) NOT NULL,
       perito_user_id varchar(36) NOT NULL,
       document_id varchar(36) NOT NULL,
       org_id varchar(36) NOT NULL,
       granted_by_user_id varchar(36) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_perito_doc_grants_perito_doc (perito_user_id, document_id),
       KEY idx_perito_doc_grants_org (org_id),
       KEY idx_perito_doc_grants_case (case_id),
       KEY idx_perito_doc_grants_perito (perito_user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 4) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[peritos] --- Verificación ---');
  let ok = true;
  for (const t of ['professional_profiles', 'perito_case_grants', 'perito_doc_grants']) {
    if (!(await tableExists(conn, t))) {
      console.error(`[peritos] VERIFY FAIL: la tabla ${t} no existe.`);
      ok = false;
    } else {
      console.log(`[peritos] VERIFY OK: tabla ${t} presente.`);
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[peritos] OK professional_profiles + perito_case_grants + perito_doc_grants');
    process.exit(0);
  }
  console.error('[peritos] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[peritos] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
