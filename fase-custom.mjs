#!/usr/bin/env node
/**
 * fase17-custom-plan-migrate.mjs — Migración "Plan a medida" (FEATURE A).
 * AUTOCONTENIDA e IDEMPOTENTE. Mismo patrón que `fase-superadmin-migrate.mjs`.
 *
 * Qué hace (todo ADITIVO; no toca datos existentes; JBH intacto):
 *   1. ALTER TABLE organization_subscriptions: añade columnas del plan a medida
 *      (is_custom, custom_price_cents, custom_period, seats_override,
 *      expedientes_override, custom_label, custom_set_by, custom_set_at).
 *   2. CREATE TABLE IF NOT EXISTS org_custom_plan_requests — solicitudes de plan
 *      a medida de los despachos (pending/attended/rejected).
 *   3. VERIFICACIÓN: columnas + tabla + índices presentes.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa "ya existe", se
 * LOGUEA y se continúa. Cualquier OTRO error ABORTA con process.exit(1).
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada con `mysql2` en node_modules):
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase17-custom-plan-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional (default: .../shared/portal.env). Lee DATABASE_URL.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[custom-plan] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const T_SUB = 'organization_subscriptions';
const T_REQ = 'org_custom_plan_requests';

const NEW_COLUMNS = [
  ['is_custom', 'tinyint NOT NULL DEFAULT 0'],
  ['custom_price_cents', 'int NULL'],
  ['custom_period', 'varchar(10) NULL'],
  ['seats_override', 'int NULL'],
  ['expedientes_override', 'int NULL'],
  ['custom_label', 'varchar(120) NULL'],
  ['custom_set_by', 'varchar(36) NULL'],
  ['custom_set_at', 'datetime NULL'],
];

const REQ_INDEXES = [
  'idx_custom_plan_req_org',
  'idx_custom_plan_req_status',
  'idx_custom_plan_req_created',
];

const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;

function parseArgs(argv) {
  const out = { env: '/var/www/vhosts/jbhasesorialegal.com/shared/portal.env' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--env') out.env = argv[++i];
  }
  return out;
}

function readDatabaseUrl(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (e) {
    console.error(`[custom-plan] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[custom-plan] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[custom-plan] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[custom-plan] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[custom-plan] FATAL ${label}: ${err.message}`);
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
  console.log(`[custom-plan] Conectado. env=${env}`);

  // ── 1) Columnas del plan a medida en organization_subscriptions ─────────────
  // Solo añade la columna si NO existe (ADD COLUMN no es idempotente en MySQL 5.7/8
  // sin IF NOT EXISTS portable → comprobamos antes).
  for (const [col, def] of NEW_COLUMNS) {
    if (await columnExists(conn, T_SUB, col)) {
      console.log(`[custom-plan] SKIP  ADD COLUMN ${T_SUB}.${col} (ya existe)`);
      continue;
    }
    await runIdempotent(
      conn,
      `ADD COLUMN ${T_SUB}.${col}`,
      `ALTER TABLE ${T_SUB} ADD COLUMN ${col} ${def}`,
    );
  }

  // ── 2) org_custom_plan_requests ─────────────────────────────────────────────
  await runIdempotent(
    conn,
    `CREATE TABLE ${T_REQ}`,
    `CREATE TABLE IF NOT EXISTS ${T_REQ} (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       org_id varchar(36) NOT NULL,
       requested_by_user_id varchar(36) NOT NULL,
       message text NULL,
       status varchar(20) NOT NULL DEFAULT 'pending',
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       attended_by varchar(36) NULL,
       attended_at datetime NULL,
       PRIMARY KEY (id),
       KEY idx_custom_plan_req_org (org_id),
       KEY idx_custom_plan_req_status (status),
       KEY idx_custom_plan_req_created (created_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  // ── 3) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[custom-plan] --- Verificación ---');
  let ok = true;

  for (const [col] of NEW_COLUMNS) {
    if (!(await columnExists(conn, T_SUB, col))) {
      console.error(`[custom-plan] VERIFY FAIL: la columna ${T_SUB}.${col} no existe.`);
      ok = false;
    }
  }

  if (!(await tableExists(conn, T_REQ))) {
    console.error(`[custom-plan] VERIFY FAIL: la tabla ${T_REQ} no existe.`);
    ok = false;
  } else {
    for (const idx of REQ_INDEXES) {
      if (!(await indexExists(conn, T_REQ, idx))) {
        console.error(`[custom-plan] VERIFY FAIL: el índice ${idx} no existe.`);
        ok = false;
      }
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[custom-plan] OK verificación: columnas + org_custom_plan_requests listas.');
    process.exit(0);
  }
  console.error('[custom-plan] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[custom-plan] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
