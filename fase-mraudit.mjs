#!/usr/bin/env node
/**
 * fase-multirol-audit-migrate.mjs — Auditoría de concesión/retirada de ROLES EXTRA.
 * AUTOCONTENIDA e IDEMPOTENTE. Mismo patrón que `fase-superadmin-migrate.mjs`.
 *
 * Contexto (Fase 17 · multi-rol): un ADMIN puede conceder/retirar roles EXTRA de
 * acceso a una persona (filas en `user_roles`). Esas acciones de IDENTIDAD se
 * registran en la tabla existente `superadmin_audit`, que hasta ahora solo cubría
 * impersonación/consola (apuntan a una ORG). Para auditar acciones que apuntan a un
 * USUARIO necesitamos dos columnas nuevas.
 *
 * Qué hace (todo ADITIVO; no toca datos existentes; JBH intacto):
 *   1. ALTER TABLE superadmin_audit ADD COLUMN target_user_id varchar(36) NULL.
 *   2. ALTER TABLE superadmin_audit ADD COLUMN detail varchar(120) NULL.
 *   3. CREATE INDEX idx_su_audit_target_user (target_user_id).
 *   4. VERIFICACIÓN: columnas + índice presentes.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa "ya existe", se
 * LOGUEA y se continúa. Cualquier OTRO error ABORTA con process.exit(1).
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada con `mysql2` en node_modules):
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-multirol-audit-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional (default: .../shared/portal.env). Lee DATABASE_URL.
 * NO LO EJECUTA Claude — lo lanza el runner/scheduler de despliegue.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[multirol-audit] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const T_AUDIT = 'superadmin_audit';
const NEW_COLUMNS = ['target_user_id', 'detail'];
const NEW_INDEX = 'idx_su_audit_target_user';

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
    console.error(`[multirol-audit] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[multirol-audit] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[multirol-audit] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[multirol-audit] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[multirol-audit] FATAL ${label}: ${err.message}`);
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
  console.log(`[multirol-audit] Conectado. env=${env}`);

  if (!(await tableExists(conn, T_AUDIT))) {
    console.error(
      `[multirol-audit] FATAL: la tabla ${T_AUDIT} no existe. Ejecuta primero fase-superadmin-migrate.mjs.`,
    );
    await conn.end().catch(() => {});
    process.exit(1);
  }

  // ── 1) target_user_id ──────────────────────────────────────────────────────
  await runIdempotent(
    conn,
    `ALTER TABLE ${T_AUDIT} ADD target_user_id`,
    `ALTER TABLE ${T_AUDIT} ADD COLUMN target_user_id varchar(36) NULL`,
  );

  // ── 2) detail ──────────────────────────────────────────────────────────────
  await runIdempotent(
    conn,
    `ALTER TABLE ${T_AUDIT} ADD detail`,
    `ALTER TABLE ${T_AUDIT} ADD COLUMN detail varchar(120) NULL`,
  );

  // ── 3) índice por usuario objetivo ─────────────────────────────────────────
  await runIdempotent(
    conn,
    `CREATE INDEX ${NEW_INDEX}`,
    `CREATE INDEX ${NEW_INDEX} ON ${T_AUDIT} (target_user_id)`,
  );

  // ── 4) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[multirol-audit] --- Verificación ---');
  let ok = true;

  for (const col of NEW_COLUMNS) {
    if (!(await columnExists(conn, T_AUDIT, col))) {
      console.error(`[multirol-audit] VERIFY FAIL: la columna ${col} no existe.`);
      ok = false;
    }
  }
  if (!(await indexExists(conn, T_AUDIT, NEW_INDEX))) {
    console.error(`[multirol-audit] VERIFY FAIL: el índice ${NEW_INDEX} no existe.`);
    ok = false;
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[multirol-audit] OK verificación: superadmin_audit ampliada para auditoría de roles.');
    process.exit(0);
  }
  console.error('[multirol-audit] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[multirol-audit] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
