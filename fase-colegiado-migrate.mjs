#!/usr/bin/env node
/**
 * fase-colegiado-migrate.mjs — Migración "Verificación de colegiado ACA" (Modelo B)
 * AUTOCONTENIDA e IDEMPOTENTE. Mismo patrón que `fase4-members-migrate.mjs`.
 *
 * Qué hace, EN ORDEN (todo ADITIVO, sin tocar datos existentes; JBH intacto):
 *   1. ALTER organizations: añade las columnas de verificación de colegiado
 *      (colegiado_verified_at, colegiado_nif_hash, colegiado_name, colegio,
 *       colegiado_num, colegiado_cert_serial). Cada columna por separado, con
 *      try-catch idempotente ("Duplicate column" → SKIP).
 *   2. ALTER cases: añade self_dealing_suspected TINYINT NOT NULL DEFAULT 0
 *      (señal anti-autotrato, capa 4). Idempotente.
 *   3. CREATE TABLE IF NOT EXISTS colegiado_identities (UNIQUE uq_colegiado_nif_hash).
 *   4. CREATE TABLE IF NOT EXISTS colegiado_challenges (KEY idx_colegiado_chal_org_user).
 *   5. VERIFICACIÓN: columnas + tablas + índices presentes.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa el patrón de
 * "ya existe" (Duplicate / exists), se LOGUEA y se continúa. Cualquier OTRO error
 * ABORTA con process.exit(1). Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada que tenga `mysql2` en node_modules,
 * p. ej. el backend del portal; el runner resuelve mysql2 desde el cwd):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-colegiado-migrate.mjs \
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
    '[colegiado] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const JBH_ORG_ID = '00000000-0000-4000-8000-0000000a1b01';
const T_IDENT = 'colegiado_identities';
const T_CHAL = 'colegiado_challenges';
const UQ_IDENT = 'uq_colegiado_nif_hash';

// Reconoce errores "ya aplicado" → idempotencia (loguear y continuar).
const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;

// Columnas aditivas en `organizations` (col → definición SQL).
const ORG_COLUMNS = [
  ['colegiado_verified_at', 'datetime NULL'],
  ['colegiado_nif_hash', 'varchar(64) NULL'],
  ['colegiado_name', 'varchar(255) NULL'],
  ['colegio', 'varchar(255) NULL'],
  ['colegiado_num', 'varchar(100) NULL'],
  ['colegiado_cert_serial', 'varchar(255) NULL'],
  ['colegiado_claim_mismatch', 'tinyint NOT NULL DEFAULT 0'],
];

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
    console.error(`[colegiado] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[colegiado] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[colegiado] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[colegiado] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[colegiado] FATAL ${label}: ${err.message}`);
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

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
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
  console.log(`[colegiado] Conectado. env=${env}`);

  // ── 1) Columnas en organizations (una a una, idempotente) ──────────────────
  for (const [col, def] of ORG_COLUMNS) {
    if (await columnExists(conn, 'organizations', col)) {
      console.log(`[colegiado] SKIP  organizations.${col} (ya existe)`);
      continue;
    }
    await runIdempotent(
      conn,
      `ALTER organizations ADD ${col}`,
      `ALTER TABLE organizations ADD COLUMN ${col} ${def}`,
    );
  }

  // ── 2) Columnas anti-autotrato en cases (capa 4) ───────────────────────────
  if (await columnExists(conn, 'cases', 'self_dealing_suspected')) {
    console.log('[colegiado] SKIP  cases.self_dealing_suspected (ya existe)');
  } else {
    await runIdempotent(
      conn,
      'ALTER cases ADD self_dealing_suspected',
      `ALTER TABLE cases ADD COLUMN self_dealing_suspected tinyint NOT NULL DEFAULT 0`,
    );
  }
  if (await columnExists(conn, 'cases', 'creator_ip_hash')) {
    console.log('[colegiado] SKIP  cases.creator_ip_hash (ya existe)');
  } else {
    await runIdempotent(
      conn,
      'ALTER cases ADD creator_ip_hash',
      `ALTER TABLE cases ADD COLUMN creator_ip_hash varchar(64) NULL`,
    );
  }

  // ── 3) colegiado_identities ────────────────────────────────────────────────
  await runIdempotent(
    conn,
    `CREATE TABLE ${T_IDENT}`,
    `CREATE TABLE IF NOT EXISTS ${T_IDENT} (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       nif_hash varchar(64) NOT NULL,
       first_org_id varchar(36) NULL,
       free_case_used_at datetime NULL,
       free_case_org_id varchar(36) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY ${UQ_IDENT} (nif_hash)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  // ── 4) colegiado_challenges ────────────────────────────────────────────────
  await runIdempotent(
    conn,
    `CREATE TABLE ${T_CHAL}`,
    `CREATE TABLE IF NOT EXISTS ${T_CHAL} (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       org_id varchar(36) NOT NULL DEFAULT '${JBH_ORG_ID}',
       user_id varchar(36) NOT NULL,
       challenge text NOT NULL,
       expires_at datetime NOT NULL,
       used_at datetime NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_colegiado_chal_org_user (org_id, user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  // ── 5) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[colegiado] --- Verificación ---');
  let ok = true;

  for (const [col] of ORG_COLUMNS) {
    if (!(await columnExists(conn, 'organizations', col))) {
      console.error(`[colegiado] VERIFY FAIL: organizations.${col} no existe.`);
      ok = false;
    }
  }
  if (!(await columnExists(conn, 'cases', 'self_dealing_suspected'))) {
    console.error('[colegiado] VERIFY FAIL: cases.self_dealing_suspected no existe.');
    ok = false;
  }
  if (!(await columnExists(conn, 'cases', 'creator_ip_hash'))) {
    console.error('[colegiado] VERIFY FAIL: cases.creator_ip_hash no existe.');
    ok = false;
  }
  for (const t of [T_IDENT, T_CHAL]) {
    if (!(await tableExists(conn, t))) {
      console.error(`[colegiado] VERIFY FAIL: la tabla ${t} no existe.`);
      ok = false;
    }
  }
  if (!(await indexExists(conn, T_IDENT, UQ_IDENT))) {
    console.error(`[colegiado] VERIFY FAIL: el índice único ${UQ_IDENT} no existe.`);
    ok = false;
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[colegiado] OK verificación de colegiado lista.');
    process.exit(0);
  }
  console.error('[colegiado] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[colegiado] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
