#!/usr/bin/env node
/**
 * fase17-billing-profile-migrate.mjs — DATOS DE FACTURACIÓN del despacho y del
 * perito (Fase 17). ADITIVA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN, sobre dos tablas EXISTENTES:
 *
 *   organizations (datos fiscales/dirección de FACTURACIÓN del DESPACHO):
 *     ADD address_line1  varchar(255) NULL
 *     ADD address_line2  varchar(255) NULL
 *     ADD postal_code    varchar(16)  NULL
 *     ADD city           varchar(120) NULL
 *     ADD province       varchar(120) NULL
 *     ADD country        varchar(2)   NULL DEFAULT 'ES'
 *     ADD billing_email  varchar(255) NULL
 *     ADD phone          varchar(40)  NULL
 *   (`legal_name` y `nif` YA existen en organizations: se reutilizan como nombre
 *    fiscal y NIF/CIF. No se tocan.)
 *
 *   professional_profiles (datos fiscales/dirección de FACTURACIÓN del PERITO):
 *     ADD legal_name     varchar(255) NULL
 *     ADD tax_id         varchar(20)  NULL
 *     ADD address_line1  varchar(255) NULL
 *     ADD address_line2  varchar(255) NULL
 *     ADD postal_code    varchar(16)  NULL
 *     ADD province       varchar(120) NULL
 *     ADD country        varchar(2)   NULL DEFAULT 'ES'
 *   (`city`, `contact_email` y `phone` YA existen: se reutilizan. No se tocan.)
 *
 *   VERIFICACIÓN final: todas las columnas nuevas existen en su tabla.
 *
 * ADITIVA: solo AÑADE columnas nullables (algunas con DEFAULT 'ES') a tablas ya
 * existentes. No reescribe datos, no toca otras tablas ni el Modelo A. Las filas
 * existentes quedan con NULL (o 'ES' en country) → comportamiento equivalente al
 * actual (sin datos de facturación hasta que el despacho/perito los rellene).
 *
 * IDEMPOTENCIA: antes de cada ALTER se comprueba si la columna ya existe
 * (information_schema). Si existe, se SALTA. Si el motor devuelve "Duplicate
 * column"/"already exists", también se trata como aplicado. Re-ejecutable.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (NO se ejecuta aquí; desde una app desplegada con `mysql2`):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase17-billing-profile-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional; por defecto:
 *   /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 * Del env se lee DATABASE_URL (igual que packages/db/src/client.ts).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[fase17] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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
    console.error(`[fase17] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[fase17] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
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

/** Añade una columna a `table` solo si no existe. Idempotente y defensivo. */
async function addColumnIfMissing(conn, table, column, ddl) {
  const label = `ADD COLUMN ${table}.${column}`;
  if (await columnExists(conn, table, column)) {
    console.log(`[fase17] SKIP  ${label} (ya existe)`);
    return;
  }
  try {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[fase17] OK    ${label}`);
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[fase17] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return;
    }
    console.error(`[fase17] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

// Columnas a añadir, por tabla. Cada entrada: [columna, ddl].
const ORG_COLUMNS = [
  ['address_line1', "address_line1 varchar(255) NULL DEFAULT NULL"],
  ['address_line2', "address_line2 varchar(255) NULL DEFAULT NULL"],
  ['postal_code', "postal_code varchar(16) NULL DEFAULT NULL"],
  ['city', "city varchar(120) NULL DEFAULT NULL"],
  ['province', "province varchar(120) NULL DEFAULT NULL"],
  ['country', "country varchar(2) NULL DEFAULT 'ES'"],
  ['billing_email', "billing_email varchar(255) NULL DEFAULT NULL"],
  ['phone', "phone varchar(40) NULL DEFAULT NULL"],
];

const PERITO_COLUMNS = [
  ['legal_name', "legal_name varchar(255) NULL DEFAULT NULL"],
  ['tax_id', "tax_id varchar(20) NULL DEFAULT NULL"],
  ['address_line1', "address_line1 varchar(255) NULL DEFAULT NULL"],
  ['address_line2', "address_line2 varchar(255) NULL DEFAULT NULL"],
  ['postal_code', "postal_code varchar(16) NULL DEFAULT NULL"],
  ['province', "province varchar(120) NULL DEFAULT NULL"],
  ['country', "country varchar(2) NULL DEFAULT 'ES'"],
];

async function migrateTable(conn, table, columns) {
  if (!(await tableExists(conn, table))) {
    console.error(`[fase17] FATAL: la tabla ${table} no existe.`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
  for (const [column, ddl] of columns) {
    await addColumnIfMissing(conn, table, column, ddl);
  }
}

async function verifyTable(conn, table, columns) {
  let ok = true;
  for (const [column] of columns) {
    if (!(await columnExists(conn, table, column))) {
      console.error(`[fase17] VERIFY FAIL: la columna ${table}.${column} no existe.`);
      ok = false;
    } else {
      console.log(`[fase17] VERIFY OK: columna ${table}.${column} presente.`);
    }
  }
  return ok;
}

async function main() {
  const { env } = parseArgs(process.argv);
  const databaseUrl = readDatabaseUrl(env);

  const conn = await mysql.createConnection({
    uri: databaseUrl,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  console.log(`[fase17] Conectado. env=${env}`);

  // ── 1) organizations: dirección + contactos de facturación del despacho ──────
  await migrateTable(conn, 'organizations', ORG_COLUMNS);
  // ── 2) professional_profiles: datos fiscales del perito ──────────────────────
  await migrateTable(conn, 'professional_profiles', PERITO_COLUMNS);

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[fase17] --- Verificación ---');
  const okOrg = await verifyTable(conn, 'organizations', ORG_COLUMNS);
  const okPerito = await verifyTable(conn, 'professional_profiles', PERITO_COLUMNS);

  await conn.end().catch(() => {});

  if (okOrg && okPerito) {
    console.log('[fase17] OK datos de facturación (despacho + perito)');
    process.exit(0);
  }
  console.error('[fase17] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fase17] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
