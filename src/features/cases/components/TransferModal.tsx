import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Bot, Building2, Check, Pencil, Sparkles, User } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextArea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { caseService, lookupService } from '@/services/caseService';
import { aiService, type TransferReasonCode, type TransferSuggestion } from '@/services/aiService';
import { formatRelative } from '@/lib/format';
import type { Case, CaseTransferRecord } from '../types';

interface TransferModalProps {
  open: boolean;
  caseItem: Case;
  onClose: () => void;
  /** Aktarım başarılı; parent vakayı güncelleyebilir. */
  onTransferred: (updated: Case) => void;
}

interface ReasonChip {
  code: TransferReasonCode;
  label: string;
}

const REASON_CHIPS: ReasonChip[] = [
  { code: 'wrong_team', label: 'Yanlış Takım' },
  { code: 'expertise', label: 'Uzmanlık' },
  { code: 'workload', label: 'İş Yükü' },
  { code: 'escalation', label: 'Eskalasyon' },
  { code: 'customer_request', label: 'Müşteri Talebi' },
  { code: 'other', label: 'Diğer' },
];

const MIN_REASON = 5;

/**
 * FAZ 2 §20.2 — Vaka Aktarımı modal'ı.
 *
 * Akış:
 *  1. Modal açılır → /api/ai/transfer-suggest çağrılır (skeleton).
 *  2. AI öneri kartı gösterilir (Uygula / Değiştir).
 *  3. Form (takım + kişi + gerekçe çipi + serbest metin).
 *  4. Submit → /api/cases/:id/transfer → /api/cases/:id/transfer-brief.
 *  5. Success state'te devir notu (3 madde).
 */
export function TransferModal({ open, caseItem, onClose, onTransferred }: TransferModalProps) {
  const allTeams = useMemo(() => lookupService.teams(), []);
  const allPersons = useMemo(() => lookupService.persons(), []);
  const { toast } = useToast();

  // Vakanın şirketine ait + mevcut takım dışındaki aktif takımlar
  const availableTeams = useMemo(
    () => allTeams.filter((t) => t.companyId === caseItem.companyId && t.id !== caseItem.assignedTeamId),
    [allTeams, caseItem.companyId, caseItem.assignedTeamId],
  );

  // AI durumu
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<TransferSuggestion | null>(null);

  // Form durumu
  const [toTeamId, setToTeamId] = useState('');
  const [toPersonId, setToPersonId] = useState('');
  const [reasonCode, setReasonCode] = useState<TransferReasonCode | ''>('');
  const [reasonText, setReasonText] = useState('');

  // Geçmiş kayıtlar (transferCount > 0 ise gösterilir)
  const [history, setHistory] = useState<CaseTransferRecord[]>([]);

  // Submit / sonuç durumu
  const [submitting, setSubmitting] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [brief, setBrief] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // ── Modal açılınca AI önerisini ve geçmişi yükle ──
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setAiLoading(true);
    setAiError(null);
    setAiSuggestion(null);
    setToTeamId('');
    setToPersonId('');
    setReasonCode('');
    setReasonText('');
    setBrief(null);
    setSuccess(false);

    void aiService.transferSuggest(caseItem.id).then((r) => {
      if (cancelled) return;
      setAiLoading(false);
      if (r.ok) {
        setAiSuggestion(r.data);
      } else {
        setAiError(r.error.message ?? 'AI önerisi alınamadı.');
      }
    });

    if ((caseItem.transferCount ?? 0) > 0) {
      void caseService.listTransfers(caseItem.id).then((rows) => {
        if (!cancelled) setHistory(rows);
      });
    } else {
      setHistory([]);
    }

    return () => {
      cancelled = true;
    };
  }, [open, caseItem.id, caseItem.transferCount]);

  // Aynı takım için kişi listesi
  const personsForTeam = useMemo(
    () => allPersons.filter((p) => p.teamId === toTeamId),
    [allPersons, toTeamId],
  );

  // Takım değişince seçili kişi geçersizse temizle
  useEffect(() => {
    if (toPersonId && !personsForTeam.some((p) => p.id === toPersonId)) {
      setToPersonId('');
    }
  }, [toPersonId, personsForTeam]);

  // PR-4a-b Codex fix: Apply sadece form'u prefill eder, accept telemetrisi
  // YAZMAZ. Kullanici sonradan modal'i iptal edebilir, baska takim secebilir
  // veya transfer fail olabilir — bu yollar acceptanceRate'i sismelendirir.
  // Tek dogru sinyal noktasi: handleSubmit icinde transferCase basariyla
  // dondukten sonra final toTeamId ile karar yazilir.
  function applyAiSuggestion() {
    if (!aiSuggestion) return;
    setToTeamId(aiSuggestion.suggestedTeamId);
    setReasonCode(aiSuggestion.reasonCode);
    setReasonText(aiSuggestion.reasonText);
  }

  const reasonOk =
    reasonCode !== '' &&
    (reasonCode === 'other'
      ? reasonText.trim().length >= MIN_REASON
      : reasonText.trim().length === 0 || reasonText.trim().length >= MIN_REASON);
  const canSubmit = toTeamId !== '' && reasonCode !== '' && reasonOk && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    if (!reasonCode) return; // narrowing — TransferReasonCode dışındaki '' değerini ele
    const code: TransferReasonCode = reasonCode;
    setSubmitting(true);

    const finalReason = reasonText.trim().length >= MIN_REASON
      ? reasonText.trim()
      : (REASON_CHIPS.find((c) => c.code === code)?.label ?? 'Aktarım gerekçesi');

    const updated = await caseService.transferCase(caseItem.id, {
      toTeamId,
      toPersonId: toPersonId || undefined,
      reason: finalReason,
      reasonCode: code,
      aiSuggestedTeamId: aiSuggestion?.suggestedTeamId,
      aiSuggestedReason: aiSuggestion?.reasonText,
      aiReasonCode: aiSuggestion?.reasonCode,
      aiConfidence: aiSuggestion?.confidence,
    });

    if (!updated) {
      setSubmitting(false);
      return; // toast apiFetch tarafından gösterildi
    }

    // Telemetri (PR-4a / PR-4a-b / AIUsagePage.acceptanceRate):
    // Sadece transferCase basariyla doner ve modal abandone edilmediyse
    // burada calisir. Final toTeamId == AI'nin onerdigi takim ise accepted,
    // aksi halde rejected. Fire-and-forget — UX'i bloklamaz.
    if (aiSuggestion?.usageLogId) {
      void aiService.markUsageAccepted(
        aiSuggestion.usageLogId,
        toTeamId === aiSuggestion.suggestedTeamId,
      );
    }

    onTransferred(updated);

    // Devir notu üret — başarısızlık akışı bozmasın
    setBriefLoading(true);
    const briefResult = await caseService.transferBrief(caseItem.id, {
      toTeamId,
      toPersonId: toPersonId || undefined,
    });
    setBriefLoading(false);
    setBrief(briefResult?.brief ?? null);

    setSubmitting(false);
    setSuccess(true);

    toast({
      type: 'success',
      message: 'Vaka aktarıldı ✓',
      duration: 2500,
    });
  }

  const teamSelected = availableTeams.find((t) => t.id === toTeamId);
  const aiTeam = aiSuggestion ? availableTeams.find((t) => t.id === aiSuggestion.suggestedTeamId) : undefined;
  const aiTeamApplied = !!aiSuggestion && toTeamId === aiSuggestion.suggestedTeamId;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Vakayı Aktar"
      footer={
        success ? (
          <div className="flex justify-end">
            <Button onClick={onClose}>Kapat</Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              Vazgeç
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit} leftIcon={<ArrowRightLeft size={14} />}>
              {submitting ? 'Aktarılıyor…' : 'Aktar'}
            </Button>
          </div>
        )
      }
    >
      {success ? (
        <SuccessPanel
          fromTeamName={caseItem.assignedTeamName ?? '—'}
          toTeamName={teamSelected?.name ?? '—'}
          briefLoading={briefLoading}
          brief={brief}
        />
      ) : (
        <div className="space-y-4">
          {/* Current assignment context — single source of "from / to"
              truth for the operator. Pulls from caseItem only; no extra
              fetch. */}
          <div className="rounded-md border border-slate-200 bg-white px-3 py-2.5 dark:border-ndark-border dark:bg-ndark-card">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-ndark-muted">
              Mevcut Atama
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-700 dark:text-ndark-text">
              <span className="inline-flex items-center gap-1.5">
                <Building2 size={12} className="text-slate-400" />
                <span className="text-slate-500">Takım:</span>
                <span className="font-medium">
                  {caseItem.assignedTeamName ?? 'Atanmamış'}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <User size={12} className="text-slate-400" />
                <span className="text-slate-500">Kişi:</span>
                <span className="font-medium">
                  {caseItem.assignedPersonName ?? 'Atanmamış'}
                </span>
              </span>
              {(caseItem.transferCount ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-600 dark:bg-ndark-bg dark:text-ndark-muted">
                  Daha önce {caseItem.transferCount} aktarım
                </span>
              )}
              {caseItem.escalationLevel && caseItem.escalationLevel !== 'Yok' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                  Eskalasyon: {caseItem.escalationLevel}
                </span>
              )}
            </div>
          </div>

          {/* Geçmiş — transferCount > 0 ise */}
          {history.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-ndark-border dark:bg-ndark-card/40">
              <div className="text-xs font-medium text-slate-700 dark:text-ndark-text">
                Bu vaka daha önce {history.length} kez aktarıldı
              </div>
              <ul className="mt-1.5 space-y-1 text-[11px] text-slate-600 dark:text-ndark-muted">
                {history.slice(0, 3).map((h) => (
                  <li key={h.id} className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-slate-500">{formatRelative(h.transferredAt)}:</span>
                    <span>{h.fromTeamName ?? '—'}</span>
                    <span className="text-slate-400">→</span>
                    <span className="font-medium text-slate-700 dark:text-ndark-text">{h.toTeamName ?? '—'}</span>
                    {h.reasonLabel && (
                      <span className="text-slate-500">· {h.reasonLabel}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* AI öneri kartı */}
          {aiLoading ? (
            <div className="rounded-md border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
              <div className="flex items-center gap-2 text-xs font-medium text-violet-800 dark:text-violet-200">
                <Sparkles size={14} className="animate-pulse" />
                RUNA AI analiz ediyor…
              </div>
              <div className="mt-2 space-y-2">
                <Skeleton height={14} width="60%" />
                <Skeleton height={12} width="90%" />
              </div>
            </div>
          ) : aiError ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              ⚠ AI önerisi alınamadı: {aiError}. Aşağıdan manuel seçim yapabilirsin.
            </div>
          ) : aiSuggestion ? (
            <AiSuggestionCard
              suggestion={aiSuggestion}
              applied={aiTeamApplied}
              onApply={applyAiSuggestion}
            />
          ) : null}

          {/* Empty-state banner — vakanın şirketinde aktarılabilecek başka aktif takım yok.
              AI durumundan bağımsız; data eksikse net mesaj göster. */}
          {availableTeams.length === 0 && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-200">
              ⚠ Bu vakanın şirketinde ({caseItem.companyName}) aktarılabilecek başka aktif takım bulunmuyor.
              Yönetim → Takımlar altından yeni takım oluştur veya pasif bir takımı aktif et.
            </div>
          )}

          {/* Form */}
          <Field label="Aktarılacak Takım" required>
            <Select
              value={toTeamId}
              onChange={(e) => setToTeamId(e.target.value)}
              disabled={availableTeams.length === 0}
            >
              <option value="">
                {availableTeams.length === 0 ? '— Aktif takım yok —' : 'Takım seçin…'}
              </option>
              {availableTeams.map((t) => {
                const isAi = aiSuggestion?.suggestedTeamId === t.id;
                return (
                  <option key={t.id} value={t.id}>
                    {isAi ? '🤖 ' : ''}
                    {t.name}
                  </option>
                );
              })}
            </Select>
            {aiTeam && toTeamId !== aiTeam.id && (
              <div className="mt-1 text-[11px] text-violet-700 dark:text-violet-300">
                AI önerisi: {aiTeam.name}
              </div>
            )}
          </Field>

          {/* Team-member preview — visible when a target team is chosen.
              Helps the operator confirm membership before committing.
              Highlights the selected person; truncates if the team is
              large. Does NOT change submit behavior. */}
          {toTeamId && teamSelected && (
            <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-ndark-border dark:bg-ndark-card/40">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-ndark-muted">
                  {teamSelected.name} ekibi
                </div>
                <div className="text-[10.5px] tabular-nums text-slate-500 dark:text-ndark-muted">
                  {personsForTeam.length} kişi
                </div>
              </div>
              {personsForTeam.length === 0 ? (
                <div className="mt-1 text-[11px] text-slate-500 dark:text-ndark-muted">
                  Bu takıma atanmış kişi yok — vaka takıma genel atanacak.
                </div>
              ) : (
                <ul className="mt-1.5 flex flex-wrap gap-1">
                  {personsForTeam.slice(0, 10).map((p) => {
                    const active = p.id === toPersonId;
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => setToPersonId(active ? '' : p.id)}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition ${
                            active
                              ? 'bg-brand-600 text-white ring-1 ring-brand-600'
                              : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-brand-300 dark:bg-ndark-bg dark:text-ndark-text dark:ring-ndark-border'
                          }`}
                          title={active ? 'Seçimi kaldır' : `Atanacak: ${p.name}`}
                        >
                          <User size={10} />
                          {p.name}
                        </button>
                      </li>
                    );
                  })}
                  {personsForTeam.length > 10 && (
                    <li className="text-[11px] text-slate-500 dark:text-ndark-muted">
                      +{personsForTeam.length - 10} daha
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          <Field label="Atanacak Kişi" hint="Boş bırakılırsa yalnız takım atanır.">
            <Select
              value={toPersonId}
              onChange={(e) => setToPersonId(e.target.value)}
              disabled={!toTeamId || personsForTeam.length === 0}
            >
              <option value="">{toTeamId ? '— takıma genel ata —' : 'Önce takım seç'}</option>
              {personsForTeam.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Aktarım Gerekçesi" required>
            <div className="flex flex-wrap gap-1.5">
              {REASON_CHIPS.map((chip) => {
                const active = reasonCode === chip.code;
                const isAi = aiSuggestion?.reasonCode === chip.code;
                return (
                  <button
                    key={chip.code}
                    type="button"
                    onClick={() => setReasonCode(chip.code)}
                    className={
                      'rounded-full border px-2.5 py-1 text-xs transition ' +
                      (active
                        ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-950/40 dark:text-brand-200'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-ndark-border dark:bg-ndark-card dark:text-ndark-muted')
                    }
                  >
                    {isAi ? '🤖 ' : ''}
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label="Açıklama"
            hint={
              reasonCode === 'other'
                ? `Zorunlu — en az ${MIN_REASON} karakter (mevcut: ${reasonText.trim().length}).`
                : 'Opsiyonel — yeni takıma ekstra bağlam.'
            }
            error={
              reasonCode === 'other' && reasonText.trim().length > 0 && reasonText.trim().length < MIN_REASON
                ? 'Çok kısa.'
                : reasonCode !== 'other' && reasonText.trim().length > 0 && reasonText.trim().length < MIN_REASON
                ? 'Çok kısa — boş bırakabilir veya birkaç kelime daha yazabilirsin.'
                : undefined
            }
          >
            <TextArea
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              rows={3}
              placeholder="Yeni takıma kısa bağlam — neden bu aktarım önerildi?"
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function AiSuggestionCard({
  suggestion,
  applied,
  onApply,
}: {
  suggestion: TransferSuggestion;
  applied: boolean;
  onApply: () => void;
}) {
  const conf = Math.round(suggestion.confidence * 100);
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-900/40 dark:text-violet-200 dark:ring-violet-900/50">
          <Bot size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-xs font-medium text-violet-900 dark:text-violet-100">
              RUNA AI Önerisi
            </div>
            <div className="text-[11px] tabular-nums text-violet-700 dark:text-violet-300">
              %{conf} güven
            </div>
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-ndark-text">
            {suggestion.suggestedTeamName}
          </div>
          <p className="mt-1 line-clamp-3 text-xs text-slate-700 dark:text-ndark-muted">
            “{suggestion.reasonText}”
          </p>
          <div className="mt-2">
            {applied ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/40">
                <Check size={12} /> Uygulandı
              </span>
            ) : (
              <Button size="sm" variant="outline" leftIcon={<Pencil size={12} />} onClick={onApply}>
                Öneriyi Uygula
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SuccessPanel({
  fromTeamName,
  toTeamName,
  briefLoading,
  brief,
}: {
  fromTeamName: string;
  toTeamName: string;
  briefLoading: boolean;
  brief: string | null;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
        <Check size={16} />
        <span>
          Vaka aktarıldı: <span className="line-through decoration-emerald-700/40">{fromTeamName}</span> →{' '}
          <span className="font-semibold">{toTeamName}</span>
        </span>
      </div>

      <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
        <div className="flex items-center gap-2 text-xs font-medium text-violet-900 dark:text-violet-100">
          <Sparkles size={14} />
          Devir Notu (RUNA AI)
        </div>
        {briefLoading ? (
          <div className="mt-2 space-y-1.5">
            <Skeleton height={12} width="95%" />
            <Skeleton height={12} width="80%" />
            <Skeleton height={12} width="88%" />
          </div>
        ) : brief ? (
          <div className="mt-2 whitespace-pre-line text-sm text-slate-800 dark:text-ndark-text">{brief}</div>
        ) : (
          <div className="mt-2 text-xs text-slate-600 dark:text-ndark-muted">
            Devir notu üretilemedi. Yeni takım vaka detayını okuyup süreci devam ettirebilir.
          </div>
        )}
      </div>
    </div>
  );
}
