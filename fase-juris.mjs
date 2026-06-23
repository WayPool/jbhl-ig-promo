#!/usr/bin/env node
/**
 * fase-jurisprudencia-migrate.mjs — Migración "Jurisprudencia (Letrado IA, Fase 1)".
 * AUTOCONTENIDA e IDEMPOTENTE. Mismo patrón que `fase-superadmin-migrate.mjs`.
 *
 * Qué hace (todo ADITIVO; no toca datos existentes; JBH intacto):
 *   1. CREATE TABLE IF NOT EXISTS de TODAS las tablas del módulo de jurisprudencia:
 *      legal_precedents, legal_precedent_chunks, legal_precedent_links,
 *      legal_precedent_reports, legal_precedent_favorites,
 *      legal_precedent_collections, legal_precedent_collection_items,
 *      criminal_taxonomy — todas con índices y CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci.
 *   2. SEED idempotente de `criminal_taxonomy` (INSERT IGNORE por `slug` único).
 *   3. VERIFICACIÓN: tablas + índices clave presentes.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa "ya existe", se
 * LOGUEA y se continúa. El seed usa INSERT IGNORE (slug único). Cualquier OTRO
 * error ABORTA con process.exit(1).
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada con `mysql2` en node_modules):
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-jurisprudencia-migrate.mjs \
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
    '[jurisprudencia] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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

function readDatabaseUrl(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (e) {
    console.error(`[jurisprudencia] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[jurisprudencia] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[jurisprudencia] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[jurisprudencia] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[jurisprudencia] FATAL ${label}: ${err.message}`);
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

// ── DDL ───────────────────────────────────────────────────────────────────────
const TABLES = [
  {
    name: 'legal_precedents',
    ddl: `CREATE TABLE IF NOT EXISTS legal_precedents (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       title varchar(500) NOT NULL,
       document_type varchar(60) NULL,
       court varchar(200) NULL,
       chamber varchar(120) NULL,
       section varchar(120) NULL,
       jurisdiction varchar(60) NULL,
       resolution_date date NULL,
       resolution_number varchar(120) NULL,
       appeal_number varchar(120) NULL,
       ecli varchar(120) NULL,
       source_type varchar(20) NULL,
       source_name varchar(200) NULL,
       source_url varchar(1000) NULL,
       original_download_url varchar(1000) NULL,
       uploaded_by_user_id varchar(36) NULL,
       uploaded_by_org_id varchar(36) NULL,
       visibility varchar(20) NOT NULL DEFAULT 'private_org',
       status varchar(30) NOT NULL DEFAULT 'subido',
       validation_status varchar(30) NULL,
       verified_at datetime NULL,
       verified_by_user_id varchar(36) NULL,
       language varchar(10) NOT NULL DEFAULT 'es',
       summary_short varchar(1000) NULL,
       summary_technical text NULL,
       doctrine text NULL,
       facts_summary text NULL,
       legal_grounds_summary text NULL,
       ruling_summary text NULL,
       useful_for text NULL,
       limitations text NULL,
       tags json NULL,
       criminal_categories json NULL,
       legal_articles json NULL,
       other_norms json NULL,
       keywords json NULL,
       relevance_level int NULL,
       hash varchar(128) NULL,
       storage_provider varchar(20) NOT NULL DEFAULT 'r2',
       storage_path varchar(500) NULL,
       file_mime varchar(100) NULL,
       file_size_bytes int NULL,
       upload_status varchar(20) NOT NULL DEFAULT 'scanning',
       extracted_text_chars int NULL,
       private_data_risk varchar(20) NOT NULL DEFAULT 'unknown',
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       archived_at datetime NULL,
       PRIMARY KEY (id),
       KEY idx_legal_precedents_org (uploaded_by_org_id),
       KEY idx_legal_precedents_status (status),
       KEY idx_legal_precedents_visibility (visibility),
       KEY idx_legal_precedents_court (court),
       KEY idx_legal_precedents_resolution_date (resolution_date),
       KEY idx_legal_precedents_ecli (ecli),
       KEY idx_legal_precedents_hash (hash)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: [
      'idx_legal_precedents_org',
      'idx_legal_precedents_status',
      'idx_legal_precedents_visibility',
      'idx_legal_precedents_court',
      'idx_legal_precedents_resolution_date',
      'idx_legal_precedents_ecli',
      'idx_legal_precedents_hash',
    ],
  },
  {
    name: 'legal_precedent_chunks',
    ddl: `CREATE TABLE IF NOT EXISTS legal_precedent_chunks (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       precedent_id varchar(36) NOT NULL,
       org_id_nullable varchar(36) NULL,
       chunk_index int NOT NULL,
       text text NULL,
       page_start int NULL,
       page_end int NULL,
       section_type varchar(20) NULL,
       embedding_ref varchar(255) NULL,
       embedding_model varchar(120) NULL,
       metadata json NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_legal_precedent_chunks_precedent (precedent_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: ['idx_legal_precedent_chunks_precedent'],
  },
  {
    name: 'legal_precedent_links',
    ddl: `CREATE TABLE IF NOT EXISTS legal_precedent_links (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       precedent_id varchar(36) NOT NULL,
       case_id varchar(36) NOT NULL,
       org_id varchar(36) NOT NULL,
       linked_by_user_id varchar(36) NULL,
       orientation varchar(20) NULL,
       purpose varchar(255) NULL,
       relevance int NULL,
       is_primary tinyint(1) NOT NULL DEFAULT 0,
       selected_fragments json NULL,
       private_notes text NULL,
       allow_ai_use tinyint(1) NOT NULL DEFAULT 0,
       visible_to_client tinyint(1) NOT NULL DEFAULT 0,
       related_facts json NULL,
       related_document_ids json NULL,
       related_strategy text NULL,
       appears_in_reports tinyint(1) NOT NULL DEFAULT 0,
       status varchar(20) NOT NULL DEFAULT 'active',
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_legal_precedent_links_case (case_id),
       KEY idx_legal_precedent_links_org (org_id),
       KEY idx_legal_precedent_links_precedent (precedent_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: [
      'idx_legal_precedent_links_case',
      'idx_legal_precedent_links_org',
      'idx_legal_precedent_links_precedent',
    ],
  },
  {
    name: 'legal_precedent_reports',
    ddl: `CREATE TABLE IF NOT EXISTS legal_precedent_reports (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       precedent_id varchar(36) NOT NULL,
       reported_by_user_id varchar(36) NULL,
       org_id varchar(36) NULL,
       reason varchar(120) NULL,
       description text NULL,
       status varchar(20) NOT NULL DEFAULT 'open',
       reviewed_by_user_id varchar(36) NULL,
       resolution text NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_legal_precedent_reports_precedent (precedent_id),
       KEY idx_legal_precedent_reports_status (status)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: [
      'idx_legal_precedent_reports_precedent',
      'idx_legal_precedent_reports_status',
    ],
  },
  {
    name: 'legal_precedent_favorites',
    ddl: `CREATE TABLE IF NOT EXISTS legal_precedent_favorites (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       precedent_id varchar(36) NOT NULL,
       user_id varchar(36) NOT NULL,
       org_id varchar(36) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_legal_precedent_favorites_user_precedent (user_id, precedent_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: ['uq_legal_precedent_favorites_user_precedent'],
  },
  {
    name: 'legal_precedent_collections',
    ddl: `CREATE TABLE IF NOT EXISTS legal_precedent_collections (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       name varchar(255) NOT NULL,
       owner_user_id varchar(36) NULL,
       org_id varchar(36) NULL,
       is_shared tinyint(1) NOT NULL DEFAULT 0,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_legal_precedent_collections_org (org_id),
       KEY idx_legal_precedent_collections_owner (owner_user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: [
      'idx_legal_precedent_collections_org',
      'idx_legal_precedent_collections_owner',
    ],
  },
  {
    name: 'legal_precedent_collection_items',
    ddl: `CREATE TABLE IF NOT EXISTS legal_precedent_collection_items (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       collection_id varchar(36) NOT NULL,
       precedent_id varchar(36) NOT NULL,
       added_by_user_id varchar(36) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_legal_precedent_collection_items_collection (collection_id),
       KEY idx_legal_precedent_collection_items_precedent (precedent_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: [
      'idx_legal_precedent_collection_items_collection',
      'idx_legal_precedent_collection_items_precedent',
    ],
  },
  {
    name: 'criminal_taxonomy',
    ddl: `CREATE TABLE IF NOT EXISTS criminal_taxonomy (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       slug varchar(120) NOT NULL,
       label varchar(255) NOT NULL,
       parent_id varchar(36) NULL,
       kind varchar(20) NULL,
       sort_order int NOT NULL DEFAULT 0,
       active tinyint(1) NOT NULL DEFAULT 1,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_criminal_taxonomy_slug (slug),
       KEY idx_criminal_taxonomy_parent (parent_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    indexes: ['uq_criminal_taxonomy_slug', 'idx_criminal_taxonomy_parent'],
  },
];

// ── SEED criminal_taxonomy ─────────────────────────────────────────────────────
// kind aproximado por grupo; sortOrder incremental. slug único → INSERT IGNORE.
const TAXONOMY_SEED = [
  ['delitos-contra-las-personas', 'Delitos contra las personas', 'delito'],
  ['delitos-contra-la-libertad', 'Delitos contra la libertad', 'delito'],
  ['delitos-contra-la-libertad-sexual', 'Delitos contra la libertad sexual', 'delito'],
  ['delitos-contra-el-patrimonio', 'Delitos contra el patrimonio', 'delito'],
  ['delitos-economicos', 'Delitos económicos', 'delito'],
  ['delitos-societarios', 'Delitos societarios', 'delito'],
  ['blanqueo-de-capitales', 'Blanqueo de capitales', 'delito'],
  ['estafa', 'Estafa', 'delito'],
  ['apropiacion-indebida', 'Apropiación indebida', 'delito'],
  ['administracion-desleal', 'Administración desleal', 'delito'],
  ['insolvencias-punibles', 'Insolvencias punibles', 'delito'],
  ['delitos-contra-la-hacienda-publica', 'Delitos contra la Hacienda Pública', 'delito'],
  ['delitos-contra-la-seguridad-social', 'Delitos contra la Seguridad Social', 'delito'],
  ['falsedad-documental', 'Falsedad documental', 'delito'],
  ['delitos-informaticos', 'Delitos informáticos', 'delito'],
  ['delitos-contra-la-intimidad', 'Delitos contra la intimidad', 'delito'],
  ['delitos-contra-el-honor', 'Delitos contra el honor', 'delito'],
  ['seguridad-vial', 'Seguridad vial', 'delito'],
  ['salud-publica', 'Salud pública', 'delito'],
  ['delitos-contra-la-administracion-publica', 'Delitos contra la Administración Pública', 'delito'],
  ['cohecho', 'Cohecho', 'delito'],
  ['malversacion', 'Malversación', 'delito'],
  ['prevaricacion', 'Prevaricación', 'delito'],
  ['alzamiento-de-bienes', 'Alzamiento de bienes', 'delito'],
  ['organizacion-criminal', 'Organización criminal', 'delito'],
  ['terrorismo', 'Terrorismo', 'delito'],
  ['violencia-de-genero', 'Violencia de género', 'delito'],
  ['violencia-domestica', 'Violencia doméstica', 'delito'],
  ['menores', 'Menores', 'procesal'],
  ['extradicion', 'Extradición', 'procesal'],
  ['orden-europea-de-detencion', 'Orden europea de detención', 'procesal'],
  ['prision-provisional', 'Prisión provisional', 'procesal'],
  ['medidas-cautelares', 'Medidas cautelares', 'procesal'],
  ['recursos', 'Recursos', 'recurso'],
  ['apelacion', 'Apelación', 'recurso'],
  ['casacion', 'Casación', 'recurso'],
  ['revision', 'Revisión', 'recurso'],
  ['nulidad-de-actuaciones', 'Nulidad de actuaciones', 'recurso'],
  ['prueba-penal', 'Prueba penal', 'prueba'],
  ['prueba-ilicita', 'Prueba ilícita', 'prueba'],
  ['cadena-de-custodia', 'Cadena de custodia', 'prueba'],
  ['declaracion-de-testigos', 'Declaración de testigos', 'prueba'],
  ['declaracion-de-coimputados', 'Declaración de coimputados', 'prueba'],
  ['confesion', 'Confesión', 'prueba'],
  ['presuncion-de-inocencia', 'Presunción de inocencia', 'procesal'],
  ['derecho-de-defensa', 'Derecho de defensa', 'procesal'],
  ['dilaciones-indebidas', 'Dilaciones indebidas', 'procesal'],
  ['atenuantes', 'Atenuantes', 'pena'],
  ['agravantes', 'Agravantes', 'pena'],
  ['eximentes', 'Eximentes', 'pena'],
  ['responsabilidad-civil', 'Responsabilidad civil', 'otro'],
  ['ejecucion-penal', 'Ejecución penal', 'pena'],
  ['suspension-de-condena', 'Suspensión de condena', 'pena'],
  ['sustitucion-de-penas', 'Sustitución de penas', 'pena'],
  ['cancelacion-de-antecedentes', 'Cancelación de antecedentes', 'pena'],
];

async function seedTaxonomy(conn) {
  let sort = 0;
  for (const [slug, label, kind] of TAXONOMY_SEED) {
    await runIdempotent(
      conn,
      `SEED criminal_taxonomy ${slug}`,
      `INSERT IGNORE INTO criminal_taxonomy (id, slug, label, parent_id, kind, sort_order, active)
         VALUES (UUID(), ?, ?, NULL, ?, ?, 1)`,
      [slug, label, kind, sort],
    );
    sort += 10;
  }
}

async function main() {
  const { env } = parseArgs(process.argv);
  const databaseUrl = readDatabaseUrl(env);

  const conn = await mysql.createConnection({
    uri: databaseUrl,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  console.log(`[jurisprudencia] Conectado. env=${env}`);

  // ── 1) Tablas ───────────────────────────────────────────────────────────────
  for (const t of TABLES) {
    await runIdempotent(conn, `CREATE TABLE ${t.name}`, t.ddl);
  }

  // ── 2) Seed de taxonomía penal ───────────────────────────────────────────────
  console.log('[jurisprudencia] --- Seed criminal_taxonomy ---');
  await seedTaxonomy(conn);

  // ── 3) VERIFICACIÓN ───────────────────────────────────────────────────────────
  console.log('[jurisprudencia] --- Verificación ---');
  let ok = true;

  for (const t of TABLES) {
    if (!(await tableExists(conn, t.name))) {
      console.error(`[jurisprudencia] VERIFY FAIL: la tabla ${t.name} no existe.`);
      ok = false;
      continue;
    }
    for (const idx of t.indexes) {
      if (!(await indexExists(conn, t.name, idx))) {
        console.error(`[jurisprudencia] VERIFY FAIL: el índice ${idx} no existe en ${t.name}.`);
        ok = false;
      }
    }
  }

  // Verifica que el seed entró (al menos una fila conocida).
  const [seedRows] = await conn.query(
    `SELECT COUNT(*) AS n FROM criminal_taxonomy WHERE slug = 'estafa'`,
  );
  if (!seedRows.length || Number(seedRows[0].n) < 1) {
    console.error('[jurisprudencia] VERIFY FAIL: el seed de criminal_taxonomy no se aplicó.');
    ok = false;
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[jurisprudencia] OK verificación: tablas de jurisprudencia y taxonomía listas.');
    process.exit(0);
  }
  console.error('[jurisprudencia] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[jurisprudencia] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
