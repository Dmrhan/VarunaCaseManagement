# Test Scenarios

Bu doküman PM, QA ve geliştiricilerin Varuna Case Management'i manuel test
ederken kullanabileceği yapılandırılmış senaryoları içerir. Her senaryo bir
**persona** ile başlar, **adımları** sıralar ve **beklenen davranışı** açıklar.

> Bu liste pre-prod (dev) ve smoke regresyon testleri için referanstır. Hatalar
> bulunursa `docs/INCIDENTS.md`'e ekleyin; bulgular `docs/ROADMAP.md` veya
> `docs/TECHNICAL_DEBT.md`'ye düşer.

## Demo Personalar

Demo seed (`npm run db:seed:auth` — yalnızca local) aşağıdaki kullanıcıları
oluşturur. Production'da bu seed çalıştırılmaz; PM testleri için ayrı bir
demo Supabase project tercih edilir.

| Email | Rol | Şirket(ler) | Senaryolarda kullanım |
| --- | --- | --- | --- |
| `agent@varuna.dev` | Agent | PARAM | Frontline; vaka açar, not yazar, transfer eder |
| `backoffice@varuna.dev` | Backoffice | PARAM | Operatif çözüm; vakaya yanıt yazar |
| `supervisor@varuna.dev` | Supervisor | PARAM + UNIVERA | İzleyici atama, AI raporu, multi-tenant |
| `csm@varuna.dev` | CSM | PARAM | Müşteri temaslı senaryolar |
| `admin@varuna.dev` | Admin | PARAM + UNIVERA + FINROTA | Yönetim ekranları, tenant kontrolü |
| `sysadmin@varuna.dev` | SystemAdmin | Tüm şirketler | Platform yapılandırma, FieldDefinitions |

Demo şifreleri `prisma/seedAuth.ts` ile set edilir (varsayılan: `demo1234`).

---

## Senaryo Verisi (Scenario Seed)

Aşağıdaki senaryoları kolayca test etmek için **idempotent** bir seed
script eklendi:

```bash
npm run db:seed:scenarios
```

> ⚠️ **Yalnızca local/demo/sandbox** DB'de çalıştırın. Production'da **asla**
> kullanmayın — gerçek müşteri verisi etkilenir.

**Üretilen demo veriler** (stable ID + caseNumber — tekrar çalıştırıldığında
çoğaltma yapmaz):

### Şirketler ve domain'ler

| Şirket | Domain | Tipik müşteriler |
| --- | --- | --- |
| **Univera** | Enterprise FMCG yazılım (Enroute, Quest, Stokbar) | FMCG distribütörleri, saha satış, soğuk zincir |
| **Finrota** | SMB finans & üretkenlik (Netahsilat, Netekstre, Posrapor, E-DBS, NAP360, TOS) | Mali müşavirler, KOBİ finans/muhasebe, bayi tahsilat |
| **PARAM** | Fintech / ödeme (Fiziki POS, Sanal POS, BKM) | Marketler, online mağazalar, restoran zincirleri |

### Demo müşteriler

**Univera** (DEMO-ACC-UNI-*): Akar Gıda Dağıtım A.Ş., Doğa Lojistik Saha Satış, Mavi Soğuk Zincir Ltd., Anadolu Distribütörler Birliği

**Finrota** (DEMO-ACC-FIN-*): Kemal Mali Müşavirlik, Atlas Pazarlama Tic. Ltd., Yıldız Eczanesi, Doğu Otomotiv Bayi

**PARAM** (DEMO-ACC-PAR-*): Sancaktepe Market Zinciri, GnG Online Mağaza, İstanbul Restoranlar Bayi Grubu, Anadolu Bankamatik Hizmetleri

**Multi-tenant izolasyon testi** (DEMO-ACC-MT-*): "Multi-Tenant Test Müşterisi" — aynı isimle her 3 şirkette de mevcut; cross-tenant sızıntı testi için.

### Demo vakalar — caseNumber'lar stable

#### Univera

| caseNumber | Başlık | Durum | Senaryo |
| --- | --- | --- | --- |
| `DEMO-UNI-001` | Enroute rota sahaya yansımıyor | Açık | **Watcher flow** — Supervisor Agent'ı izleyici yapar |
| `DEMO-UNI-002` | Stokbar depo/mobil uyuşmazlığı | Eskalasyon + SLA ihlali | **Customer Pulse** (Kritik sinyal) |
| `DEMO-UNI-003` | Quest ziyaret planı yüklenmiyor | Açık | **Note Reply + Reaction** (1 parent + 2 reply + 2 reaction) |
| `DEMO-UNI-PARENT-001` | Ülke geneli FMCG rota kesintisi | İncelemede / Kritik | **Linked Parent** (2 child) |
| `DEMO-UNI-CHILD-001` | Marmara bölgesi rota — child | Açık | Parent: DEMO-UNI-PARENT-001 |
| `DEMO-UNI-CHILD-002` | Ege bölgesi rota gecikmesi — child | Açık | Parent: DEMO-UNI-PARENT-001 |

#### Finrota

| caseNumber | Başlık | Durum | Senaryo |
| --- | --- | --- | --- |
| `DEMO-FIN-001` | Netahsilat: bayi tahsilatı yansımıyor | Açık | **Reaction** + parent note + reply |
| `DEMO-FIN-002` | Netekstre: banka hareketi eksik | Açık + SLA ihlali | **Customer Pulse** (Kemal Mali Müşavirlik geçmişi) |
| `DEMO-FIN-003` | Posrapor: gün sonu mutabakat farkı | Çözüldü | Customer Pulse — resolved |
| `DEMO-FIN-004` | E-DBS banka cevabı gecikti | 3rdPartyBekleniyor | Customer Pulse — 3rd party wait |
| `DEMO-FIN-005` | NAP360 nakit akışı veri eksik | Kritik + Direktör eskalasyon | Customer Pulse — kritik vaka |

#### PARAM

| caseNumber | Başlık | Durum | Senaryo |
| --- | --- | --- | --- |
| `DEMO-PAR-001` | POS "Bilinmeyen Hata" | Açık | **Watcher** (Supervisor + CSM izliyor) |
| `DEMO-PAR-002` | BKM gün sonu eksik işlem | Eskalasyon + Direktör | **AI Status Report** (zengin activity timeline: oluşturma → atama → öncelik → statü → not → 3rd party → eskalasyon → transfer) |
| `DEMO-PAR-DUP-A` | Sanal POS settlement gecikmesi | Açık | **Linked Duplicate** (symmetric) |
| `DEMO-PAR-DUP-B` | Sanal POS settlement — 2. başvuru | Açık | Linked Duplicate'ın diğer ucu |

#### Multi-Tenant Izolasyon Testi

| caseNumber | Şirket | accountId | Beklenti |
| --- | --- | --- | --- |
| `DEMO-MT-UNI` | UNIVERA | DEMO-ACC-MT-UNI | A şirketi kullanıcısı sadece kendi şirketinin vakasını görür |
| `DEMO-MT-FIN` | FINROTA | DEMO-ACC-MT-FIN | Cross-tenant erişim 404 / 403 dönmeli |
| `DEMO-MT-PAR` | PARAM | DEMO-ACC-MT-PAR | Aynı isim üç şirkette — UI'da karışmamalı |

### Hızlı test akışları

**Watcher + Notification**: Supervisor login → `DEMO-PAR-001` vaka detayı → CSM ve Supervisor watcher listesinde görünür → Agent login (varsa) → not eklendiğinde **bell badge** artar.

**Linked Cases**: Supervisor login → `DEMO-UNI-PARENT-001` Bağlantılar sekmesinde 2 child görünür. `DEMO-PAR-DUP-A` Duplicate açar → `DEMO-PAR-DUP-B`'de de aynı bağlantı görünür (symmetric).

**Note Reply + Reaction**: Agent login → `DEMO-UNI-003` Notlar sekmesinde 1 parent + 2 reply + 2 reaction; "X yanıt" linki açılır.

**AI Status Report**: Supervisor login → `DEMO-PAR-002` Detay > "Durum Raporu Oluştur" → AI mail-ready rapor üretir (zengin timeline'dan).

**Customer Pulse — Case Detail**: Agent login → `DEMO-FIN-002` Detay → sağda "Müşteri Durumu" Kemal Mali Müşavirlik için **Riskli/Kritik** badge + birkaç metric chip.

**Customer Pulse — New Case Flow**: Agent login → "Yeni Vaka" → Şirket: FINROTA, Müşteri: Kemal Mali Müşavirlik → Aİ panelinde Customer Pulse otomatik gelir (deterministic).

**Multi-Tenant Izolasyon**: PARAM-only Agent → `/cases/DEMO-MT-UNI` URL'i ile gitmeye çalış → 403/404. Bootstrap'ta product group dropdown başka şirket değeri göstermez.

---

## 1. Vaka Yaşam Döngüsü (Smoke)

**Persona:** Agent (`agent@varuna.dev`)

1. Login → Vakalar listesinde PARAM şirketinin vakaları görünür (başka şirket sızıntısı yok).
2. "Yeni Vaka" → müşteri ara, kategori seç, ürün grubu dropdown'ında sadece PARAM ürünleri.
3. Açıklamayı 10 karakter altı gir → AI başlık önerisi tetiklenmemeli; üstüne çık → öneri gelir (AI key varsa).
4. Vaka oluştur → Detay ekranı; SLA sayaçları aktif.
5. Statü değiştir (Açık → Üzerinde Çalışılıyor) → activity feed satırı düşer.
6. Öncelik değiştir → activity feed + watcher'a bildirim (varsa).
7. Çözüm taslağı isteme → AI yanıtı veya 503/timeout sonucu graceful fallback.

**Beklenen:** Her adım toast + activity feed. Hatalı senaryoda kullanıcı dostu mesaj görür, sayfa kırılmaz.

---

## 2. Notlar — Reply Thread + Reaction

**Personalar:** Agent ve Supervisor (iki sekmede)

1. **Agent:** Bir vakanın **Notlar** sekmesinde yeni not yazar (İç Not).
2. **Supervisor:** Aynı vakayı açar → not görünür.
3. **Supervisor:** Notun altındaki **↩ Yanıtla** → composer açılır → kısa yanıt + Gönder.
4. **Agent:** "X yanıt" rozeti tıkla → thread açılır, Supervisor yanıtını görür.
5. **Agent:** Aynı yanıt için **Yanıtla butonu yok** (max 1 derinlik).
6. **Agent:** Notun altında 😊+ butonu → 👍 → chip "👍 1" + highlight (mine).
7. **Supervisor:** Aynı nota 👀 → chip "👀 1" görünür; **Agent:** 60 saniye içinde bell'de "X notunuza 👀 tepkisi verdi" bildirimi.
8. **Agent:** Kendi 👍'ına tekrar tıkla → chip kaybolur (toggle off), **bildirim üretilmez** (removal).

**Beklenen:** Thread + reactions sorunsuz; bildirim sahibe gider, reactor kendine bildirim almaz.

---

## 3. Watcher + Bildirimler

**Personalar:** Supervisor + Agent + 2. Agent (varsa)

1. **Supervisor:** Bir PARAM vakasını aç → Sağ panelde **İzleyiciler** kartı → +  Agent'ı ekle.
2. **Agent:** O vakayı aç → kendisi izleyici listesinde görünür.
3. **2. Agent (Supervisor):** Aynı vakaya **not** ekle.
4. **Agent:** Bell badge artar; drawer'da "X vakasında yeni not" satırı (60 saniye polling içinde).
5. **Supervisor:** Vakayı başka takıma transfer et → izleyicilere "vaka aktarıldı" bildirimi.
6. **Agent:** Drawer'ı aç → görünen notification'lar otomatik seen yapılır → ikinci açışta listede kalır ama tekrar açınca count 0.

**Beklenen:** Bell badge tutarlı; bildirim mesajları doğru (`payload.message`). Aktör kendine de bildirim alır (gürültü kabul, spec gereği).

---

## 4. Linked Cases (Bağlantılı Vakalar)

**Persona:** Supervisor

1. Bir vakanın **Bağlantılar** sekmesi → RUNA AI öneri kartı yüklenir (max 3 aday).
2. AI önerilerinden birini tıkla → Related/Parent/Duplicate seçimi → ekle.
3. Hedef vakayı aç → Bağlantılar sekmesinde **simetrik** Duplicate görünür.
4. **Manuel ekle:** "Vaka Bağla" modal → vaka ara → Related ekle.
5. Bağlantıyı kaldır → her iki uçta da kalkar (Duplicate symmetric remove).
6. Aynı vakaya kendisini bağlamayı dene → **self_link** hatası.
7. Farklı şirketteki vakaya bağlamayı dene → **cross_tenant** reddedilir.
8. A → B Parent zaten varsa B → A Parent ekleme → **circular** reddedilir.

**Beklenen:** Tüm hata yolları kullanıcı dostu mesaj; AI fail durumunda "AI önerisi alınamadı" amber satır.

---

## 5. AI — Durum Raporu (Status Report)

**Persona:** Supervisor

1. Vaka detay header'ında **Durum Raporu Oluştur** butonu → modal açılır → AI yanıtı bekler.
2. AI başarılı → mail-ready format prose halinde rapor, kopyalanabilir.
3. AI fail (sim. OPENAI_API_KEY rotate edilmiş) → kullanıcıya 503 + "AI servisi yapılandırılmamış" toast.
4. Çok uzun açıklama (10K+ char) → 400 input_too_large; OpenAI çağrısı yapılmaz.

**Beklenen:** Hata durumlarında modal hang değil; net toast.

---

## 6. AI — Customer Pulse (Müşteri Durumu)

**Persona:** Agent

1. Vaka detay açıldığında sağ alt panelde "Müşteri Durumu" otomatik yüklenir (deterministic önce).
2. AI özet upgrade arka planda gelir → metin AI versiyonu ile değişir, "RUNA AI özet" violet rozet.
3. AI fail → metin deterministic kalır + amber **"Standart özet (AI önerisi alınamadı)"** rozet.
4. Repeated issues + son 30 gün vakaları + SLA ihlal metrikleri görünür.
5. Pulse state badge (Stable/Watch/Risky/Critical) doğru renk + dot.

**Beklenen:** Kullanıcı her zaman gerçek pulse verisini görür; AI olsa da olmasa da rozet net.

---

## 7. AI — Suggest Links

**Persona:** Agent

1. Vakanın Bağlantılar sekmesi → AI kart "Analiz ediliyor…" → öneri listesi.
2. Yenile butonu → tekrar analiz; aria-label "Benzer vakaları yeniden analiz et".
3. Aday yoksa "Önerilecek benzer vaka bulunamadı".
4. AI fail → amber **"AI önerisi alınamadı"** + ShieldAlert ikon.

**Beklenen:** Boş ↔ fail farkı net.

---

## 8. Multi-Tenant Izolasyon

**Personalar:** Admin (PARAM + UNIVERA) ve PARAM-only Agent

1. **Admin:** PARAM şirketi seçili → vakalar PARAM. UNIVERA seçimine geç → UNIVERA vakaları.
2. **Agent:** Sadece PARAM görür; URL ile UNIVERA case id'sine git → 403 / 404.
3. **Yeni vaka açarken** ürün grubu dropdown → sadece o şirketin distinct grupları (P0.2 fix sonrası).
4. **AI suggest-links:** Sadece aynı şirketin son 30 gün vakaları (cross-tenant aday yok).
5. **Mention dropdown:** Vaka şirketinde aktif kullanıcılar (cross-tenant @ ile başkasını etiketleme reddedilir).
6. **Watcher / Linked Case ekle:** Hedef başka şirket → reddedilir.

**Beklenen:** Hiçbir liste / autocomplete / AI çıktısı cross-tenant data sızdırmaz.

---

## 9. Bell Badge — Mention + Notification Birleşik Feed

**Persona:** Supervisor

1. Login → Bell sayacı (mention + generic notification toplamı).
2. Drawer aç → en yeni en üstte; mention satırı `@` ikonu, reaction satırı 😊 ikonu, watcher satırı 👁 ikonu.
3. Mention satırı tıkla → vakaya gidilir, o vakadaki mention'lar seen yapılır.
4. Notification satırı tıkla → vakaya gidilir.
5. Drawer açıldıktan sonra kapan → generic notification'lar seen (mention seen ayrı flow).

**Beklenen:** Mention + notification ayrı kanal ama tek UI; sayaç tutarlı.

---

## 10. Dark Mode Smoke

**Persona:** Her rol

1. Sistem dark mode → tüm sayfalarda beyaz kutu kalmamalı:
   - Header, tab nav, sağ panel kartları (RUNA AI, QA Score, Watchers, Links, Customer Pulse)
   - Bağlantılar modal'ı seçenek butonları + checklist
   - Notlar, replies, reaction chip ve picker'ı
   - Bell drawer içeriği
   - CasesList page başlığı
2. Mention dropdown error → kırmızı styled (light + dark).
3. AI fail rozetleri → amber renk (light + dark).

**Beklenen:** Tek bir hardcoded `bg-white` veya `text-slate-900` (dark variant'sız) yüzeyde okunmaz alan yok.

---

## 11. Activity Feed — Tüm Aksiyonlar

**Persona:** Agent

1. Yeni not, çağrı, atama değişikliği, statü değişimi, reply, transfer, file upload — her biri activity feed'de **Türkçe** mesaj.
2. Filtreler: tümü / not / çağrı / statü / atama.
3. AI metadata field updates feed'i kirletmemeli (örn. `aiCategorySuggestion` field).

**Beklenen:** Feed temiz + okunabilir + filtreler doğru çalışır.

---

## Bilinen Kısıtlamalar (Test Beklentisi)

Aşağıdakiler şu an **uygulanmamış** veya **kısmi**; bu senaryolarda test etmeyin:

- **E-posta bildirimi**: Hiçbir notification e-posta göndermez. `channel='InApp'` only. (Faz 2 §6 kapsamında planlandı.)
- ~~**Watcher Inbox UI**~~: **Eklendi** (Phase 5c). Sidebar > Çalışma Alanım > İzleyici Inbox; izlenen vakalar + son bildirimler tek sayfada, statü/zaman filtreleri ile.
- ~~**CasesList link count indicator**~~: **Eklendi** (Phase 5b). Başlık yanında violet `🔗 N` chip görünür.
- ~~**CaseNotification cleanup**~~: **Eklendi** (Phase 5a). `POST /api/cron/notification-cleanup` 30g+ okunmuş satırları siler. Eski Vercel cron GitHub Actions schedule'ı kapalıdır; `.github/workflows/notification-cleanup.yml` yalnızca manuel `workflow_dispatch` ile çalışır. On-prem otomasyon kurulacaksa günlük 03:00 UTC cadence'i kurum içi scheduler'a taşınmalıdır.
- **Eski notlara reaksiyon bildirimi**: PR #68 öncesi yazılmış notlar `authorId` taşımıyor; reaksiyon eklenirse bildirim üretilmez (sessiz fallback). Yeni notlar test edin.
- **OpenAI rate-limit (429)**: Gerçek trafikte test edilemez; kod yolu statik review ile kabul edildi.
- **Mobile responsive**: Telefon emülasyonuyla genel akış test edilebilir ama "mobile-first" tasarım hedefi değil.

---

## Yeni Senaryo Eklerken

- Persona ile başla (rol + şirket).
- Adımları numaralı sırada yaz; her adım gözlemlenebilir bir aksiyon olsun.
- "Beklenen:" satırını mutlaka yaz.
- Negatif (hata) durumlarını da test et.
- Hata bulunursa `docs/INCIDENTS.md`'e tarihli kayıt düş.
