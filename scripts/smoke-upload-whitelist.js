/**
 * smoke-upload-whitelist.js — PR-7 static + behavioral guard.
 *
 * Çalıştır:
 *   node scripts/smoke-upload-whitelist.js
 *
 * Business review Madde 6 — Dosya upload MIME + uzantı whitelist.
 *
 * Korunan invariant'lar:
 *   - server/lib/uploadWhitelist.js export ediyor (MIME + ext + isAcceptedUpload)
 *   - src/features/cases/uploadWhitelist.ts mirror (sync)
 *   - XML explicit kabul (application/xml, text/xml, .xml)
 *   - Executable/script reddedilir (.exe, .sh, .bat, etc.)
 *   - caseRepository.requestUpload whitelist check
 *   - caseRepository.finalizeUpload defense-in-depth re-check
 *   - finalize route 400 döner
 *   - Smart Ticket pickFiles pre-validation
 *   - Eski yüklenmiş dosyalar etkilenmez (yalnız yeni upload check)
 *   - isAcceptedUpload davranış (behavioral) testler
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAcceptedUpload as srvIsAccepted, UPLOAD_ALLOWED_MIME_TYPES as SRV_MIME, UPLOAD_ALLOWED_EXTENSIONS as SRV_EXT } from '../server/lib/uploadWhitelist.js';

const ROOT = resolve(import.meta.dirname, '..');
const SRV = resolve(ROOT, 'server/lib/uploadWhitelist.js');
const FE = resolve(ROOT, 'src/features/cases/uploadWhitelist.ts');
const REPO = resolve(ROOT, 'server/db/caseRepository.js');
const ROUTE = resolve(ROOT, 'server/routes/cases.js');
const STPAGE = resolve(ROOT, 'src/features/smart-ticket/SmartTicketNewPage.tsx');

let pass = 0;
let fail = 0;
function ok(name, detail = '') { pass += 1; console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail = '') { fail += 1; console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`); }

for (const p of [SRV, FE, REPO, ROUTE, STPAGE]) {
  if (!existsSync(p)) { bad(`${p} YOK`); process.exit(1); }
}
const fe = readFileSync(FE, 'utf8');
const repo = readFileSync(REPO, 'utf8');
const route = readFileSync(ROUTE, 'utf8');
const stPage = readFileSync(STPAGE, 'utf8');

// ─── Behavioral tests (server module direkt çağrılır) ─────────────

// 1) XML explicit kabul.
if (srvIsAccepted('application/xml', 'invoice.xml') && srvIsAccepted('text/xml', 'doc.xml')) {
  ok('1) XML explicit kabul (application/xml + text/xml)');
} else {
  bad('1) XML kabul edilmiyor');
}

// 2) Tek başına .xml uzantısı (mime boş) kabul.
if (srvIsAccepted('', 'data.xml') && srvIsAccepted(undefined, 'config.xml')) {
  ok('2) .xml uzantısı kabul (mime boş olsa bile)');
} else {
  bad('2) .xml uzantısı reddediliyor');
}

// 3) PDF, görsel, Office, ZIP kabul.
const acceptedCases = [
  ['application/pdf', 'report.pdf'],
  ['image/png', 'screen.png'],
  ['image/jpeg', 'photo.jpg'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx'],
  ['application/zip', 'pack.zip'],
  ['text/plain', 'log.txt'],
  ['text/csv', 'data.csv'],
  ['application/json', 'config.json'],
];
const allAccept = acceptedCases.every(([m, n]) => srvIsAccepted(m, n));
if (allAccept) {
  ok('3) PDF / görsel / Office / ZIP / metin tipleri kabul');
} else {
  const reject = acceptedCases.filter(([m, n]) => !srvIsAccepted(m, n));
  bad('3) Beklenenlerin bazıları reddedildi', reject.map(([m, n]) => `${n}/${m}`).join(' '));
}

// 4) Executable/script reddedilir.
const rejectedCases = [
  ['application/x-msdownload', 'malware.exe'],
  ['application/x-sh', 'script.sh'],
  ['application/x-bat', 'evil.bat'],
  ['', 'attack.ps1'],
  ['', 'shell.cmd'],
  ['application/x-msi', 'installer.msi'],
  ['', 'thing.scr'],
  ['', 'doc.php'],
  ['', 'macro.vbs'],
];
const allReject = rejectedCases.every(([m, n]) => !srvIsAccepted(m, n));
if (allReject) {
  ok('4) Executable/script tipleri reddedilir');
} else {
  const accept = rejectedCases.filter(([m, n]) => srvIsAccepted(m, n));
  bad('4) Bazı executable/script tipleri kabul edildi', accept.map(([m, n]) => n).join(' '));
}

// 4b) Codex P2 (PR #468 review) — forge önleme: dangerous uzantı +
//     kabul edilebilir MIME birlikte gelirse REDDETMELI.
//     Eski impl: mimeOk || extOk → kabul (BUG).
//     Yeni impl: ikisi de varsa İKİSİ DE listede olmalı.
const forgeCases = [
  ['application/pdf', 'malware.exe'],
  ['image/png', 'shell.sh'],
  ['text/plain', 'evil.bat'],
  ['application/json', 'macro.vbs'],
];
const allForgeReject = forgeCases.every(([m, n]) => !srvIsAccepted(m, n));
if (allForgeReject) {
  ok('4b) Codex P2 (#468) — forge bypass kapalı (allowed MIME + dangerous ext = reject)');
} else {
  const accept = forgeCases.filter(([m, n]) => srvIsAccepted(m, n));
  bad('4b) Forge bypass açık', accept.map(([m, n]) => `${n}/${m}`).join(' '));
}

// 4c) Tarayıcı tutarsızlığı tolerant: boş MIME + kabul edilebilir uzantı
//     hala çalışmalı (xlsx Safari'da boş MIME).
if (
  srvIsAccepted('', 'data.xlsx') &&
  srvIsAccepted(undefined, 'report.pdf')
) {
  ok('4c) Boş MIME + kabul uzantı tolerant (Safari xlsx vb.)');
} else {
  bad('4c) Boş MIME + kabul uzantı reddediliyor (tolerantlık kayboldu)');
}

// 4d) Codex P2 (PR #470 review) — application/octet-stream substitute
//     (caseService.addFile boş File.type için bunu gönderir).
//     octet-stream'i "MIME yok" gibi davranıp uzantı yolu çalışmalı.
//     Aksi halde Safari/Office xlsx upload'ı kırılırdı.
const octetCases = [
  ['application/octet-stream', 'sheet.xlsx'],
  ['application/octet-stream', 'doc.docx'],
  ['application/octet-stream', 'report.pdf'],
  ['application/octet-stream', 'image.png'],
];
const allOctetOk = octetCases.every(([m, n]) => srvIsAccepted(m, n));
if (allOctetOk) {
  ok('4d) octet-stream substitute + kabul uzantı kabul (Safari/Office xlsx fix)');
} else {
  const reject = octetCases.filter(([m, n]) => !srvIsAccepted(m, n));
  bad('4d) octet-stream bypass çalışmıyor', reject.map(([, n]) => n).join(' '));
}

// 4e) octet-stream + dangerous uzantı reddedilmeli (octet-stream "yok"
//     anlamına gelse de uzantı yolu sıkı).
if (
  !srvIsAccepted('application/octet-stream', 'malware.exe') &&
  !srvIsAccepted('application/octet-stream', 'shell.sh')
) {
  ok('4e) octet-stream + dangerous uzantı reddedilir (sıkı uzantı kuralı)');
} else {
  bad('4e) octet-stream + dangerous uzantı kabul edildi (yanlış)');
}

// 5) Boş mime + bilinmeyen uzantı reddedilir.
if (!srvIsAccepted('', 'unknown.xyz') && !srvIsAccepted(undefined, 'noext')) {
  ok('5) Boş/bilinmeyen mime + uzantı reddedilir (deny-by-default)');
} else {
  bad('5) Deny-by-default ihlal');
}

// ─── Sync check (backend + frontend list senkron) ─────────────────

// 6) Frontend mirror MIME listesi sync.
const feMimeMatch = fe.match(/UPLOAD_ALLOWED_MIME_TYPES\s*=\s*\[([\s\S]*?)\]/);
if (!feMimeMatch) {
  bad('6) Frontend MIME export bulunamadı');
} else {
  const feMimes = (feMimeMatch[1].match(/['"]([^'"]+)['"]/g) ?? []).map((s) => s.slice(1, -1));
  const srvSet = new Set(SRV_MIME);
  const feSet = new Set(feMimes);
  const missing = [...srvSet].filter((m) => !feSet.has(m));
  const extra = [...feSet].filter((m) => !srvSet.has(m));
  if (missing.length === 0 && extra.length === 0) {
    ok(`6) Frontend MIME listesi backend ile senkron (${SRV_MIME.length} entry)`);
  } else {
    bad('6) MIME senkron değil', `missing=${missing.join(',')} extra=${extra.join(',')}`);
  }
}

// 7) Frontend mirror uzantı listesi sync.
const feExtMatch = fe.match(/UPLOAD_ALLOWED_EXTENSIONS\s*=\s*\[([\s\S]*?)\]/);
if (!feExtMatch) {
  bad('7) Frontend ext export bulunamadı');
} else {
  const feExts = (feExtMatch[1].match(/['"]([^'"]+)['"]/g) ?? []).map((s) => s.slice(1, -1));
  const srvSet = new Set(SRV_EXT);
  const feSet = new Set(feExts);
  const missing = [...srvSet].filter((m) => !feSet.has(m));
  const extra = [...feSet].filter((m) => !srvSet.has(m));
  if (missing.length === 0 && extra.length === 0) {
    ok(`7) Frontend uzantı listesi backend ile senkron (${SRV_EXT.length} entry)`);
  } else {
    bad('7) Uzantı senkron değil', `missing=${missing.join(',')} extra=${extra.join(',')}`);
  }
}

// ─── Integration checks ──────────────────────────────────────────

// 8) caseRepository requestUpload isAcceptedUpload çağrısı.
if (
  /async requestUpload[\s\S]{0,1500}?isAcceptedUpload\(input\.mimeType,\s*input\.fileName\)/.test(repo)
) {
  ok('8) requestUpload whitelist check (isAcceptedUpload çağrılıyor)');
} else {
  bad('8) requestUpload whitelist check eksik');
}

// 9) caseRepository finalizeUpload defense-in-depth re-check.
if (
  /async finalizeUpload[\s\S]{0,800}?isAcceptedUpload\(input\.mimeType,\s*input\.fileName\)/.test(repo)
) {
  ok('9) finalizeUpload defense-in-depth re-check');
} else {
  bad('9) finalizeUpload re-check eksik');
}

// 10) finalize route 400 dönüyor.
if (
  /files\/finalize[\s\S]{0,1000}?if\s*\(['"]error['"]\s+in\s+result\)\s*return\s+res\.status\(400\)/.test(route)
) {
  ok('10) finalize route MIME mismatch 400 döner');
} else {
  bad('10) finalize route 400 mapping eksik');
}

// 11) Smart Ticket handlePickFiles isAcceptedUpload pre-validation.
if (
  /function handlePickFiles[\s\S]{0,1200}?!isAcceptedUpload\(f\.type,\s*f\.name\)/.test(stPage)
) {
  ok('11) Smart Ticket handlePickFiles pre-validation (UX)');
} else {
  bad('11) Smart Ticket pre-validation eksik');
}

// 12) Eski upload akışları (caseRepository) dokunulmadı — getDownloadUrl
//     ve removeFile imzaları intact, yalnız upload path'i değişti.
if (
  /async getDownloadUrl\(caseId,\s*fileId,\s*allowedCompanyIds\)/.test(repo) &&
  /async removeFile\(id,\s*fileId,\s*actor/.test(repo)
) {
  ok('12) getDownloadUrl + removeFile imzaları dokunulmadı (eski dosyalar etkilenmez)');
} else {
  bad('12) Eski upload metotları değişmiş');
}

// 13) Bilgi amaçlı: XML kabul listesinde, içerik parse YOK (kodda XML
//     parse çağrısı YOK — XXE/SSRF riski sıfır).
if (
  !/parseXml|xml2js|fast-xml-parser|DOMParser/.test(repo) &&
  !/parseXml|xml2js|fast-xml-parser|DOMParser/.test(readFileSync(SRV, 'utf8'))
) {
  ok('13) Backend XML parse YOK (XXE/SSRF riski sıfır)');
} else {
  bad('13) Backend XML parse referansı tespit edildi');
}

console.log('');
console.log('── Summary ─────────────────────────────────────────────');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
