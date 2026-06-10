/**
 * smoke-smart-ticket-backend-auto-assign.js — PR-2 (Business review
 * ownership audit).
 *
 * Çalıştır:
 *   node --env-file=.env scripts/smoke-smart-ticket-backend-auto-assign.js
 *   node --env-file=.env scripts/smoke-smart-ticket-backend-auto-assign.js --keep
 *
 * caseRepository.create Smart Ticket creator auto-assign davranışını
 * doğrular. Backend transaction içinde assignedPersonId/Name +
 * (cross-tenant safe) assignedTeamId/Name set ediyor mu?
 *
 * Senaryolar:
 *   1.  UNIVERA company resolve + 2 farklı tenant company seç (cross-
 *       tenant test için)
 *   2.  Smart Ticket case + user.personId dolu → assignedPersonId +
 *       assignedTeamId set
 *   3.  Klasik case (customFields.smartTicket YOK) + user dolu →
 *       unassigned kalır (auto-assign atlanır)
 *   4.  Smart Ticket case + input.assignedPersonId pre-filled → backend
 *       override ETMEZ (operatör seçimi öncelikli)
 *   5.  Smart Ticket case + user.personId NULL (SystemAdmin simülasyon)
 *       → auto-assign atlanır; case unassigned ama actor doğru
 *   6.  Smart Ticket case + Person.team.companyId ≠ case.companyId →
 *       assignedPersonId set, assignedTeamId NULL (cross-tenant guard)
 *   7.  Smart Ticket case + Person.team YOK → assignedPersonId set,
 *       assignedTeamId NULL
 *   8.  "Vaka oluşturuldu" tek satır (ayrı "Üstlenildi" satırı yazılmaz)
 *   9.  Smart Ticket akışı L1→L2 transfer regression — assignedPersonId
 *       L2'ye değişiyor (PR-T1 davranışı korunur)
 *
 * Static route invariants:
 *   10. POST /api/cases handler caseRepository.create'e { user: req.user }
 *       geçiriyor
 *
 * Cleanup: yaratılan case'leri siler (--keep ile koru).
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

function runStaticOnly() {
  console.log('');
  console.log('── 10) Static route invariant only (DB yok) ───────────');
  const route = existsSync(ROUTE) ? readFileSync(ROUTE, 'utf8') : '';
  if (/caseRepository\.create\(body,\s*\{\s*user:\s*req\.user\s*\}\)/.test(route)) {
    ok('10) Route handler caseRepository.create(body, { user: req.user })');
  } else {
    bad('10) Route handler req.user geçirmiyor');
  }
  console.log('');
  console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);
  process.exit(fail > 0 ? 1 : 0);
}

// ─── 1) Company + Person fixture resolve ────────────────────────────

console.log('── 1) Fixture resolve ─────────────────────────────────');
let companyId = null;
let companyName = null;
let altCompany = null; // farklı tenant cross-tenant testi için
let agentPerson = null; // teamId mevcut + same company team
let crossTenantPerson = null; // Person.team başka tenant
let teamlessPerson = null; // Person.team yok

try {
  const byName = await prisma.company.findUnique({
    where: { name: COMPANY },
    select: { id: true, name: true },
  });
  if (byName) { companyId = byName.id; companyName = byName.name; }
  const all = await prisma.company.findMany({
    where: { id: { not: companyId } },
    take: 1,
    select: { id: true, name: true },
  });
  altCompany = all[0] ?? null;
  // Agent person: aynı şirket team'ine bağlı
  if (companyId) {
    agentPerson = await prisma.person.findFirst({
      where: { team: { companyId }, isActive: true },
      select: {
        id: true, name: true, teamId: true,
        team: { select: { id: true, name: true, companyId: true } },
      },
    });
  }
  // Cross-tenant person: team başka şirkette (Person UNIVERA team'inde
  // değil; alt tenant team'inde). Yoksa skip.
  if (altCompany?.id) {
    crossTenantPerson = await prisma.person.findFirst({
      where: { team: { companyId: altCompany.id }, isActive: true },
      select: {
        id: true, name: true, teamId: true,
        team: { select: { id: true, name: true, companyId: true } },
      },
    });
  }
  teamlessPerson = await prisma.person.findFirst({
    where: { teamId: null, isActive: true },
    select: { id: true, name: true, teamId: true, team: true },
  });
} catch (err) {
  note('DB skip', `DB erişilemedi: ${err?.message ?? err}`);
  runStaticOnly();
}

if (!companyId || !agentPerson) {
  note('Fixture skip', `companyId=${companyId} agentPerson=${!!agentPerson}`);
  runStaticOnly();
}
ok('1) Fixture', `company=${companyId} agent=${agentPerson.id} altCompany=${altCompany?.id ?? 'yok'} crossTenantPerson=${crossTenantPerson?.id ?? 'yok'} teamlessPerson=${teamlessPerson?.id ?? 'yok'}`);

const baseInput = (extra = {}) => ({
  title: `[smoke] auto-assign ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  description: 'Auto-assign smoke',
  caseType: 'GeneralSupport',
  priority: 'Medium',
  origin: 'Web',
  companyId,
  companyName,
  category: 'Genel',
  subCategory: 'Genel',
  requestType: 'Talep',
  createdBy: 'Test Agent',
  ...extra,
});

// ─── 2) Smart Ticket case + user.personId dolu ─────────────────────

console.log('');
console.log('── 2) Smart Ticket case + user → auto-assign ──────────');
try {
  const c = await caseRepository.create(
    baseInput({ customFields: { smartTicket: { platform: 'plat.x' } } }),
    { user: { personId: agentPerson.id, fullName: 'Test Agent', role: 'Agent' } },
  );
  created.push(c.id);
  const row = await prisma.case.findUnique({
    where: { id: c.id },
    select: { assignedPersonId: true, assignedPersonName: true, assignedTeamId: true, assignedTeamName: true },
  });
  if (
    row?.assignedPersonId === agentPerson.id &&
    row?.assignedTeamId === agentPerson.team?.id
  ) {
    ok('2) Smart Ticket: assignedPersonId + assignedTeamId set');
  } else {
    bad('2) Auto-assign yapılmadı', JSON.stringify(row));
  }
} catch (err) {
  bad('2) exception', err?.message ?? String(err));
}

// ─── 3) Klasik case (smartTicket YOK) → auto-assign atlanır ────────

console.log('');
console.log('── 3) Klasik case → auto-assign skip ──────────────────');
try {
  const c = await caseRepository.create(
    baseInput(), // customFields yok
    { user: { personId: agentPerson.id, fullName: 'Test Agent', role: 'Agent' } },
  );
  created.push(c.id);
  const row = await prisma.case.findUnique({
    where: { id: c.id },
    select: { assignedPersonId: true, assignedTeamId: true },
  });
  if (row?.assignedPersonId == null && row?.assignedTeamId == null) {
    ok('3) Klasik case: unassigned kalır (auto-assign tetiklenmez)');
  } else {
    bad('3) Klasik case auto-assign oldu', JSON.stringify(row));
  }
} catch (err) {
  bad('3) exception', err?.message ?? String(err));
}

// ─── 4) Smart Ticket + input.assignedPersonId → override etmez ─────

console.log('');
console.log('── 4) Smart Ticket + input.assignedPersonId → no-op ───');
try {
  const c = await caseRepository.create(
    baseInput({
      customFields: { smartTicket: { platform: 'plat.x' } },
      assignedPersonId: teamlessPerson?.id ?? agentPerson.id,
      assignedPersonName: teamlessPerson?.name ?? agentPerson.name,
    }),
    { user: { personId: agentPerson.id, fullName: 'Test Agent', role: 'Agent' } },
  );
  created.push(c.id);
  const expectedPid = teamlessPerson?.id ?? agentPerson.id;
  const row = await prisma.case.findUnique({
    where: { id: c.id },
    select: { assignedPersonId: true },
  });
  if (row?.assignedPersonId === expectedPid) {
    ok('4) input.assignedPersonId pre-filled → backend override etmiyor');
  } else {
    bad('4) Backend pre-filled değeri ezdi', JSON.stringify(row));
  }
} catch (err) {
  bad('4) exception', err?.message ?? String(err));
}

// ─── 5) Smart Ticket + user.personId NULL → atlanır ────────────────

console.log('');
console.log('── 5) Smart Ticket + user.personId null → skip ────────');
try {
  const c = await caseRepository.create(
    baseInput({ customFields: { smartTicket: { platform: 'plat.x' } } }),
    { user: { personId: null, fullName: 'System Admin', role: 'SystemAdmin' } },
  );
  created.push(c.id);
  const row = await prisma.case.findUnique({
    where: { id: c.id },
    select: { assignedPersonId: true, assignedTeamId: true },
  });
  if (row?.assignedPersonId == null && row?.assignedTeamId == null) {
    ok('5) SystemAdmin (personId null): unassigned kalır');
  } else {
    bad('5) personId null auto-assign oldu', JSON.stringify(row));
  }
} catch (err) {
  bad('5) exception', err?.message ?? String(err));
}

// ─── 5b) Codex P2 (PR #475) — SystemAdmin role + personId DOLU → skip ─

console.log('');
console.log('── 5b) SystemAdmin role + personId DOLU → skip ───────');
try {
  const c = await caseRepository.create(
    baseInput({ customFields: { smartTicket: { platform: 'plat.x' } } }),
    {
      user: {
        personId: agentPerson.id, // demo seed senaryosu: SystemAdmin'in personId'si var
        fullName: 'System Admin',
        role: 'SystemAdmin',
      },
    },
  );
  created.push(c.id);
  const row = await prisma.case.findUnique({
    where: { id: c.id },
    select: { assignedPersonId: true, assignedTeamId: true },
  });
  if (row?.assignedPersonId == null && row?.assignedTeamId == null) {
    ok('5b) Codex P2 — SystemAdmin (role) personId dolu olsa bile auto-assign skip');
  } else {
    bad('5b) SystemAdmin role gate ihlali', JSON.stringify(row));
  }
} catch (err) {
  bad('5b) exception', err?.message ?? String(err));
}

// 5c) Frontline rol seti dışı (Admin) → skip
console.log('');
console.log('── 5c) Admin role + personId DOLU → skip ─────────────');
try {
  const c = await caseRepository.create(
    baseInput({ customFields: { smartTicket: { platform: 'plat.x' } } }),
    {
      user: {
        personId: agentPerson.id,
        fullName: 'Admin User',
        role: 'Admin',
      },
    },
  );
  created.push(c.id);
  const row = await prisma.case.findUnique({
    where: { id: c.id },
    select: { assignedPersonId: true, assignedTeamId: true },
  });
  if (row?.assignedPersonId == null && row?.assignedTeamId == null) {
    ok('5c) Admin role auto-assign skip (frontline whitelist)');
  } else {
    bad('5c) Admin role gate ihlali', JSON.stringify(row));
  }
} catch (err) {
  bad('5c) exception', err?.message ?? String(err));
}

// 5d) user.role undefined → skip (defansif)
console.log('');
console.log('── 5d) user.role undefined → skip ────────────────────');
try {
  const c = await caseRepository.create(
    baseInput({ customFields: { smartTicket: { platform: 'plat.x' } } }),
    {
      user: {
        personId: agentPerson.id,
        fullName: 'No-Role User',
        // role explicit undefined
      },
    },
  );
  created.push(c.id);
  const row = await prisma.case.findUnique({
    where: { id: c.id },
    select: { assignedPersonId: true, assignedTeamId: true },
  });
  if (row?.assignedPersonId == null && row?.assignedTeamId == null) {
    ok('5d) user.role undefined → auto-assign skip (defansif whitelist)');
  } else {
    bad('5d) Role undefined gate ihlali', JSON.stringify(row));
  }
} catch (err) {
  bad('5d) exception', err?.message ?? String(err));
}

// ─── 6) Cross-tenant team guard ────────────────────────────────────

console.log('');
console.log('── 6) Cross-tenant Person.team guard ──────────────────');
if (!crossTenantPerson || !crossTenantPerson.team) {
  note('6) Cross-tenant test', 'alternatif tenant\'da team\'li person bulunamadı');
} else {
  try {
    const c = await caseRepository.create(
      baseInput({ customFields: { smartTicket: { platform: 'plat.x' } } }),
      { user: { personId: crossTenantPerson.id, fullName: 'CrossTenant Agent', role: 'Agent' } },
    );
    created.push(c.id);
    const row = await prisma.case.findUnique({
      where: { id: c.id },
      select: { assignedPersonId: true, assignedTeamId: true },
    });
    if (row?.assignedPersonId === crossTenantPerson.id && row?.assignedTeamId == null) {
      ok('6) Cross-tenant Person.team: assignedPersonId set, assignedTeamId NULL (guard)');
    } else {
      bad('6) Cross-tenant guard ihlali', JSON.stringify({ row, person: crossTenantPerson }));
    }
  } catch (err) {
    bad('6) exception', err?.message ?? String(err));
  }
}

// ─── 7) Teamless Person → team null ───────────────────────────────

console.log('');
console.log('── 7) Person.team YOK ─────────────────────────────────');
if (!teamlessPerson) {
  note('7) Teamless test', 'team\'siz aktif person bulunamadı');
} else {
  try {
    const c = await caseRepository.create(
      baseInput({ customFields: { smartTicket: { platform: 'plat.x' } } }),
      { user: { personId: teamlessPerson.id, fullName: 'Teamless Agent', role: 'Agent' } },
    );
    created.push(c.id);
    const row = await prisma.case.findUnique({
      where: { id: c.id },
      select: { assignedPersonId: true, assignedTeamId: true },
    });
    if (row?.assignedPersonId === teamlessPerson.id && row?.assignedTeamId == null) {
      ok('7) Teamless Person: assignedPersonId set, assignedTeamId NULL');
    } else {
      bad('7) Teamless person', JSON.stringify(row));
    }
  } catch (err) {
    bad('7) exception', err?.message ?? String(err));
  }
}

// ─── 8) "Vaka oluşturuldu" tek satır — "Üstlenildi" YOK ────────────

console.log('');
console.log('── 8) Activity tek satır ──────────────────────────────');
// Senaryo 2'deki case için kontrol et — ilk created[0]
if (created[0]) {
  const acts = await prisma.caseActivity.findMany({
    where: { caseId: created[0] },
    select: { actionType: true, action: true },
  });
  const createdCount = acts.filter((a) => a.actionType === 'CaseCreated').length;
  const claimLike = acts.filter((a) => /Üstlenildi|Üstlendim|claim/i.test(a.action ?? '')).length;
  if (createdCount === 1 && claimLike === 0) {
    ok('8) Tek "Vaka oluşturuldu" satırı, "Üstlenildi" tarzı satır YOK');
  } else {
    bad('8) Activity satır sayısı', JSON.stringify({ createdCount, claimLike, acts }));
  }
}

// ─── 9) Transfer regression — assignedPersonId değişir ─────────────

console.log('');
console.log('── 9) L1 → L2 transfer regression ─────────────────────');
if (created[0] && altCompany == null) {
  // Aynı şirkette başka takım/person bulup transfer dene
  const otherTeam = await prisma.team.findFirst({
    where: { companyId, id: { not: agentPerson.team?.id }, isActive: true },
    select: { id: true, name: true },
  });
  if (!otherTeam) {
    note('9) Transfer test', 'aynı şirkette ikinci aktif takım yok');
  } else {
    try {
      const r = await caseRepository.transferCase(
        created[0],
        {
          toTeamId: otherTeam.id,
          toPersonId: null,
          reason: 'L1 → L2',
          transferredBy: 'smoke-user',
          transferredByName: 'Smoke User',
        },
        [companyId],
      );
      const row = await prisma.case.findUnique({
        where: { id: created[0] },
        select: { assignedTeamId: true, assignedPersonId: true },
      });
      if (r?.case && row?.assignedTeamId === otherTeam.id && row?.assignedPersonId == null) {
        ok('9) Transfer: assignedTeamId yeni takım, assignedPersonId null (PR-T1 davranışı korunur)');
      } else {
        bad('9) Transfer regression', JSON.stringify({ row, transfer: r }));
      }
    } catch (err) {
      bad('9) transfer exception', err?.message ?? String(err));
    }
  }
} else {
  note('9) Transfer test', 'fixture yetersiz');
}

// ─── 10) Static route invariant ─────────────────────────────────────

console.log('');
console.log('── 10) Static route invariant ─────────────────────────');
const route = existsSync(ROUTE) ? readFileSync(ROUTE, 'utf8') : '';
if (/caseRepository\.create\(body,\s*\{\s*user:\s*req\.user\s*\}\)/.test(route)) {
  ok('10) Route handler caseRepository.create(body, { user: req.user })');
} else {
  bad('10) Route handler req.user geçirmiyor');
}

// ─── Cleanup ────────────────────────────────────────────────────────

if (!KEEP) {
  console.log('');
  console.log('── Cleanup ────────────────────────────────────────────');
  for (const id of created) {
    try {
      await prisma.caseTransfer.deleteMany({ where: { caseId: id } });
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
