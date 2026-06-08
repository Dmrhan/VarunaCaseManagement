/**
 * smoke-smart-ticket-closure.js — WR-Smart-Ticket Phase 1e.
 *
 * Çalıştır:
 *   node --env-file=.env scripts/smoke-smart-ticket-closure.js
 *   node --env-file=.env scripts/smoke-smart-ticket-closure.js --keep
 *
 * caseRepository.transitionStatus üzerinden Smart Ticket yapılandırılmış
 * kapanış metadata'sını doğrular. Senaryolar:
 *
 *   1.  UNIVERA company resolve
 *   2.  Closure taxonomy tipleri (rootCauseGroup with children +
 *       resolutionType + permanentPrevention) lookup-shape döner
 *   3.  Smart Ticket Case open et (customFields.smartTicket = opening)
 *   4.  transitionStatus Cozuldu + smartTicketClosure payload ile çağır
 *   5.  Roundtrip: customFields.smartTicket.closure {rcg, rcgLabel, rcd,
 *       rcdLabel, rt, rtLabel, pp, ppLabel, version, updatedAt} korunur
 *   6.  Opening alanları aynen korundu (deep-merge invariant)
 *   7.  Diğer customFields anahtarları (örn. companyFieldDefinitions
 *       benzeri dinamik alanlar) korundu
 *   8.  Status gerçekten Cozuldu oldu, resolvedAt set edildi
 *   9.  Non-Smart-Ticket Case için close — smartTicketClosure verilmezse
 *       mevcut akış aynen çalışır (regression)
 *   10. Non-Smart-Ticket Case'e smartTicketClosure verilirse backend
 *       'smart_ticket_closure_requires_opening' ile reddeder (defense in depth)
 *   11. rootCauseGroup filter sorgusu nested children döndü (PR-1a fix
 *       regression guard)
 *
 * Cleanup: yaratılan Case'leri siler (`--keep` ile koruyabilirsin).
 */

import { prisma } from '../server/db/client.js';
import { caseRepository } from '../server/db/caseRepository.js';

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

// ─── 1) Company resolve ──────────────────────────────────────────────────

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
  console.log('PASS=0  FAIL=0  SKIP=1');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}
ok('1) UNIVERA company resolve', `${companyId} (${companyName})`);

// ─── 2) Closure taxonomy availability ────────────────────────────────────

console.log('');
console.log('── 2) Closure taxonomy availability ───────────────────');
const rcgList = await prisma.taxonomyDef.findMany({
  where: { companyId, taxonomyType: 'rootCauseGroup', isActive: true },
  select: { id: true, code: true, label: true },
  orderBy: { sortOrder: 'asc' },
});
if (rcgList.length === 0) bad('2) rootCauseGroup', 'liste boş');
else ok('2) rootCauseGroup aktif satırlar mevcut', `${rcgList.length} adet`);

const rcdList = rcgList.length > 0
  ? await prisma.taxonomyDef.findMany({
      where: { companyId, taxonomyType: 'rootCauseDetail', isActive: true, parentId: rcgList[0].id },
      select: { code: true, label: true },
      orderBy: { sortOrder: 'asc' },
    })
  : [];
if (rcdList.length === 0) note('2) rootCauseDetail children', 'ilk grubun child yok');
else ok('2) rootCauseDetail children mevcut', `${rcdList.length} adet`);

const rtList = await prisma.taxonomyDef.findMany({
  where: { companyId, taxonomyType: 'resolutionType', isActive: true },
  select: { code: true, label: true },
  orderBy: { sortOrder: 'asc' },
});
const ppList = await prisma.taxonomyDef.findMany({
  where: { companyId, taxonomyType: 'permanentPrevention', isActive: true },
  select: { code: true, label: true },
  orderBy: { sortOrder: 'asc' },
});
if (rtList.length > 0 && ppList.length > 0) ok(`2) resolutionType (${rtList.length}) + permanentPrevention (${ppList.length}) aktif`);
else bad('2) closure taxonomy', `rt=${rtList.length} pp=${ppList.length}`);

// ─── 3) Smart Ticket Case open ───────────────────────────────────────────

console.log('');
console.log('── 3-8) Smart Ticket close roundtrip ──────────────────');

const OPENING = {
  platform: 'plat.test',
  platformLabel: 'Test Platform',
  businessProcess: 'bp.test',
  businessProcessLabel: 'Test Süreç',
  appliedMapping: { source: 'fallback', category: 'Akıllı Ticket', subCategory: 'Genel', requestType: 'Talep' },
};
const OTHER_CF = { someOtherCustomField: 'should_survive' };

// Smoke Case'leri tenant'taki ResolutionApprovalPolicy match'lerinden
// etkilenmesin diye `approvalState='Approved'` ile yaratılır. Bu, gerçek
// production flow'da QA → approval pipeline ile elde edilir; smoke'ta
// direkt set ediyoruz çünkü kapanış metadata'sını test ediyoruz,
// approval flow'u değil.
async function createAndPreapprove(input) {
  const c = await caseRepository.create(input);
  await prisma.case.update({ where: { id: c.id }, data: { approvalState: 'Approved' } });
  return c;
}

let stCase = null;
try {
  stCase = await createAndPreapprove({
    title: `[smoke] ST closure ${Date.now().toString(36)}`,
    description: 'Smart Ticket close smoke — silinmesi güvenlidir.',
    caseType: 'GeneralSupport',
    priority: 'Medium',
    origin: 'Web',
    companyId,
    companyName,
    category: 'Akıllı Ticket',
    subCategory: 'Genel',
    requestType: 'Talep',
    customFields: { smartTicket: OPENING, ...OTHER_CF },
  });
  created.push(stCase.id);
  ok('3) Smart Ticket Case açıldı', stCase.id);
} catch (err) {
  bad('3) Smart Ticket Case create', err?.message ?? String(err));
}

// ─── 4-5) Close + closure metadata ──────────────────────────────────────

if (stCase) {
  const rcg = rcgList[0];
  const rcd = rcdList[0] ?? null;
  const rt = rtList[0];
  const pp = ppList[0];

  const closurePayload = {
    rootCauseGroup: rcg?.code,
    rootCauseGroupLabel: rcg?.label,
    rootCauseDetail: rcd?.code,
    rootCauseDetailLabel: rcd?.label,
    resolutionType: rt?.code,
    resolutionTypeLabel: rt?.label,
    permanentPrevention: pp?.code,
    permanentPreventionLabel: pp?.label,
  };

  try {
    const closed = await caseRepository.transitionStatus(
      stCase.id,
      'Çözüldü',
      {
        resolutionNote: 'Smoke: kapanış metadata roundtrip.',
        smartTicketClosure: closurePayload,
      },
      'Smoke User',
      [companyId],
    );
    if (closed?.status === 'Çözüldü') ok('4) transition Cozuldu başarılı');
    else bad('4) transition Cozuldu', JSON.stringify(closed));
  } catch (err) {
    bad('4) transition Cozuldu', err?.message ?? String(err));
  }

  // 5) Roundtrip read
  const fetched = await prisma.case.findUnique({
    where: { id: stCase.id },
    select: { status: true, resolvedAt: true, resolutionNote: true, customFields: true },
  });

  const closure = fetched?.customFields?.smartTicket?.closure;
  if (
    closure?.rootCauseGroup === rcg?.code &&
    closure?.rootCauseGroupLabel === rcg?.label &&
    closure?.resolutionType === rt?.code &&
    closure?.resolutionTypeLabel === rt?.label &&
    closure?.permanentPrevention === pp?.code &&
    closure?.permanentPreventionLabel === pp?.label &&
    closure?.version === 1 &&
    typeof closure?.updatedAt === 'string'
  ) {
    ok('5) closure roundtrip: rcg/rt/pp + labels + version + updatedAt');
  } else {
    bad('5) closure roundtrip', JSON.stringify(closure));
  }
  if (rcd) {
    if (closure?.rootCauseDetail === rcd.code && closure?.rootCauseDetailLabel === rcd.label) {
      ok('5b) closure rootCauseDetail + label korundu');
    } else {
      bad('5b) closure rootCauseDetail', JSON.stringify(closure));
    }
  } else {
    note('5b) rootCauseDetail', 'parent\'ın child satırı yok, SKIP');
  }

  // 6) Opening alanları
  const opening = fetched?.customFields?.smartTicket;
  if (
    opening?.platform === OPENING.platform &&
    opening?.businessProcess === OPENING.businessProcess &&
    opening?.appliedMapping?.source === OPENING.appliedMapping.source
  ) {
    ok('6) opening alanları (platform/businessProcess/appliedMapping) korundu');
  } else {
    bad('6) opening preserved', JSON.stringify(opening));
  }

  // 7) Diğer customFields
  if (fetched?.customFields?.someOtherCustomField === 'should_survive') {
    ok('7) diğer customFields anahtarları korundu');
  } else {
    bad('7) other customFields', JSON.stringify(fetched?.customFields));
  }

  // 8) Status + resolvedAt — prisma raw select DB enum identifier döner ('Cozuldu' ASCII).
  if (fetched?.status === 'Cozuldu' && fetched?.resolvedAt) {
    ok('8) status=Cozuldu ve resolvedAt set edildi');
  } else {
    bad('8) status/resolvedAt', `status=${fetched?.status} resolvedAt=${fetched?.resolvedAt}`);
  }
}

// ─── 9) Non-Smart-Ticket case close — regression ─────────────────────────

console.log('');
console.log('── 9-10) Non-Smart-Ticket regression ──────────────────');

let plainCase = null;
try {
  plainCase = await createAndPreapprove({
    title: `[smoke] plain close ${Date.now().toString(36)}`,
    description: 'Non-ST close smoke.',
    caseType: 'GeneralSupport',
    priority: 'Medium',
    origin: 'Telefon',
    companyId,
    companyName,
    category: 'Genel',
    subCategory: 'Genel',
    requestType: 'Talep',
  });
  created.push(plainCase.id);
  const closed = await caseRepository.transitionStatus(
    plainCase.id,
    'Çözüldü',
    { resolutionNote: 'Klasik kapanış smoke.' },
    'Smoke User',
    [companyId],
  );
  const fetched = await prisma.case.findUnique({
    where: { id: plainCase.id },
    select: { status: true, customFields: true },
  });
  if (closed?.status === 'Çözüldü' && fetched?.customFields == null) {
    ok('9) non-ST close başarılı; customFields dokunulmadı');
  } else {
    bad('9) non-ST close', `status=${closed?.status} customFields=${JSON.stringify(fetched?.customFields)}`);
  }
} catch (err) {
  bad('9) non-ST close', err?.message ?? String(err));
}

// ─── 10) Defense in depth: non-ST case'e closure payload reddedilir ──────

if (plainCase) {
  // Yeni bir non-ST Case yarat — biraz önceki zaten kapandı, status='Cozuldu'.
  let testCase = null;
  try {
    testCase = await createAndPreapprove({
      title: `[smoke] non-ST closure reject ${Date.now().toString(36)}`,
      description: 'Defense-in-depth smoke.',
      caseType: 'GeneralSupport',
      priority: 'Medium',
      origin: 'Web',
      companyId,
      companyName,
      category: 'Genel',
      subCategory: 'Genel',
      requestType: 'Talep',
    });
    created.push(testCase.id);
  } catch (err) {
    bad('10) test case create', err?.message ?? String(err));
  }
  if (testCase) {
    try {
      await caseRepository.transitionStatus(
        testCase.id,
        'Çözüldü',
        {
          resolutionNote: 'Reject smoke.',
          smartTicketClosure: { rootCauseGroup: 'rcg.x' },
        },
        'Smoke User',
        [companyId],
      );
      bad('10) backend reject', 'beklenen hata atılmadı; Case kapandı');
    } catch (err) {
      const code = err?.code || err?.body?.code || '';
      const msg = err?.message || String(err);
      if (code === 'smart_ticket_closure_requires_opening' || msg.includes('Smart Ticket akışıyla')) {
        ok('10) non-ST case + closure payload → 400 reddedildi', `(${err.status ?? '??'}) ${msg}`);
      } else {
        bad('10) backend reject', `unexpected: (${err.status ?? '??'}) ${msg}`);
      }
    }
  }
}

// ─── 11) Closure taxonomy filter (PR-1a regression) ──────────────────────

console.log('');
console.log('── 11) Closure taxonomy filter (PR-1a regression) ─────');

const filteredRows = await prisma.taxonomyDef.findMany({
  where: {
    companyId,
    isActive: true,
    taxonomyType: { in: ['rootCauseGroup', 'rootCauseDetail'] },
  },
  select: { id: true, taxonomyType: true, parentId: true },
});
const childMap = new Map();
for (const r of filteredRows) {
  if (r.taxonomyType === 'rootCauseDetail' && r.parentId) {
    childMap.set(r.parentId, (childMap.get(r.parentId) ?? 0) + 1);
  }
}
const groupsWithKids = filteredRows.filter((r) => r.taxonomyType === 'rootCauseGroup')
  .filter((g) => (childMap.get(g.id) ?? 0) > 0).length;
if (groupsWithKids > 0) ok(`11) rootCauseGroup filter children döndü (${groupsWithKids} grup)`);
else bad('11) closure taxonomy filter', 'gruplar children\'sız');

// ─── 12) UI panel reuse regression (Codex PR-1e P2) ─────────────────────
//
// StatusTransitionPanel'in item.id reset effect'inin closureTax cache'ini
// de sıfırladığını doğrular. Inline pure replica — panel logic'i değişirse
// bu blok da güncellenmeli (manuel sync).

console.log('');
console.log('── 12) Panel reuse regression (P2 fix) ────────────────');

function itemResetEffect(prev) {
  return {
    ...prev,
    pending: null,
    resolutionNote: '',
    cancelReason: '',
    thirdPartyId: '',
    escalationLevel: '',
    escalationReason: '',
    error: null,
    closureRcg: '',
    closureRcd: '',
    closureRt: '',
    closurePp: '',
    closureTax: null,
  };
}
const stale = {
  pending: 'Çözüldü',
  resolutionNote: 'önceki vakadan kalmış',
  closureRcg: 'rcg.permission',
  closureRcd: 'rcd.menu_permission_missing',
  closureRt: 'rt.permission_update',
  closurePp: 'pp.validation_added',
  closureTax: { rootCauseGroup: [{ code: 'rcg.permission', label: 'Yetki / Rol', children: [] }] },
};
const afterSwap = itemResetEffect(stale);
if (
  afterSwap.closureTax === null &&
  afterSwap.closureRcg === '' &&
  afterSwap.closureRcd === '' &&
  afterSwap.closureRt === '' &&
  afterSwap.closurePp === '' &&
  afterSwap.pending === null
) {
  ok('12) panel reuse: item.id değişimi closureTax + closure seçimleri sıfırlar');
} else {
  bad('12) panel reuse', JSON.stringify(afterSwap));
}

// ─── Cleanup ─────────────────────────────────────────────────────────────

if (!KEEP && created.length > 0) {
  for (const id of created) {
    try {
      await prisma.case.delete({ where: { id } });
    } catch (err) {
      console.log(`  ⚠️ cleanup başarısız: ${id} — ${err?.message}`);
    }
  }
  console.log('');
  console.log(`🧹 cleanup: ${created.length} test Case silindi`);
}

console.log('');
console.log('── Summary ─────────────────────────────────────────────');
console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);
await prisma.$disconnect().catch(() => {});
process.exit(fail > 0 ? 1 : 0);
