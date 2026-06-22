#!/usr/bin/env node
/**
 * fase17-client-visibility-migrate.mjs — VISIBILIDAD por campo de cara al CLIENTE
 * (Fase 17). ADITIVA e IDEMPOTENTE.
 *
 * El despacho/letrado y el perito eligen, campo por campo, qué datos de su PERFIL
 * PÚBLICO ven los clientes. Esta migración añade:
 *
 *   organizations (perfil PÚBLICO del despacho + control de visibilidad):
 *     ADD public_name          varchar(255) NULL  (nombre público de cara al cliente)
 *     ADD public_phone         varchar(40)  NULL  (teléfono público; ≠ phone fiscal)
 *     ADD public_contact_email varchar(255) NULL  (email público; ≠ billing_email)
 *     ADD public_address       varchar(255) NULL  (dirección/ciudad PÚBLICA)
 *     ADD public_bio           text         NULL  (presentación breve)
 *     ADD client_visible_fields json        NULL  (array de claves públicas visibles)
 *
 *   professional_profiles (control de visibilidad del PERITO):
 *     ADD client_visible_fields json        NULL  (array de claves públicas visibles)
 *
 *   VERIFICACIÓN final: todas las columnas nuevas existen en su tabla.
 *
 * ADITIVA: solo AÑADE columnas nullables a tablas existentes. No reescribe datos ni
 * toca otras tablas. Las filas existentes quedan con NULL en `client_visible_fields`
 * → la app aplica el DEFAULT razonable (despacho: solo el nombre público visible;
 * perito: nombre/especialidades/ciudad/colegio/bio visibles, teléfono/email ocultos).
 * Los datos FISCALES (legal_name/nif/tax_id/dirección fiscal/billing_email) NO llevan
 * toggle y NUNCA se exponen al cliente.
 *
 * IDEMPOTENCIA: antes de cada ALTER se comprueba si la columna ya existe
 * (information_schema). Si existe, se SALTA. "Duplicate column"/"already exists"
 * también se tratan como aplicado. Re-ejecutable.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (NO se ejecuta aquí; desde una app desplegada con `mysql2`):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase17-client-visibility-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` opcional; por defecto:
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
    '[fase17-vis] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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
    console.error(`[fase17-vis] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[fase17-vis] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
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
    console.log(`[fase17-vis] SKIP  ${label} (ya existe)`);
    return;
  }
  try {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[fase17-vis] OK    ${label}`);
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[fase17-vis] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return;
    }
    console.error(`[fase17-vis] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

// Columnas a añadir, por tabla. Cada entrada: [columna, ddl].
const ORG_COLUMNS = [
  ['public_name', "public_name varchar(255) NULL DEFAULT NULL"],
  ['public_phone', "public_phone varchar(40) NULL DEFAULT NULL"],
  ['public_contact_email', "public_contact_email varchar(255) NULL DEFAULT NULL"],
  ['public_address', "public_address varchar(255) NULL DEFAULT NULL"],
  ['public_bio', "public_bio text NULL DEFAULT NULL"],
  ['client_visible_fields', "client_visible_fields json NULL DEFAULT NULL"],
];

const PERITO_COLUMNS = [
  ['client_visible_fields', "client_visible_fields json NULL DEFAULT NULL"],
];

async function migrateTable(conn, table, columns) {
  if (!(await tableExists(conn, table))) {
    console.error(`[fase17-vis] FATAL: la tabla ${table} no existe.`);
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
      console.error(`[fase17-vis] VERIFY FAIL: la columna ${table}.${column} no existe.`);
      ok = false;
    } else {
      console.log(`[fase17-vis] VERIFY OK: columna ${table}.${column} presente.`);
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
  console.log(`[fase17-vis] Conectado. env=${env}`);

  // ── 1) organizations: perfil público + control de visibilidad ────────────────
  await migrateTable(conn, 'organizations', ORG_COLUMNS);
  // ── 2) professional_profiles: control de visibilidad del perito ──────────────
  await migrateTable(conn, 'professional_profiles', PERITO_COLUMNS);

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[fase17-vis] --- Verificación ---');
  const okOrg = await verifyTable(conn, 'organizations', ORG_COLUMNS);
  const okPerito = await verifyTable(conn, 'professional_profiles', PERITO_COLUMNS);

  await conn.end().catch(() => {});

  if (okOrg && okPerito) {
    console.log('[fase17-vis] OK visibilidad de cliente (despacho + perito)');
    process.exit(0);
  }
  console.error('[fase17-vis] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fase17-vis] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
