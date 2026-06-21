#!/usr/bin/env node
/**
 * fase-superadmin-migrate.mjs — Migración "Superadmin de plataforma" (auditoría).
 * AUTOCONTENIDA e IDEMPOTENTE. Mismo patrón que `fase-colegiado-migrate.mjs`.
 *
 * Qué hace (todo ADITIVO; no toca datos existentes; JBH intacto):
 *   1. CREATE TABLE IF NOT EXISTS superadmin_audit — rastro RGPD de las acciones
 *      transversales del superadmin (view_as_start | view_as_stop | console_view),
 *      con índices por actor, acción, org objetivo y fecha.
 *   2. VERIFICACIÓN: tabla + índices presentes.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa "ya existe", se
 * LOGUEA y se continúa. Cualquier OTRO error ABORTA con process.exit(1).
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada con `mysql2` en node_modules):
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-superadmin-migrate.mjs \
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
    '[superadmin] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const T_AUDIT = 'superadmin_audit';
const INDEXES = [
  'idx_su_audit_actor',
  'idx_su_audit_action',
  'idx_su_audit_target',
  'idx_su_audit_created',
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
    console.error(`[superadmin] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[superadmin] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[superadmin] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[superadmin] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[superadmin] FATAL ${label}: ${err.message}`);
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
  console.log(`[superadmin] Conectado. env=${env}`);

  // ── 1) superadmin_audit ────────────────────────────────────────────────────
  await runIdempotent(
    conn,
    `CREATE TABLE ${T_AUDIT}`,
    `CREATE TABLE IF NOT EXISTS ${T_AUDIT} (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       actor_user_id varchar(36) NOT NULL,
       actor_email varchar(255) NOT NULL,
       action varchar(30) NOT NULL,
       target_org_id varchar(36) NULL,
       ip_hash varchar(64) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_su_audit_actor (actor_user_id),
       KEY idx_su_audit_action (action),
       KEY idx_su_audit_target (target_org_id),
       KEY idx_su_audit_created (created_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  // ── 2) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[superadmin] --- Verificación ---');
  let ok = true;

  if (!(await tableExists(conn, T_AUDIT))) {
    console.error(`[superadmin] VERIFY FAIL: la tabla ${T_AUDIT} no existe.`);
    ok = false;
  } else {
    for (const idx of INDEXES) {
      if (!(await indexExists(conn, T_AUDIT, idx))) {
        console.error(`[superadmin] VERIFY FAIL: el índice ${idx} no existe.`);
        ok = false;
      }
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[superadmin] OK verificación: superadmin_audit lista.');
    process.exit(0);
  }
  console.error('[superadmin] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[superadmin] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
