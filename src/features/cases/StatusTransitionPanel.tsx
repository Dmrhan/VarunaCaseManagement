import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  Inbox,
  Lock,
  PauseCircle,
  RotateCw,
  Search as SearchIcon,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { VoiceNoteButton } from '@/components/ui/VoiceNoteButton';
import { RunaAiCard } from '@/components/ui/RunaAiCard';
import {
  caseService,
  lookupService,
  type SmartTicketTaxonomyResponse,
  type SmartTicketRootCauseGroup,
  type SmartTicketTaxonomyItem,
} from '@/services/caseService';
import { aiService, aiErrorMessage } from '@/services/aiService';
import { MentionTextarea } from './components/MentionTextarea';

// Mention regex — `@[Name](userId)` formatı. Bir text bunu içeriyorsa BE'nin
// CaseMention parse'ı tetiklensin diye yan-not (addNote) ekleriz.
const MENTION_RE = /@\[[^\]]+\]\([^)]+\)/;
import {
  CASE_STATUSES,
  ESCALATION_LEVELS,
  ESCALATION_LEVEL_LABELS,
  STATUS_TRANSITIONS,
  type Case,
  type CaseStatus,
  type EscalationLevel,
} from './types';

interface StatusTransitionPanelProps {
  item: Case;
  onApplied: (updated: Case) => void;
}

// Spec 11.1 renk paletiyle uyumlu kart tonları
const STATUS_META: Record<CaseStatus, {
  icon: ReactNode;
  description: string;
  requirement?: string;
  ring: string;
  bg: string;
  text: string;
  selectedRing: string;
}> = {
  'Açık': {
    icon: <Inbox size={18} />,
    description: 'Yeni oluşturuldu, atama bekliyor.',
    ring: 'ring-blue-200',
    bg: 'bg-blue-50/40',
    text: 'text-blue-700',
    selectedRing: 'ring-blue-500',
  },
  'İncelemede': {
    icon: <SearchIcon size={18} />,
    description: 'Aktif olarak işleniyor.',
    ring: 'ring-amber-200',
    bg: 'bg-amber-50/40',
    text: 'text-amber-700',
    selectedRing: 'ring-amber-500',
  },
  '3rdPartyBekleniyor': {
    icon: <PauseCircle size={18} />,
    description: '3. partiden cevap bekleniyor; SLA durur.',
    requirement: '3. parti seçimi',
    ring: 'ring-slate-200',
    bg: 'bg-slate-50/60',
    text: 'text-slate-700',
    selectedRing: 'ring-slate-500',
  },
  'Eskalasyon': {
    icon: <TrendingUp size={18} />,
    description: 'Üst yönetime yükseltildi.',
    requirement: 'Seviye + gerekçe',
    ring: 'ring-rose-200',
    bg: 'bg-rose-50/40',
    text: 'text-rose-700',
    selectedRing: 'ring-rose-500',
  },
  'Çözüldü': {
    icon: <CheckCircle2 size={18} />,
    description: 'Sorun çözümlendi.',
    requirement: 'Çözüm notu zorunlu',
    ring: 'ring-emerald-200',
    bg: 'bg-emerald-50/40',
    text: 'text-emerald-700',
    selectedRing: 'ring-emerald-500',
  },
  'YenidenAcildi': {
    icon: <RotateCw size={18} />,
    description: 'Müşteri çözümden memnun değil.',
    ring: 'ring-violet-200',
    bg: 'bg-violet-50/40',
    text: 'text-violet-700',
    selectedRing: 'ring-violet-500',
  },
  'İptalEdildi': {
    icon: <Ban size={18} />,
    description: 'Talep geri çekildi (terminal).',
    requirement: 'Gerekçe zorunlu',
    ring: 'ring-slate-200',
    bg: 'bg-slate-100',
    text: 'text-slate-600',
    selectedRing: 'ring-slate-500',
  },
};

const STATUS_LABELS: Record<CaseStatus, string> = {
  'Açık':                'Açık',
  'İncelemede':          'İncelemede',
  '3rdPartyBekleniyor':  '3. Parti Bekleniyor',
  'Eskalasyon':          'Eskalasyon',
  'Çözüldü':             'Çözüldü',
  'YenidenAcildi':       'Yeniden Açıldı',
  'İptalEdildi':         'İptal Edildi',
};

export function StatusTransitionPanel({ item, onApplied }: StatusTransitionPanelProps) {
  const allowedTransitions = useMemo(() => STATUS_TRANSITIONS[item.status], [item.status]);

  const [pending, setPending] = useState<CaseStatus | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [thirdPartyId, setThirdPartyId] = useState('');
  const [escalationLevel, setEscalationLevel] = useState<EscalationLevel | ''>('');
  const [escalationReason, setEscalationReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const { toast } = useToast();

  // WR-Smart-Ticket Phase 1e — yapılandırılmış kapanış metadata'sı.
  // Vaka Smart Ticket intake'inden açıldıysa Çözüldü kararında ek
  // dropdown'lar gösterilir. Diğer vakalarda görünmez.
  const isSmartTicket = !!(item.customFields as { smartTicket?: unknown } | undefined)?.smartTicket;
  const [closureRcg, setClosureRcg] = useState('');
  const [closureRcd, setClosureRcd] = useState('');
  const [closureRt, setClosureRt] = useState('');
  const [closurePp, setClosurePp] = useState('');
  const [closureTax, setClosureTax] = useState<SmartTicketTaxonomyResponse['taxonomies'] | null>(null);
  const [closureTaxLoading, setClosureTaxLoading] = useState(false);

  const thirdParties = useMemo(() => lookupService.thirdParties(), []);

  // Vaka değişince akış sıfırlanır.
  // Codex PR-1e review P2 fix — Panel reuse (örn. L1WorkbenchPanel başka
  // case gönderdiğinde) önceki tenant'ın closure taxonomy cache'i ekrana
  // sızıp yanlış code/label persist edilebiliyordu. closureTax'i de
  // sıfırlıyoruz; yeni item için aşağıdaki fetch effect tetiklenir.
  useEffect(() => {
    setPending(null);
    setResolutionNote('');
    setCancelReason('');
    setThirdPartyId('');
    setEscalationLevel('');
    setEscalationReason('');
    setError(null);
    setClosureRcg('');
    setClosureRcd('');
    setClosureRt('');
    setClosurePp('');
    setClosureTax(null);
  }, [item.id]);

  // Smart Ticket → Çözüldü kararı seçildiğinde taxonomy listelerini çek.
  // Endpoint per-tenant; companyId bilgisi Case üzerinde mevcut.
  useEffect(() => {
    let alive = true;
    if (!isSmartTicket || pending !== 'Çözüldü' || closureTax) return;
    setClosureTaxLoading(true);
    void lookupService
      .smartTicketTaxonomies(item.companyId)
      .then((res: SmartTicketTaxonomyResponse) => {
        if (!alive) return;
        setClosureTax(res.taxonomies);
      })
      .catch(() => {
        if (!alive) return;
        // Sessiz fallback: taxonomy çekilemezse alanlar disabled kalır,
        // case close bloke olmaz (spec).
        setClosureTax(null);
      })
      .finally(() => {
        if (alive) setClosureTaxLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isSmartTicket, pending, item.companyId, closureTax]);

  // Kök Neden Grubu değişince Detay seçimini sıfırla.
  useEffect(() => {
    setClosureRcd('');
  }, [closureRcg]);

  const closureRcgList: SmartTicketRootCauseGroup[] = closureTax?.rootCauseGroup ?? [];
  const closureRcdList: SmartTicketTaxonomyItem[] =
    closureRcgList.find((g) => g.code === closureRcg)?.children ?? [];
  const closureRtList: SmartTicketTaxonomyItem[] = closureTax?.resolutionType ?? [];
  const closurePpList: SmartTicketTaxonomyItem[] = closureTax?.permanentPrevention ?? [];

  async function handleDraftResolution() {
    setDrafting(true);
    const r = await aiService.draftResolution({
      caseSubject: item.title,
      description: item.description,
      caseType: item.caseType,
      category: item.category,
      history: item.history,
      notes: item.notes,
    });
    setDrafting(false);
    if (r.ok) {
      setResolutionNote(r.data.draft);
      toast({ type: 'success', message: 'Çözüm taslağı oluşturuldu.', duration: 1800 });
    } else {
      toast({ type: 'warn', message: aiErrorMessage(r.error), duration: 2500 });
    }
  }

  const requiresSupervisor =
    pending === 'Çözüldü' &&
    (item.priority === 'Critical' ||
      item.slaViolation ||
      item.escalationLevel === 'Direktör' ||
      item.escalationLevel === 'ÜstYönetim');

  function isCardDisabled(target: CaseStatus): boolean {
    if (target === item.status) return true;
    return !allowedTransitions.includes(target);
  }

  function selectCard(target: CaseStatus) {
    if (isCardDisabled(target)) return;
    if (pending === target) {
      setPending(null);
      return;
    }
    setPending(target);
    setError(null);
    setResolutionNote('');
    setCancelReason('');
    setThirdPartyId('');
    setEscalationLevel('');
    setEscalationReason('');
  }

  // FAZ 4 — Çözüldü transition için zorunlu kontrol listesi maddelerinin
  // tamamlanmış olması gerekir. Eksik varsa transition bloklanır.
  const requiredChecklistPending =
    item.checklistItems?.filter((it) => it.required && !it.checked) ?? [];

  function applyDisabled(): boolean {
    if (!pending) return true;
    if (pending === 'Çözüldü' && !resolutionNote.trim()) return true;
    if (pending === 'Çözüldü' && requiredChecklistPending.length > 0) return true;
    if (pending === 'İptalEdildi' && !cancelReason.trim()) return true;
    if (pending === '3rdPartyBekleniyor' && !thirdPartyId) return true;
    if (pending === 'Eskalasyon' && (!escalationLevel || !escalationReason.trim())) return true;
    return false;
  }

  async function handleApply() {
    if (!pending || submitting) return;
    setSubmitting(true);
    setError(null);
    const tp = thirdParties.find((t) => t.id === thirdPartyId);

    // Yapılandırılmış kapanış payload'u — yalnız Smart Ticket Case'i +
    // Çözüldü kararı + en az bir alan dolu durumunda. Backend
    // customFields.smartTicket.closure altına deep-merge eder; opening
    // alanları + diğer dinamik customFields aynen korunur.
    const closureLabels = (() => {
      const rcg = closureRcgList.find((g) => g.code === closureRcg);
      const rcd = closureRcdList.find((d) => d.code === closureRcd);
      const rt = closureRtList.find((r) => r.code === closureRt);
      const pp = closurePpList.find((p) => p.code === closurePp);
      return {
        rootCauseGroup: closureRcg || undefined,
        rootCauseGroupLabel: rcg?.label,
        rootCauseDetail: closureRcd || undefined,
        rootCauseDetailLabel: rcd?.label,
        resolutionType: closureRt || undefined,
        resolutionTypeLabel: rt?.label,
        permanentPrevention: closurePp || undefined,
        permanentPreventionLabel: pp?.label,
      };
    })();
    const closureHasAnyField =
      isSmartTicket &&
      pending === 'Çözüldü' &&
      (closureRcg || closureRcd || closureRt || closurePp);

    const updated = await caseService.transitionStatus(item.id, pending, {
      resolutionNote: pending === 'Çözüldü' ? resolutionNote.trim() : undefined,
      cancellationReason: pending === 'İptalEdildi' ? cancelReason.trim() : undefined,
      thirdPartyId: pending === '3rdPartyBekleniyor' ? tp?.id : undefined,
      thirdPartyName: pending === '3rdPartyBekleniyor' ? tp?.name : undefined,
      escalationLevel: pending === 'Eskalasyon' && escalationLevel ? (escalationLevel as EscalationLevel) : undefined,
      escalationReason: pending === 'Eskalasyon' ? escalationReason.trim() : undefined,
      smartTicketClosure: closureHasAnyField ? closureLabels : undefined,
    });
    setSubmitting(false);
    if (updated) {
      toast({
        type: pending === 'Çözüldü' ? 'success' : pending === 'İptalEdildi' ? 'warn' : 'info',
        title: 'Statü güncellendi',
        message: `${updated.caseNumber} → ${STATUS_LABELS[pending]}`,
      });

      // Mention mirror — reason/note metni @[Name](userId) içeriyorsa BE'nin
      // CaseMention parse'ı yan-bir Internal not aracılığıyla tetiklenir.
      // (transitionStatus endpoint'i mention parse etmiyor; addNote ediyor.)
      if (pending === 'Eskalasyon' && MENTION_RE.test(escalationReason)) {
        const levelLabel = escalationLevel ? ` (${escalationLevel})` : '';
        await caseService.addNote(item.id, {
          content: `Eskalasyon başlatıldı${levelLabel}. Gerekçe: ${escalationReason.trim()}`,
          visibility: 'Internal',
          authorName: 'Mock User',
        });
      } else if (pending === 'Çözüldü' && MENTION_RE.test(resolutionNote)) {
        await caseService.addNote(item.id, {
          content: `Vaka çözüldü. Çözüm notu: ${resolutionNote.trim()}`,
          visibility: 'Internal',
          authorName: 'Mock User',
        });
      } else if (pending === 'İptalEdildi' && MENTION_RE.test(cancelReason)) {
        await caseService.addNote(item.id, {
          content: `Vaka iptal edildi. Gerekçe: ${cancelReason.trim()}`,
          visibility: 'Internal',
          authorName: 'Mock User',
        });
      }

      setPending(null);
      onApplied(updated);
    } else {
      setError('Statü değiştirilemedi.');
    }
  }

  return (
    <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Statü Geçişi</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Mevcut statüden geçilebilen kartlar aktif. Diğerleri pasiftir.
          </p>
        </div>
        <Badge tint="slate">
          Şu an: <strong className="ml-1">{STATUS_LABELS[item.status]}</strong>
        </Badge>
      </div>

      {/* Status kart grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7">
        {CASE_STATUSES.map((status) => {
          const meta = STATUS_META[status];
          const isCurrent = status === item.status;
          const disabled = isCardDisabled(status);
          const selected = pending === status;
          return (
            <button
              key={status}
              type="button"
              onClick={() => selectCard(status)}
              disabled={disabled}
              className={`group relative flex flex-col items-start gap-1.5 rounded-lg p-3 text-left ring-1 ring-inset transition ${
                disabled
                  ? 'cursor-not-allowed bg-slate-50/40 opacity-50 ring-slate-200'
                  : `${meta.bg} ${meta.ring} hover:scale-[1.02] hover:shadow-sm`
              } ${
                selected
                  ? `ring-2 ring-offset-1 ${meta.selectedRing} shadow-md`
                  : ''
              }`}
              title={
                disabled && !isCurrent
                  ? `${item.status} → ${status} geçişi yok`
                  : isCurrent
                    ? 'Şu an bu statüdesin'
                    : `${status} statüsüne geç`
              }
            >
              <div className="flex w-full items-center justify-between">
                <span className={`flex h-7 w-7 items-center justify-center rounded-md ${meta.bg} ${meta.text}`}>
                  {meta.icon}
                </span>
                {disabled && !isCurrent && <Lock size={11} className="text-slate-400" />}
                {isCurrent && (
                  <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-700">
                    Şu an
                  </span>
                )}
                {selected && !isCurrent && (
                  <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
                    Seçildi
                  </span>
                )}
              </div>
              <div className={`text-sm font-semibold ${meta.text}`}>{STATUS_LABELS[status]}</div>
              <div className="text-[11px] leading-tight text-slate-600">{meta.description}</div>
              {meta.requirement && !disabled && (
                <span className="mt-auto rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                  ⚠ {meta.requirement}
                </span>
              )}
              {disabled && !isCurrent && (
                <span className="mt-auto text-[10px] text-slate-400">Geçilemez</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Koşullu alanlar */}
      {pending && (
        <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <div className="flex items-center gap-2">
            <ChevronRight size={14} className="text-slate-400" />
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              {STATUS_LABELS[pending]} için zorunlu alanlar
            </span>
          </div>

          {pending === 'Çözüldü' && requiredChecklistPending.length > 0 && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
              <div className="mb-1 font-semibold">
                Vaka çözülmeden önce {requiredChecklistPending.length} zorunlu kontrol maddesi
                tamamlanmalı:
              </div>
              <ul className="ml-4 list-disc space-y-0.5">
                {requiredChecklistPending.map((it) => (
                  <li key={it.id}>{it.label}</li>
                ))}
              </ul>
              <div className="mt-1.5 text-[11px] text-rose-700 dark:text-rose-300">
                Detay sekmesindeki <strong>Kontrol Listesi</strong> bölümünden işaretleyebilirsiniz.
              </div>
            </div>
          )}

          {pending === 'Çözüldü' && (
            <>
              <RunaAiCard
                title="Çözüm Notu Taslağı"
                body={
                  resolutionNote
                    ? 'Taslak alana yazıldı; düzenleyebilirsiniz veya yeni bir taslak üretebilirsiniz.'
                    : 'Vaka geçmişine ve notlara bakarak müşteri dostu bir çözüm notu önerilir.'
                }
                isLoading={drafting}
                primaryAction={{
                  label: resolutionNote ? '✦ Yeniden Üret' : '✦ Taslak Üret',
                  onClick: () => void handleDraftResolution(),
                  disabled: drafting,
                }}
              />
              <Field
                label="Çözüm Notu"
                required
                hint="@ ile yardım eden kişi veya QA'yı etiketleyebilirsin."
                actions={
                  <VoiceNoteButton
                    onTranscript={(chunk) =>
                      setResolutionNote((t) => (t ? `${t} ${chunk}` : chunk))
                    }
                  />
                }
              >
                <MentionTextarea
                  caseId={item.id}
                  value={resolutionNote}
                  onChange={setResolutionNote}
                  placeholder="Sorunun nasıl çözüldüğünü açıklayın… (@yardım eden)"
                  rows={3}
                />
              </Field>

              {/* WR-Smart-Ticket Phase 1e — yapılandırılmış kapanış alanları.
                  Yalnız Smart Ticket Case'lerinde gösterilir. Hepsi opsiyonel
                  — taxonomy boş olabilir; close bloke olmaz. Submit'te
                  smartTicketClosure payload backend deep-merge ile
                  customFields.smartTicket.closure'a yazar. */}
              {isSmartTicket && (
                <div className="rounded-md border border-brand-100 bg-brand-50/40 p-3 dark:border-brand-900/30 dark:bg-brand-950/20">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-brand-700 dark:text-brand-200">
                      Akıllı Ticket Kapanış Bilgileri (opsiyonel)
                    </span>
                    {closureTaxLoading && (
                      <span className="text-[11px] text-slate-500">yükleniyor…</span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field label="Kök Neden Grubu">
                      <Select
                        value={closureRcg}
                        onChange={(e) => setClosureRcg(e.target.value)}
                        disabled={closureTaxLoading || closureRcgList.length === 0}
                      >
                        <option value="">— Seçim yok —</option>
                        {closureRcgList.map((g) => (
                          <option key={g.code} value={g.code}>
                            {g.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Kök Neden Detayı"
                      hint={
                        closureRcg && closureRcdList.length === 0
                          ? 'Bu grubun detay satırı yok.'
                          : undefined
                      }
                    >
                      <Select
                        value={closureRcd}
                        onChange={(e) => setClosureRcd(e.target.value)}
                        disabled={
                          closureTaxLoading || !closureRcg || closureRcdList.length === 0
                        }
                      >
                        <option value="">— Seçim yok —</option>
                        {closureRcdList.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Çözüm Tipi">
                      <Select
                        value={closureRt}
                        onChange={(e) => setClosureRt(e.target.value)}
                        disabled={closureTaxLoading || closureRtList.length === 0}
                      >
                        <option value="">— Seçim yok —</option>
                        {closureRtList.map((r) => (
                          <option key={r.code} value={r.code}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Kalıcı Önlem">
                      <Select
                        value={closurePp}
                        onChange={(e) => setClosurePp(e.target.value)}
                        disabled={closureTaxLoading || closurePpList.length === 0}
                      >
                        <option value="">— Seçim yok —</option>
                        {closurePpList.map((p) => (
                          <option key={p.code} value={p.code}>
                            {p.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500 dark:text-ndark-muted">
                    Bu alanlar opsiyoneldir ve vaka kapatma için zorunlu
                    değildir. Doldurulursa kapanışla aynı transaction içinde
                    <code className="ml-1 font-mono">customFields.smartTicket.closure</code> alanına
                    yazılır; mevcut Smart Ticket açılış bilgileri korunur.
                  </p>
                </div>
              )}
            </>
          )}

          {pending === 'İptalEdildi' && (
            <Field
              label="İptal Gerekçesi"
              required
              hint="@ ile onaylayan yöneticiyi veya CSM'yi etiketleyebilirsin."
              actions={
                <VoiceNoteButton
                  onTranscript={(chunk) =>
                    setCancelReason((t) => (t ? `${t} ${chunk}` : chunk))
                  }
                />
              }
            >
              <MentionTextarea
                caseId={item.id}
                value={cancelReason}
                onChange={setCancelReason}
                placeholder="İptal sebebini yazın… (@yönetici / @CSM)"
                rows={2}
              />
            </Field>
          )}

          {pending === '3rdPartyBekleniyor' && (
            <Field label="Beklenen 3. Parti" required hint="Bu süreçte SLA sayacı duraklatılır.">
              <Select value={thirdPartyId} onChange={(e) => setThirdPartyId(e.target.value)}>
                <option value="">Seçin…</option>
                {thirdParties.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {pending === 'Eskalasyon' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Eskalasyon Seviyesi" required>
                <Select
                  value={escalationLevel}
                  onChange={(e) => setEscalationLevel(e.target.value as EscalationLevel | '')}
                >
                  <option value="">Seçin…</option>
                  {ESCALATION_LEVELS.filter((l) => l !== 'Yok').map((l) => (
                    <option key={l} value={l}>
                      {ESCALATION_LEVEL_LABELS[l]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Gerekçe"
                required
                hint="@ ile yöneticiyi etiketle — anında bildirim alır."
                className="sm:row-span-1"
                actions={
                  <VoiceNoteButton
                    onTranscript={(chunk) =>
                      setEscalationReason((t) => (t ? `${t} ${chunk}` : chunk))
                    }
                  />
                }
              >
                <MentionTextarea
                  caseId={item.id}
                  value={escalationReason}
                  onChange={setEscalationReason}
                  placeholder="Eskalasyon sebebini açıklayın… (@yönetici)"
                  rows={2}
                />
              </Field>
            </div>
          )}

          {requiresSupervisor && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                Çözüldü geçişi <strong>Supervisor onayı</strong> gerektiriyor (Critical / SLA ihlali /
                yüksek eskalasyon). FAZ 0'da onay simülasyonludur — geçiş yine de uygulanır.
              </span>
            </div>
          )}

          {/* WR-D4 Phase 1 — Çözüm Onayı politikası eşleşiyorsa kullanıcıyı kart'a yönlendir.
              Tam blok yukarıdaki ResolutionApprovalCard tarafından yapılır; burada sadece
              operatör "Uygula"ya basmaya çalışırken hatırlatma çıkıyor. */}
          {pending === 'Çözüldü' && item.approvalState && item.approvalState !== 'Approved' && (
            <div className="flex items-start gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-200">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                Bu vaka için <strong>çözüm onayı zorunlu</strong>. Üstteki "Çözüm Onayı"
                kartından önce onayı tamamla; sonra Çözüldü'ye geç.
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={submitting}>
              Vazgeç
            </Button>
            <Button
              size="sm"
              disabled={applyDisabled() || submitting}
              onClick={handleApply}
              rightIcon={<ChevronRight size={14} />}
            >
              {submitting ? 'Uygulanıyor…' : 'Uygula'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
