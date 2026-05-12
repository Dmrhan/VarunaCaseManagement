# Roadmap

Bu doküman önerilen ve planlanan ürün özelliklerini takip eder. Her madde
durum etiketi (Proposed / Planned / In Progress / Shipped) ile birlikte yazılır.

PRODUCT_SPEC.md mevcut ürün davranışını tanımlar. ROADMAP.md gelecek
özellikleri ve onlara nasıl yaklaşılacağını tanımlar. Çelişki olursa
PRODUCT_SPEC.md öncelikli kabul edilir — bir özellik shipped olunca buraya
ekleniyor demektir.

**Status etiketleri:**
- **Proposed** — fikir aşamasında, tasarım/karar bekliyor
- **Planned** — onaylanmış, sprintliği bekliyor
- **In Progress** — aktif geliştirme
- **Shipped** — production'da, PRODUCT_SPEC.md'ye taşınmaya hazır

---

## Customer Context Intelligence

**Priority:** High
**Status:** Shipped (Case Detail + New Case Flow)
**Source:** General Manager feedback (Mayıs 2026 sunumu)

**Shipped phases:**
- Phase 1 — Backend deterministic endpoint: `GET /api/cases/:id/customer-pulse`
- Phase 2 — Frontend service: `caseService.getCustomerPulse(caseId)`
- Phase 3 — UI panel: "Müşteri Durumu" inside `LeftPanel` of `CaseDetailPage` (self-fetching, non-blocking)
- Phase 4 — New case flow integration: `GET /api/cases/accounts/:accountId/customer-pulse?companyId=...` + shared `CustomerPulsePanel` component (account/case discriminated union); replaces the old "Müşteri Geçmişi" mini-card.
- Phase 5 — AI summary upgrade: `POST /api/ai/customer-pulse-summary` (case-based only; account variant deterministic-only since AI route is caseId-bound).

### Goal

Give the agent immediate customer context when opening or creating a case.
The agent should understand *"what kind of customer situation am I walking
into?"* before acting on the case.

### Problem

Agents currently see the case itself, but they also need a quick sense of
the customer's broader state:

- Does this customer have many open cases?
- Has the customer repeatedly contacted us about the same issue?
- Were there recent SLA violations?
- Are there unresolved critical or escalated cases?
- Do recent notes/call logs suggest dissatisfaction?
- Is there churn or retention risk?
- Should the agent handle this customer more carefully or proactively?

### Proposed UX

Add a compact **"Customer Pulse"** panel to the case detail screen and
to the new case flow after company + account selection.

Example panel content:

- Customer state: Stable / Watch / Risky / Critical
- Open cases count
- Recent cases in the last 30/60/90 days
- Repeated categories/subcategories
- SLA violation history
- Critical/escalated case history
- Recent sentiment or customer mood
- AI-generated customer context summary
- Recommended handling approach

Example AI summary:

> "This customer has opened 3 cases in the last 30 days, mostly about
> integration issues. Two recent cases breached SLA and the latest notes
> show dissatisfaction. Proactive communication and supervisor visibility
> are recommended."

### Data sources

- Cases by account
- Open cases
- Historical cases
- Case notes
- Call logs
- Case history/activity
- SLA status and violations
- Churn-specific fields if available
- Existing account/customer data

### AI Output

- Customer mood/risk label: Stable / Watch / Risky / Critical
- 2–3 sentence customer context summary
- Recommended handling approach
- Key evidence behind the recommendation

### Technical notes

- Reuse existing account-based case lookup where possible
  (`caseService.findByAccount`, `caseRepository.findByAccount`).
- Case detail uses `GET /api/cases/:id/customer-pulse`.
- New case flow uses `GET /api/cases/accounts/:accountId/customer-pulse?companyId=...`.
- Tenant scope must be respected through `allowedCompanyIds`.
- The feature should not block the case workflow if AI fails.
- If AI is unavailable, show **deterministic metrics only** (counts,
  violations, recent cases) — the panel still has value without AI.
- Avoid sending excessive sensitive data to AI; summarize relevant
  notes/call logs **before** the model call (e.g. last 5 notes, last 3
  calls, only essential fields).
- Log AI usage through the existing `AIUsageLog` mechanism if an AI
  endpoint is added (`endpoint: 'customer-pulse'`).

### Acceptance criteria

- [x] Agent can see customer open case count from the case detail screen
- [x] Agent can see recent historical case context for the selected account
- [x] Agent can see customer context in the new case flow after company + account selection
- [x] System identifies repeated issue categories when present
- [x] System shows SLA/churn/escalation risk signals when present
- [x] AI summary includes **evidence**, not only a vague score
- [x] AI failure does not break the case detail screen
- [x] Customer Pulse respects multi-tenant access control
- [x] Feature is documented in roadmap/product spec before implementation

### Notes

Case Detail and New Case Flow implementations are shipped. The case detail
panel can upgrade deterministic metrics with AI; the new case flow currently
uses deterministic account-level pulse data so case creation remains fast and
non-blocking. Next documentation step: move the shipped behavior into
PRODUCT_SPEC.md, then keep only future enhancements in this roadmap.

---

## Known Limitations (Faz 2 sonrası)

Şu an üretimde olan ama eksikleri olan veya kısmi özellikler. Test eden
ekibe `docs/TEST_SCENARIOS.md` ile birlikte verilir.

### E-posta bildirimi
**Status:** Not implemented
Tüm `CaseNotification` satırları `channel='InApp'` olarak yazılır.
Hiçbir notification e-posta tetiklemez. Faz 2 §6 kapsamında WebSocket /
30sn poll modeline geçildiğinde e-posta opsiyonel kanal olarak eklenebilir.

### Watcher Inbox UI
**Status:** Shipped (Phase 5c)
Yeni sayfa: sidebar > Çalışma Alanım > **İzleyici Inbox**. İzlenen
vakalar (kart grid) + son okunmamış generic CaseNotification'lar (top 10)
+ statü/zaman filtreleri. Bell drawer hızlı erişim için kalır.

### CasesList link count indicator
**Status:** Shipped (Phase 5b)
Vakalar listesinde başlık yanında violet chip `🔗 N` görünür (sadece N>0).
`outgoingLinks._count` üzerinden hesaplanır; tam liste için Bağlantılar
sekmesi.

### CaseNotification retention / cleanup
**Status:** Shipped (Phase 5a)
`POST /api/cron/notification-cleanup` — `readAt NOT NULL` ve 30g+ eski
satırları siler; okunmamış bildirimler korunur. Cron tetiklenmesi
(GitHub Actions / Vercel Cron) ops ekibi tarafından yapılandırılır.

### Eski notlara reaksiyon bildirimi
**Status:** Partial — PR #68 sonrası yeni notlar etkilenir
`CaseNote.authorId` PR #68 ile eklendi (nullable). Daha önce yazılmış
notlar `authorId=NULL` taşır; reaksiyon eklenirse not sahibine bildirim
üretilmez (sessiz `if` gate). Backfill cron'u Faz 5 backlog'unda.

### OpenAI 401/429 simülasyonu
**Status:** Static review only
Prod'da gerçek API key rotate veya rate-limit testi yapılamaz. Phase 2
audit fix'leri (PR #72) kod yolunda doğrulandı; canlıda davranış
gözlemlenmedi.

### Mobile responsive
**Status:** General flow works, not mobile-first
Telefon görüntü oranlarıyla temel akış kullanılabilir ama "mobile-first"
tasarım hedefi değil. Modal/popover overflow durumları olabilir.
