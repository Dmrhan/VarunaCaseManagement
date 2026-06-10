/**
 * smoke-cases-create-actor-server-auth.js — PR-1 (Mock User actor fix).
 *
 * Çalıştır:
 *   node --env-file=.env scripts/smoke-cases-create-actor-server-auth.js
 *   node --env-file=.env scripts/smoke-cases-create-actor-server-auth.js --keep
 *
 * Business review ownership audit — PR-1.
 *
 * caseRepository.create + finalizeUpload üzerinden actor server-authoritative
 * davranışını doğrular. Route handler'ın `req.user.fullName`'i body'ye
 * enjekte etmesi nedeniyle direct repository çağrılarında simülasyon:
 *   - createdBy doluysa history actor o değer
 *   - createdBy boş ise eski 'Mock User' fallback (bu durum artık route
 *     katmanında oluşmaz — repo seviyesinde test edilir defansif)
 *
 * Route katmanı entegrasyon testi (POST /api/cases gerçek HTTP) için
 * canlı server gerek — bu smoke yalnız repo davranış + statik route guard
 * kontrolü yapar.
 *
 * Senaryolar:
 *   1.  UNIVERA company resolve
 *   2.  caseRepository.create createdBy='Test Agent' → history actor='Test Agent'
 *   3.  caseRepository.create createdBy boş → eski 'Mock User' fallback (repo
 *       defansif davranış intact — route katmanı bunu engeller)
 *   4.  finalizeUpload uploadedBy='Test Agent' → activity actor='Test Agent'
 *   5.  finalizeUpload uploadedBy boş → 'Mock User' fallback (repo intact)
 *
 * Static route invariants (HTTP gerektirmez):
 *   6.  POST /api/cases handler body.createdBy = req.user.fullName || body
 *       pattern'i (server-authoritative)
 *   7.  POST /files/finalize handler body.uploadedBy = req.user.fullName || body
 *
 * Cleanup: yaratılan case + attachment satırlarını siler (--keep ile koru).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../server/db/client.js';
import { caseRepository } from '../server/db/caseRepository.js';

const ROOT = resolve(import.meta.dirname, '..');
const ROUTE = resolve(ROOT, 'server/routes/cases.js');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, def = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.slice(n.length + 3);
  const idx = args.indexOf(`--${n}`);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return def;
};
const COMPANY = val('company', 'UNIVERA');
const KEEP = flag('keep');

let pass = 0;
let fail = 0;
let skip = 0;
const created = [];

function ok(name, detail = '') { pass += 1; console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail = '') { fail += 1; console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
function note(name, detail = '') { skip += 1; console.log(`⊘ ${name}${detail ? ' — ' + detail : ''}`); }

// ─── 1) Company resolve ──────────────────────────────────────────────

console.log('── 1) Company resolve ─────────────────────────────────');
let companyId = null;
let companyName = null;
try {
  const byId = await prisma.company.findUnique({ where: { id: COMPANY }, select: { id: true, name: true } });
  if (byId) { companyId = byId.id; companyName = byId.name; }
  else {
    const byName = await prisma.company.findUnique({ where: { name: COMPANY }, select: { id: true, name: true } });
    if (byName) { companyId = byName.id; companyName = byName.name; }
  }
} catch (err) {
  note('DB skip', `DB erişilemedi: ${err?.message}`);
}
if (!companyId) {
  // DB yoksa yalnız statik route invariant'larını koştur (6 + 7) ve çık.
  console.log('');
  console.log('── 6-7) Static route invariants only (DB yok) ─────────');
  const route = existsSync(ROUTE) ? readFileSync(ROUTE, 'utf8') : '';
  if (/body\.createdBy\s*=\s*req\.user\.fullName\s*\|\|\s*body\.createdBy/.test(route)) {
    ok('6) POST /api/cases createdBy server-authoritative');
  } else {
    bad('6) createdBy server-auth pattern eksik');
  }
  if (/body\.uploadedBy\s*=\s*req\.user\.fullName\s*\|\|\s*body\.uploadedBy/.test(route)) {
    ok('7) POST /files/finalize uploadedBy server-authoritative');
  } else {
    bad('7) uploadedBy server-auth pattern eksik');
  }
  console.log('');
  console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
}
ok('1) UNIVERA company resolve', `${companyId} (${companyName})`);

// ─── 2-3) Case create — createdBy authoritative ─────────────────────

console.log('');
console.log('── 2-3) Case create createdBy davranışı ───────────────');

let case1 = null;
try {
  case1 = await caseRepository.create({
    title: `[smoke] actor server-auth ${Date.now().toString(36)}`,
    description: 'Server-authoritative actor smoke.',
    caseType: 'GeneralSupport',
    priority: 'Medium',
    origin: 'Web',
    companyId,
    companyName,
    category: 'Genel',
    subCategory: 'Genel',
    requestType: 'Talep',
    createdBy: 'Test Agent',
  });
  created.push(case1.id);
  const act = await prisma.caseActivity.findFirst({
    where: { caseId: case1.id, actionType: 'CaseCreated' },
    select: { actor: true },
  });
  if (act?.actor === 'Test Agent') {
    ok('2) createdBy="Test Agent" → history actor="Test Agent"');
  } else {
    bad('2) Case create actor', JSON.stringify(act));
  }
} catch (err) {
  bad('2) create exception', err?.message ?? String(err));
}

let case2 = null;
try {
  case2 = await caseRepository.create({
    title: `[smoke] fallback ${Date.now().toString(36)}`,
    description: 'Fallback smoke (createdBy boş — route katmanı normalde önler).',
    caseType: 'GeneralSupport',
    priority: 'Medium',
    origin: 'Web',
    companyId,
    companyName,
    category: 'Genel',
    subCategory: 'Genel',
    requestType: 'Talep',
    // createdBy intentionally omitted → defansif 'Mock User' fallback test
  });
  created.push(case2.id);
  const act = await prisma.caseActivity.findFirst({
    where: { caseId: case2.id, actionType: 'CaseCreated' },
    select: { actor: true },
  });
  if (act?.actor === 'Mock User') {
    ok('3) createdBy boş → repo defansif "Mock User" fallback (route artık önler)');
  } else {
    bad('3) Empty createdBy fallback', JSON.stringify(act));
  }
} catch (err) {
  bad('3) create exception', err?.message ?? String(err));
}

// ─── 4-5) finalizeUpload uploadedBy server-authoritative ────────────

console.log('');
console.log('── 4-5) finalizeUpload uploadedBy davranışı ───────────');

if (case1) {
  try {
    // requestUpload step'ini bypass — testte signed URL gerekmez,
    // doğrudan finalize'a giriş.
    const fin = await caseRepository.finalizeUpload(
      case1.id,
      {
        attachmentId: `cmsa_smoke_${Date.now().toString(36)}_a`,
        path: `cases/${case1.id}/smoke-attachment-a.txt`,
        fileName: 'smoke-a.txt',
        fileSize: 12,
        mimeType: 'text/plain',
        uploadedBy: 'Test Agent',
      },
      [companyId],
    );
    if (fin?.file) {
      const act = await prisma.caseActivity.findFirst({
        where: { caseId: case1.id, actionType: 'FileUploaded' },
        orderBy: { at: 'desc' },
        select: { actor: true },
      });
      if (act?.actor === 'Test Agent') {
        ok('4) uploadedBy="Test Agent" → activity actor="Test Agent"');
      } else {
        bad('4) Finalize actor', JSON.stringify(act));
      }
    } else {
      bad('4) finalizeUpload', JSON.stringify(fin));
    }
  } catch (err) {
    bad('4) finalize exception', err?.message ?? String(err));
  }

  try {
    const fin = await caseRepository.finalizeUpload(
      case1.id,
      {
        attachmentId: `cmsa_smoke_${Date.now().toString(36)}_b`,
        path: `cases/${case1.id}/smoke-attachment-b.txt`,
        fileName: 'smoke-b.txt',
        fileSize: 12,
        mimeType: 'text/plain',
        // uploadedBy intentionally omitted
      },
      [companyId],
    );
    if (fin?.file) {
      const act = await prisma.caseActivity.findFirst({
        where: { caseId: case1.id, actionType: 'FileUploaded', toValue: 'smoke-b.txt' },
        orderBy: { at: 'desc' },
        select: { actor: true },
      });
      if (act?.actor === 'Mock User') {
        ok('5) uploadedBy boş → repo defansif "Mock User" fallback (route artık önler)');
      } else {
        bad('5) Empty uploadedBy fallback', JSON.stringify(act));
      }
    } else {
      bad('5) finalizeUpload (empty uploadedBy)', JSON.stringify(fin));
    }
  } catch (err) {
    bad('5) finalize exception', err?.message ?? String(err));
  }
}

// ─── 6-7) Static route invariants ───────────────────────────────────

console.log('');
console.log('── 6-7) Static route invariants ──────────────────────');
const route = existsSync(ROUTE) ? readFileSync(ROUTE, 'utf8') : '';

if (/body\.createdBy\s*=\s*req\.user\.fullName\s*\|\|\s*body\.createdBy/.test(route)) {
  ok('6) POST /api/cases handler: createdBy = req.user.fullName || body (server-authoritative)');
} else {
  bad('6) createdBy server-auth pattern eksik');
}

if (/body\.uploadedBy\s*=\s*req\.user\.fullName\s*\|\|\s*body\.uploadedBy/.test(route)) {
  ok('7) POST /files/finalize handler: uploadedBy = req.user.fullName || body (server-authoritative)');
} else {
  bad('7) uploadedBy server-auth pattern eksik');
}

// ─── Cleanup ─────────────────────────────────────────────────────────

if (!KEEP) {
  console.log('');
  console.log('── Cleanup ────────────────────────────────────────────');
  for (const id of created) {
    try {
      await prisma.caseAttachment.deleteMany({ where: { caseId: id } });
      await prisma.caseActivity.deleteMany({ where: { caseId: id } });
      await prisma.case.delete({ where: { id } });
    } catch (err) {
      console.log(`⊘ cleanup ${id}: ${err?.message}`);
    }
  }
  console.log(`   ${created.length} case temizlendi`);
}

console.log('');
console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);

await prisma.$disconnect().catch(() => {});
process.exit(fail > 0 ? 1 : 0);
