/**
 * Upload MIME + extension whitelist (PR-7).
 *
 * Business review Madde 6 — Dosta XML upload kontrolü.
 *
 * Yaklaşım: deny-by-default. Kabul edilen MIME ve uzantı listesinde
 * en az biri eşleşmezse reddedilir. Çift kanal (MIME OR extension)
 * tarayıcı uyumsuzlukları için tolerant — örneğin Safari .xlsx için
 * bazen boş MIME döner, uzantıdan yakalanır.
 *
 * Kabul listesi:
 *   - Belge: PDF, Word, Excel, PowerPoint
 *   - Görsel: PNG, JPEG, GIF, WebP, SVG
 *   - Metin: TXT, CSV, JSON, XML
 *   - Arşiv: ZIP
 *
 * Yasaklı (deny-by-default zaten reddeder, explicit liste bilgi amaçlı):
 *   - Executable: .exe, .sh, .bat, .cmd, .ps1, .com, .scr, .msi, .dmg
 *   - Script: .js (raw upload), .php, .py, .rb, .pl, .vbs
 *   - Diğer: application/x-* (binary executables)
 *
 * **Önemli güvenlik notu:** Bu whitelist yalnız MIME/extension kontrolü
 * yapar; içerik (magic bytes) doğrulama YOK. Backend dosyaları PARSE
 * ETMEZ; XML için XXE/SSRF riski sıfır kalır. Bu kontrat değişirse
 * (örn. XML parse eden bir akış eklenirse) güvenlik incelemesi şart.
 *
 * Eski yüklenmiş dosyalar bu validasyondan etkilenmez (yalnız yeni
 * upload check). Mevcut limitler (CASE_FILE_MAX_COUNT=20,
 * CASE_FILE_MAX_SIZE=25MB) bu modüle dahil değil; caseRepository
 * tarafında ayrıca check edilir.
 */

export const UPLOAD_ALLOWED_MIME_TYPES = [
  // Belge
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Görsel
  'image/png',
  'image/jpeg',
  'image/jpg', // bazı sistemler bunu döner (technically alias)
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Metin
  'text/plain',
  'text/csv',
  'application/csv',
  'application/json',
  // XML — Business review Madde 6 explicit kabul
  'application/xml',
  'text/xml',
  // Arşiv
  'application/zip',
  'application/x-zip-compressed',
];

export const UPLOAD_ALLOWED_EXTENSIONS = [
  // Belge
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Görsel
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  // Metin
  '.txt', '.csv', '.json',
  // XML — Business review Madde 6 explicit kabul
  '.xml',
  // Arşiv
  '.zip',
];

/**
 * Codex P2 (PR #468 review) — sıkı kural: MIME ve uzantı ikisi de
 * varsa İKİSİ DE kabul listesinde olmalı. Aksi halde forge edilebilir
 * pattern (örn. `malware.exe` + `application/pdf`) bypass yapardı.
 *
 *   - Sadece MIME var (uzantı yok) → MIME listede ise kabul
 *   - Sadece uzantı var (MIME yok/bilinmeyen) → uzantı listede ise kabul
 *     (tarayıcı tutarsızlığına tolerant; örn. Safari xlsx için boş MIME)
 *   - İkisi de var → ikisi de listede olmalı
 *   - İkisi de yok → reject
 */
export function isAcceptedUpload(mimeType, fileName) {
  const mimeRaw = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  const name = typeof fileName === 'string' ? fileName.toLowerCase() : '';
  const dotIdx = name.lastIndexOf('.');
  const ext = dotIdx >= 0 ? name.slice(dotIdx) : '';

  // Codex P2 (PR #470 review) — caseService.addFile boş File.type için
  // 'application/octet-stream' substitute ediyor (Safari/Office xlsx
  // senaryosu). Bu fallback MIME'i listede değil; sıkı `mimeOk && extOk`
  // kuralı kabul edilebilir .xlsx/.docx uzantılarını da reddediyordu.
  // Çözüm: octet-stream'i "MIME bilinmiyor" olarak davran → uzantı yine
  // tek kanal olarak çalışır (Safari xlsx, vb. tolerantlık korunur).
  // Bu güvenliği azaltmaz çünkü octet-stream zaten generic, content
  // signal değil.
  const mime = mimeRaw === 'application/octet-stream' ? '' : mimeRaw;

  const hasMime = mime.length > 0;
  const hasExt = ext.length > 0;
  const mimeOk = hasMime && UPLOAD_ALLOWED_MIME_TYPES.includes(mime);
  const extOk = hasExt && UPLOAD_ALLOWED_EXTENSIONS.includes(ext);

  if (hasMime && hasExt) {
    // İkisi de sağlandıysa ikisi de listede olmalı (forge önleme).
    return mimeOk && extOk;
  }
  if (hasMime) return mimeOk;
  if (hasExt) return extOk;
  return false;
}
