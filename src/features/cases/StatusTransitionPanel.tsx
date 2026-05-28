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
import { caseService, lookupService } from '@/services/caseService';
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

// Spec 11.1 renk paletiyle uyumlu kart tonları. UX redesign sonrası bu meta
// yolculuk node'larında, hızlı aksiyon chip'lerinde ve zorunlu alan
// kartında ortak kullanılır — başka yere kopyalanmaz.
const STATUS_META: Record<CaseStatus, {
  icon: ReactNode;
  description: string;
  requirement?: string;
  /** Available node — outlined */
  ringSoft: string;
  /** Available node — soft background */
  bgSoft: string;
  /** Solid current node fill */
  bgSolid: string;
  /** Text color for node label / chip */
  text: string;
  /** Selected pending — strong outline */
  selectedRing: string;
}> = {
  'Açık': {
    icon: <Inbox size={16} />,
    description: 'Yeni oluşturuldu, atama bekliyor.',
    ringSoft: 'ring-blue-200',
    bgSoft: 'bg-blue-50',
    bgSolid: 'bg-blue-500',
    text: 'text-blue-700',
    selectedRing: 'ring-blue-500',
  },
  'İncelemede': {
    icon: <SearchIcon size={16} />,
    description: 'Aktif olarak işleniyor.',
    ringSoft: 'ring-amber-200',
    bgSoft: 'bg-amber-50',
    bgSolid: 'bg-amber-500',
    text: 'text-amber-700',
    selectedRing: 'ring-amber-500',
  },
  '3rdPartyBekleniyor': {
    icon: <PauseCircle size={16} />,
    description: '3. partiden cevap bekleniyor; SLA durur.',
    requirement: '3. parti seçimi',
    ringSoft: 'ring-slate-300',
    bgSoft: 'bg-slate-50',
    bgSolid: 'bg-slate-500',
    text: 'text-slate-700',
    selectedRing: 'ring-slate-500',
  },
  'Eskalasyon': {
    icon: <TrendingUp size={16} />,
    description: 'Üst yönetime yükseltildi.',
    requirement: 'Seviye + gerekçe',
    ringSoft: 'ring-rose-200',
    bgSoft: 'bg-rose-50',
    bgSolid: 'bg-rose-500',
    text: 'text-rose-700',
    selectedRing: 'ring-rose-500',
  },
  'Çözüldü': {
    icon: <CheckCircle2 size={16} />,
    description: 'Sorun çözümlendi.',
    requirement: 'Çözüm notu zorunlu',
    ringSoft: 'ring-emerald-200',
    bgSoft: 'bg-emerald-50',
    bgSolid: 'bg-emerald-500',
    text: 'text-emerald-700',
    selectedRing: 'ring-emerald-500',
  },
  'YenidenAcildi': {
    icon: <RotateCw size={16} />,
    description: 'Müşteri çözümden memnun değil.',
    ringSoft: 'ring-violet-200',
    bgSoft: 'bg-violet-50',
    bgSolid: 'bg-violet-500',
    text: 'text-violet-700',
    selectedRing: 'ring-violet-500',
  },
  'İptalEdildi': {
    icon: <Ban size={16} />,
    description: 'Talep geri çekildi (terminal).',
    requirement: 'Gerekçe zorunlu',
    ringSoft: 'ring-slate-300',
    bgSoft: 'bg-slate-100',
    bgSolid: 'bg-slate-600',
    text: 'text-slate-700',
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

  const thirdParties = useMemo(() => lookupService.thirdParties(), []);

  // Vaka değişince akış sıfırlanır
  useEffect(() => {
    setPending(null);
    setResolutionNote('');
    setCancelReason('');
    setThirdPartyId('');
    setEscalationLevel('');
    setEscalationReason('');
    setError(null);
  }, [item.id]);

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
    const updated = await caseService.transitionStatus(item.id, pending, {
      resolutionNote: pending === 'Çözüldü' ? resolutionNote.trim() : undefined,
      cancellationReason: pending === 'İptalEdildi' ? cancelReason.trim() : undefined,
      thirdPartyId: pending === '3rdPartyBekleniyor' ? tp?.id : undefined,
      thirdPartyName: pending === '3rdPartyBekleniyor' ? tp?.name : undefined,
      escalationLevel: pending === 'Eskalasyon' && escalationLevel ? (escalationLevel as EscalationLevel) : undefined,
      escalationReason: pending === 'Eskalasyon' ? escalationReason.trim() : undefined,
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

  const currentMeta = STATUS_META[item.status];
  const escalationActive = item.escalationLevel && item.escalationLevel !== 'Yok';

  return (
    <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
      {/* ── Header ── */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Statü Geçişi</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Statü yolculuğunda ileri/geri taşıyabileceğin adımlar aktif. Pasif olanlara şu an geçilemez.
          </p>
        </div>
      </div>

      {/* ── 1) Current status summary ── */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white ${currentMeta.bgSolid}`}
            aria-hidden
          >
            {currentMeta.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Şu an
              </span>
              <span className={`text-sm font-semibold ${currentMeta.text}`}>
                {STATUS_LABELS[item.status]}
              </span>
              {item.priority === 'Critical' && (
                <Badge tint="rose" className="text-[10px]">
                  Critical
                </Badge>
              )}
              {item.slaViolation && (
                <Badge tint="rose" className="text-[10px]">
                  SLA ihlali
                </Badge>
              )}
              {escalationActive && (
                <Badge tint="amber" className="text-[10px]">
                  Eskalasyon: {ESCALATION_LEVEL_LABELS[item.escalationLevel]}
                </Badge>
              )}
              {item.approvalState === 'Pending' && (
                <Badge tint="violet" className="text-[10px]">
                  Onay bekliyor
                </Badge>
              )}
              {item.approvalState === 'Rejected' && (
                <Badge tint="rose" className="text-[10px]">
                  Onay reddedildi
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-[11.5px] text-slate-600">
              {currentMeta.description}
            </p>
          </div>
        </div>
      </div>

      {/* ── 2) Status journey (horizontal scroll if cramped) ── */}
      <div className="-mx-1 mb-3 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max items-start gap-1">
          {CASE_STATUSES.map((status, idx) => {
            const meta = STATUS_META[status];
            const isCurrent = status === item.status;
            const disabled = isCardDisabled(status);
            const selected = pending === status;
            const isLast = idx === CASE_STATUSES.length - 1;

            // Node style — current > selected > available > disabled
            let nodeCls: string;
            let labelCls: string;
            if (isCurrent) {
              nodeCls = `${meta.bgSolid} text-white ring-2 ring-offset-2 ring-offset-white ${meta.selectedRing} shadow-sm`;
              labelCls = `font-semibold ${meta.text}`;
            } else if (selected) {
              nodeCls = `${meta.bgSoft} ${meta.text} ring-2 ring-offset-2 ring-offset-white ${meta.selectedRing} shadow-sm`;
              labelCls = `font-semibold ${meta.text}`;
            } else if (!disabled) {
              nodeCls = `${meta.bgSoft} ${meta.text} ring-1 ring-inset ${meta.ringSoft} hover:scale-[1.04] hover:shadow-sm`;
              labelCls = `font-medium text-slate-700`;
            } else {
              nodeCls = 'bg-slate-50 text-slate-300 ring-1 ring-inset ring-slate-200';
              labelCls = 'text-slate-400';
            }

            const tooltip = disabled
              ? isCurrent
                ? 'Şu anki statü'
                : `${STATUS_LABELS[item.status]} → ${STATUS_LABELS[status]} geçişi tanımlı değil`
              : selected
                ? `${STATUS_LABELS[status]} seçildi — alttaki formu doldur`
                : `${STATUS_LABELS[status]} statüsüne geç`;

            return (
              <div key={status} className="flex items-start">
                <div className="flex w-[88px] shrink-0 flex-col items-center text-center">
                  <button
                    type="button"
                    onClick={() => selectCard(status)}
                    disabled={disabled}
                    title={tooltip}
                    aria-current={isCurrent ? 'step' : undefined}
                    className={`relative grid h-11 w-11 place-items-center rounded-full transition ${nodeCls} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {disabled && !isCurrent ? (
                      <Lock size={14} />
                    ) : (
                      <span aria-hidden>{meta.icon}</span>
                    )}
                  </button>
                  <div className="mt-1.5 px-0.5 text-[10.5px] leading-tight">
                    <div className={labelCls}>{STATUS_LABELS[status]}</div>
                    {isCurrent && (
                      <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                        Şu an
                      </div>
                    )}
                    {selected && !isCurrent && (
                      <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand-600">
                        Seçildi
                      </div>
                    )}
                    {!disabled && !isCurrent && !selected && meta.requirement && (
                      <div className="mt-0.5 truncate text-[9px] text-slate-500">
                        {meta.requirement}
                      </div>
                    )}
                    {disabled && !isCurrent && (
                      <div className="mt-0.5 text-[9px] text-slate-400">Geçilemez</div>
                    )}
                  </div>
                </div>
                {!isLast && (
                  <span
                    className="mt-5 flex h-px w-4 shrink-0 items-center bg-slate-200 sm:w-6"
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 3) Recommended next actions ── */}
      {allowedTransitions.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
            Önerilen aksiyonlar
          </span>
          {allowedTransitions.map((target) => {
            const meta = STATUS_META[target];
            const selected = pending === target;
            // Each chip routes through the SAME selectCard handler — no
            // separate logic, no validation bypass.
            return (
              <button
                key={target}
                type="button"
                onClick={() => selectCard(target)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] transition ${
                  selected
                    ? `${meta.bgSoft} ${meta.text} border-transparent ring-2 ring-offset-1 ring-offset-white ${meta.selectedRing}`
                    : `border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:${meta.text}`
                }`}
              >
                <span aria-hidden>{meta.icon}</span>
                <span>{STATUS_LABELS[target]}'a taşı</span>
                <ChevronRight size={11} className="opacity-60" />
              </button>
            );
          })}
        </div>
      )}
      {allowedTransitions.length === 0 && (
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] text-slate-600">
          <Lock size={11} className="mr-1 inline align-text-bottom" />
          Bu statüden başka bir statüye geçilemez (terminal). İşlem yapmak için vakayı yeniden açan
          bir adım gerekir.
        </div>
      )}

      {/* ── 4) Conditional pending-state form — UNCHANGED business logic ── */}
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
