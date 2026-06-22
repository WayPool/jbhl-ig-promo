#!/usr/bin/env node
/**
 * fase17-public-address-detail-migrate.mjs — DIRECCIÓN PÚBLICA DETALLADA del
 * despacho/letrado (Fase 17). ADITIVA e IDEMPOTENTE.
 *
 * El perfil PÚBLICO del despacho tenía la dirección como un único campo de texto
 * (`public_address`). Esta migración añade los campos de dirección PÚBLICA detallada
 * (calle/línea1, línea2, código postal, ciudad, provincia). Es la dirección de OFICINA
 * que el abogado decide mostrar al cliente — distinta de la dirección FISCAL (privada,
 * nunca visible al cliente: address_line1/…/province sin prefijo `public_`).
 *
 *   organizations (perfil PÚBLICO del despacho — dirección detallada):
 *     ADD public_address_line1 varchar(255) NULL  (calle y número)
 *     ADD public_address_line2 varchar(255) NULL  (piso/puerta, opcional)
 *     ADD public_postal_code   varchar(16)  NULL  (código postal)
 *     ADD public_city          varchar(120) NULL  (ciudad/localidad)
 *     ADD public_province      varchar(120) NULL  (provincia)
 *
 *   `public_address` (texto único) SE CONSERVA (deprecado). Tras añadir las columnas,
 *   se MIGRA su valor a `public_address_line1` SOLO para filas donde line1 aún sea NULL
 *   y public_address tenga contenido (best-effort, no destructivo: no se borra
 *   public_address). La VISIBILIDAD de toda la dirección la sigue gobernando la clave
 *   `addressPublic` en client_visible_fields (un único toggle para todo el bloque).
 *
 *   VERIFICACIÓN final: todas las columnas nuevas existen.
 *
 * ADITIVA: solo AÑADE columnas nullables y, opcionalmente, copia el texto antiguo a
 * line1. No reescribe otros datos ni toca otras tablas ni la dirección FISCAL.
 *
 * IDEMPOTENCIA: antes de cada ALTER se comprueba si la columna ya existe
 * (information_schema). Si existe, se SALTA. "Duplicate column"/"already exists"
 * también se tratan como aplicado. El backfill solo afecta filas con line1 NULL.
 * Re-ejecutable.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (NO se ejecuta aquí; desde una app desplegada con `mysql2`):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase17-public-address-detail-migrate.mjs \
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
    '[fase17-pubaddr] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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
    console.error(`[fase17-pubaddr] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[fase17-pubaddr] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
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
    console.log(`[fase17-pubaddr] SKIP  ${label} (ya existe)`);
    return;
  }
  try {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[fase17-pubaddr] OK    ${label}`);
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[fase17-pubaddr] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return;
    }
    console.error(`[fase17-pubaddr] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

// Columnas a añadir. Cada entrada: [columna, ddl].
const ORG_COLUMNS = [
  ['public_address_line1', "public_address_line1 varchar(255) NULL DEFAULT NULL"],
  ['public_address_line2', "public_address_line2 varchar(255) NULL DEFAULT NULL"],
  ['public_postal_code', "public_postal_code varchar(16) NULL DEFAULT NULL"],
  ['public_city', "public_city varchar(120) NULL DEFAULT NULL"],
  ['public_province', "public_province varchar(120) NULL DEFAULT NULL"],
];

async function migrateTable(conn, table, columns) {
  if (!(await tableExists(conn, table))) {
    console.error(`[fase17-pubaddr] FATAL: la tabla ${table} no existe.`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
  for (const [column, ddl] of columns) {
    await addColumnIfMissing(conn, table, column, ddl);
  }
}

/**
 * Backfill best-effort: copia el texto antiguo `public_address` a `public_address_line1`
 * SOLO en filas donde line1 aún esté vacío y public_address tenga contenido. No borra
 * public_address (no destructivo). Solo si AMBAS columnas existen.
 */
async function backfillLine1FromLegacy(conn) {
  const hasLegacy = await columnExists(conn, 'organizations', 'public_address');
  const hasLine1 = await columnExists(conn, 'organizations', 'public_address_line1');
  if (!hasLegacy || !hasLine1) {
    console.log('[fase17-pubaddr] SKIP  backfill line1 (falta public_address o public_address_line1)');
    return;
  }
  const [res] = await conn.query(
    `UPDATE organizations
        SET public_address_line1 = public_address
      WHERE (public_address_line1 IS NULL OR public_address_line1 = '')
        AND public_address IS NOT NULL AND public_address <> ''`,
  );
  console.log(`[fase17-pubaddr] OK    backfill line1 desde public_address (filas afectadas: ${res.affectedRows ?? 0})`);
}

async function verifyTable(conn, table, columns) {
  let ok = true;
  for (const [column] of columns) {
    if (!(await columnExists(conn, table, column))) {
      console.error(`[fase17-pubaddr] VERIFY FAIL: la columna ${table}.${column} no existe.`);
      ok = false;
    } else {
      console.log(`[fase17-pubaddr] VERIFY OK: columna ${table}.${column} presente.`);
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
  console.log(`[fase17-pubaddr] Conectado. env=${env}`);

  // ── 1) organizations: dirección pública detallada ────────────────────────────
  await migrateTable(conn, 'organizations', ORG_COLUMNS);
  // ── 2) backfill best-effort del texto antiguo a line1 ────────────────────────
  await backfillLine1FromLegacy(conn);

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[fase17-pubaddr] --- Verificación ---');
  const okOrg = await verifyTable(conn, 'organizations', ORG_COLUMNS);

  await conn.end().catch(() => {});

  if (okOrg) {
    console.log('[fase17-pubaddr] OK dirección pública detallada (despacho)');
    process.exit(0);
  }
  console.error('[fase17-pubaddr] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fase17-pubaddr] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
