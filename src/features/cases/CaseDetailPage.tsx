import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BellOff,
  Brain,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  ArrowRightLeft,
  ChevronRight,
  Clock,
  Clock3,
  Copy,
  Eye,
  CornerDownRight,
  Link as LinkIcon,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Download,
  FileText,
  History as HistoryIcon,
  Inbox,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Phone,
  Save,
  Send,
  ShieldAlert,
  SmilePlus,
  Sparkles,
  Star,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  UploadCloud,
  User,
  UserPlus,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Select, TextArea, TextInput } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { ActiveCallBanner } from '@/components/ui/ActiveCallBanner';
import { QuickNotePopover } from '@/components/ui/QuickNotePopover';
import { VoiceNoteButton } from '@/components/ui/VoiceNoteButton';
import { RunaAiCard } from '@/components/ui/RunaAiCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { CustomFieldRenderer } from '@/components/CustomFieldRenderer';
import { StatusTransitionPanel } from './StatusTransitionPanel';
import { ResolutionApprovalCard } from './components/ResolutionApprovalCard';
import { CommunicationDispatchCard } from './components/CommunicationDispatchCard';
import { TransferModal } from './components/TransferModal';
import { SnoozeModal } from './components/SnoozeModal';
import { MentionTextarea, type MentionTextareaHandle } from './components/MentionTextarea';
import { MentionContent } from './components/MentionContent';
import { CustomerPulsePanel } from './components/CustomerPulsePanel';
import { CaseTypeBadge, PriorityBadge, StatusPill } from '@/components/ui/StatusPill';
import { useToast } from '@/components/ui/Toast';
import {
  apiFetch,
  caseService,
  lookupService,
  type CustomerMatchSuggestion,
  type CustomerMatchSuggestionsResponse,
} from '@/services/caseService';
import { aiService, aiErrorMessage, type ChurnConversion } from '@/services/aiService';
import { accountService, type CaseCustomerContext } from '@/services/accountService';
import { AccountSearchPicker } from '@/features/accounts/AccountSearchPicker';
import { useAuth } from '@/services/AuthContext';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import {
  CALL_DISPOSITIONS,
  CALL_OUTCOMES,
  CASE_FIELD_LABELS,
  CASE_FILE_MAX_COUNT,
  CASE_FILE_MAX_SIZE,
  CASE_ORIGINS,
  CASE_REQUEST_TYPES,
  ESCALATION_LEVELS,
  ESCALATION_LEVEL_LABELS,
  FINANCIAL_STATUSES,
  OFFER_OUTCOMES,
  PRODUCT_USAGES,
  RESPONSE_LEVELS,
  SUPPORT_LEVELS,
  SUPPORT_LEVEL_LABELS,
  USAGE_CHANGE_ALERTS,
  type CallDisposition,
  type CallOutcome,
  type Case,
  type CaseFile,
  type CaseHistoryActionType,
  type CaseHistoryEntry,
  type CaseNote,
  type EscalationLevel,
  type NoteVisibility,
  type SupportLevel,
  NOTE_REACTION_EMOJIS,
  NOTE_REACTION_META,
  type NoteReactionEmoji,
} from './types';

type TabKey = 'detail' | 'activity' | 'notes' | 'files' | 'callLogs' | 'links';

interface CaseDetailPageProps {
  caseId: string;
  onBack: () => void;
  onShowCustomer?: (accountId: string) => void;
  /** "Müşteri Detayı'na git" linki — sadece canReadAccounts olan rollerde aktiftir. */
  onOpenAccount?: (accountId: string) => void;
}

export function CaseDetailPage({ caseId, onBack, onShowCustomer, onOpenAccount }: CaseDetailPageProps) {
  const { user } = useAuth();
  // Phase D — Sadece Supervisor+ müşteri eşleştirme aksiyonu görür.
  const canLinkAccount = !!user && ['Supervisor', 'CSM', 'Admin', 'SystemAdmin'].includes(user.role);
  const [item, setItem] = useState<Case | null>(null);
  const [loading, setLoading] = useState(false);
  const [customerContext, setCustomerContext] = useState<CaseCustomerContext | null>(null);
  const [activeId, setActiveId] = useState(caseId);

  // Breadcrumb stack — geçmiş vaka navigasyonu için (max 3 level)
  // Eski item'lar burada birikir; ana breadcrumb item'ı = activeId
  const [navStack, setNavStack] = useState<{ id: string; caseNumber: string; accountName: string }[]>([]);

  const [tab, setTab] = useState<TabKey>('detail');
  const [previousCases, setPreviousCases] = useState<Case[]>([]);
  const [callActive, setCallActive] = useState(false);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  // Phase D — Müşteri eşleştirme modal'ı (Supervisor+).
  const [linkAccountOpen, setLinkAccountOpen] = useState(false);
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [unsnoozing, setUnsnoozing] = useState(false);
  // Çağrı kaydı modal'ı — parent'ta tek instance. handleEndCall otomatik açar.
  const [callNoteModal, setCallNoteModal] = useState<{ open: boolean; prefillDurationMin?: number }>({
    open: false,
  });
  // Durum Raporu modal — header toolbar trigger; içerik self-fetch ile gelir.
  const [statusReportOpen, setStatusReportOpen] = useState(false);

  // Inline edit / drafts
  const [drafts, setDrafts] = useState<Partial<Case>>({});
  const [editingField, setEditingField] = useState<string | null>(null);
  const [savingDrafts, setSavingDrafts] = useState(false);

  // Status transition artık StatusTransitionPanel içinde (header popover kaldırıldı)

  // RUNA AI supervisor analyze — lifted to parent so the OperationalOverviewBand
  // (visible on all viewports) and the RightPanel (xl-only) share a SINGLE
  // source of truth. Without this, a user on a wide screen could double-fire
  // the supervisorSummary endpoint by clicking the band button and the right
  // rail button simultaneously.
  const [aiAnalyzing, setAiAnalyzing] = useState(false);

  // New note state
  const [noteText, setNoteText] = useState('');
  const [noteVisibility, setNoteVisibility] = useState<NoteVisibility>('Internal');
  const noteRef = useRef<MentionTextareaHandle>(null);

  const offeredSolutions = useMemo(() => lookupService.offeredSolutions(), []);
  // Phase C2: account bilgisi artık /api/cases/:id/customer-context'tan; bootstrap kullanılmıyor.
  const accounts = useMemo(() => lookupService.accounts(), []);
  const categories = useMemo(() => lookupService.categories(), []);
  const teams = useMemo(() => lookupService.teams(), []);
  const persons = useMemo(() => lookupService.persons(), []);
  const thirdParties = useMemo(() => lookupService.thirdParties(), []);
  const { toast } = useToast();

  // WR-A7b — Catalog state (Package + Product). Vakanın companyId/accountId'sine bağlı.
  const [catalogPackages, setCatalogPackages] = useState<
    Array<{ id: string; code: string; name: string; supportLevel: SupportLevel }>
  >([]);
  const [catalogProducts, setCatalogProducts] = useState<
    Array<{
      id: string;
      code: string;
      name: string;
      supportLevel: SupportLevel;
      productGroupId: string;
    }>
  >([]);

  // Parent caseId değişirse içerideki state ve breadcrumb sıfırlanır
  useEffect(() => {
    setActiveId(caseId);
    setNavStack([]);
    setDrafts({});
    setEditingField(null);
  }, [caseId]);

  useEffect(() => {
    let alive = true;
    if (!activeId) return;
    setLoading(true);
    void caseService.get(activeId).then((c) => {
      if (alive) {
        setItem(c ?? null);
        setLoading(false);
        setNoteText('');
        setNoteVisibility('Internal');
        setTab('detail');
      }
    });
    // Faz 1.5 Madde 3: vaka açıldığı an kullanıcının buradaki @mention'larını
    // seen yap. Header bell badge'i bu çağrıdan sonra refresh ile sayıyı düşürür.
    void caseService.markMentionsSeen(activeId).then(() => {
      window.dispatchEvent(new CustomEvent('app:mentions-changed'));
    });
    // Phase C2: customer-context — dış kod, paket, aktif ürünler, primary kontak.
    void accountService.getCaseCustomerContext(activeId).then((out) => {
      if (alive) setCustomerContext(out?.context ?? null);
    });
    return () => {
      alive = false;
    };
  }, [activeId]);

  // WR-A7b — Vakanın companyId/accountId'sine bağlı catalog lookup.
  useEffect(() => {
    let alive = true;
    if (!item?.companyId) {
      setCatalogPackages([]);
      setCatalogProducts([]);
      return;
    }
    void lookupService
      .caseCatalog({ companyId: item.companyId, accountId: item.accountId || null })
      .then((data) => {
        if (!alive) return;
        setCatalogPackages(data.packages);
        setCatalogProducts(data.products);
      });
    return () => {
      alive = false;
    };
  }, [item?.companyId, item?.accountId]);

  // Önceki vakalar (Çözüldü / İptalEdildi)
  useEffect(() => {
    let alive = true;
    if (!item) {
      setPreviousCases([]);
      return;
    }
    void caseService
      .findByAccount(item.accountId, {
        excludeId: item.id,
        statusIn: ['Çözüldü', 'İptalEdildi'],
      })
      .then((items) => {
        if (alive) {
          items.sort((a, b) => {
            const ta = new Date(a.resolvedAt ?? a.updatedAt).getTime();
            const tb = new Date(b.resolvedAt ?? b.updatedAt).getTime();
            return tb - ta;
          });
          setPreviousCases(items);
        }
      });
    return () => {
      alive = false;
    };
  }, [item]);

  const account = useMemo(
    () => (item ? accounts.find((a) => a.id === item.accountId) : undefined),
    [item, accounts],
  );

  async function handleAddNote() {
    if (!item || !noteText.trim()) return;
    const created = await caseService.addNote(item.id, {
      content: noteText.trim(),
      visibility: noteVisibility,
      authorName: 'Mock User',
    });
    if (created) {
      setItem({ ...item, notes: [created, ...item.notes] });
      setNoteText('');
      toast({
        type: 'success',
        message: noteVisibility === 'Internal' ? 'İç not eklendi.' : 'Müşteriye görünür not eklendi.',
        duration: 2500,
      });
    }
  }

  // Reply eklendiginde parent note'un replyCount alanini increment et —
  // case detail re-fetch etmeden badge guncellenir.
  function handleReplyAdded(parentNoteId: string) {
    if (!item) return;
    setItem({
      ...item,
      notes: item.notes.map((n) =>
        n.id === parentNoteId ? { ...n, replyCount: (n.replyCount ?? 0) + 1 } : n,
      ),
    });
  }

  function handleQuickActionAddNote() {
    setTab('notes');
    setTimeout(() => noteRef.current?.focus(), 50);
  }

  // Breadcrumb stack üzerinden geçmiş vakaya geçiş — Spec UX 4
  function navigateToCase(targetId: string) {
    if (!item || targetId === activeId) return;
    setNavStack((prev) => {
      const next = [...prev, { id: item.id, caseNumber: item.caseNumber, accountName: item.accountName }];
      // Max 3 level: en eski item düşer
      return next.length > 3 ? next.slice(next.length - 3) : next;
    });
    setActiveId(targetId);
    setDrafts({});
    setEditingField(null);
    setTab('detail');
  }

  function navigateToStackItem(index: number) {
    const target = navStack[index];
    if (!target) return;
    setActiveId(target.id);
    setNavStack((prev) => prev.slice(0, index));
    setDrafts({});
    setEditingField(null);
    setTab('detail');
  }

  // Inline edit handlers
  function commitDraft(field: keyof Case, value: unknown) {
    setDrafts((prev) => {
      let next: Record<string, unknown> = { ...(prev as Record<string, unknown>) };
      // Mevcut değerle aynıysa draft'ı kaldır
      if ((item as Record<string, unknown> | null)?.[field as string] === value) {
        delete next[field as string];
      } else {
        next[field as string] = value;
      }

      // Cascade temizleme: kategori değişince eskimiş alt kategori'yi düşür
      if (field === 'category') {
        const cat = categories.find((c) => c.category === value);
        const currentSub = (next.subCategory ?? item?.subCategory) as string | undefined;
        if (cat && currentSub && !cat.subCategories.includes(currentSub)) {
          // Alt kategori artık geçersiz — taslakta sıfırla (boş)
          next.subCategory = '';
        }
      }
      // Takım değişince eski kişi'yi düşür
      if (field === 'assignedTeamId') {
        const teamPersons = persons.filter((p) => p.teamId === value);
        const currentPersonId = (next.assignedPersonId ?? item?.assignedPersonId) as string | undefined;
        if (currentPersonId && !teamPersons.find((p) => p.id === currentPersonId)) {
          next.assignedPersonId = '';
          next.assignedPersonName = '';
        }
        // Takım adını da senkronize et (denormalized)
        const team = teams.find((t) => t.id === value);
        next.assignedTeamName = team?.name ?? '';
      }
      // Kişi değişince adını senkronize et
      if (field === 'assignedPersonId') {
        const person = persons.find((p) => p.id === value);
        next.assignedPersonName = person?.name ?? '';
      }
      // 3. parti seçilince adını senkronize et
      if (field === 'thirdPartyId') {
        const tp = thirdParties.find((t) => t.id === value);
        next.thirdPartyName = tp?.name ?? '';
      }

      return next as Partial<Case>;
    });
    setEditingField(null);
  }

  function cancelEdit() {
    setEditingField(null);
  }

  async function handleSaveDrafts() {
    if (!item || Object.keys(drafts).length === 0 || savingDrafts) return;
    setSavingDrafts(true);
    const updated = await caseService.update(item.id, drafts);
    setSavingDrafts(false);
    if (updated) {
      setItem(updated);
      setDrafts({});
      setEditingField(null);
      toast({ type: 'success', title: 'Vaka güncellendi ✓', message: `${Object.keys(drafts).length} alan kaydedildi.` });
    }
  }

  function handleDiscardDrafts() {
    setDrafts({});
    setEditingField(null);
  }

  // ESC = açık edit'i iptal et (ya da pending draft'ları sıfırla — kullanıcı seçimi)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (editingField) {
          setEditingField(null);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingField]);

  function handleStartCall() {
    setCallActive(true);
  }

  function handleEndCall(durationSec: number) {
    setCallActive(false);
    // Süreyi dakikaya yuvarla (her zaman >=1) — kullanıcı dilerse modal'da düzenler.
    const durationMin = Math.max(1, Math.round(durationSec / 60));
    setCallNoteModal({ open: true, prefillDurationMin: durationMin });
  }

  // WR-C1 — "Üstlen" / Claim handler. Race conflict 409 → apiFetch toast eder, undefined döner.
  const [claiming, setClaiming] = useState(false);
  async function handleClaim() {
    if (!item || claiming) return;
    setClaiming(true);
    const updated = await caseService.claimCase(item.id);
    setClaiming(false);
    if (updated) setItem(updated);
  }

  if (loading && !item) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Vaka yükleniyor…
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-500">
        <span>Vaka bulunamadı.</span>
        <Button variant="outline" size="sm" leftIcon={<ArrowLeft size={12} />} onClick={onBack}>
          Vakalar listesine dön
        </Button>
      </div>
    );
  }

  const isSnoozeActive = Boolean(
    item.snoozeUntil && new Date(item.snoozeUntil).getTime() > Date.now(),
  );

  // RUNA AI supervisor analyze — single source of truth shared between
  // OperationalOverviewBand and RightPanel. Identical request shape to the
  // previous RightPanel-local handler; preserves toast/error UX.
  async function handleAiAnalyze() {
    if (!item || aiAnalyzing) return;
    setAiAnalyzing(true);
    const r = await aiService.supervisorSummary({
      case: {
        title: item.title,
        description: item.description,
        category: item.category,
        subCategory: item.subCategory,
        status: item.status,
        priority: item.priority,
        slaViolation: item.slaViolation,
        slaResponseDueAt: item.slaResponseDueAt,
        slaResolutionDueAt: item.slaResolutionDueAt,
        slaPausedAt: item.slaPausedAt,
        createdAt: item.createdAt,
      },
      history: item.history,
      notes: item.notes,
      callLogs: item.callLogs,
    });
    if (!r.ok) {
      setAiAnalyzing(false);
      toast({ type: 'warn', message: aiErrorMessage(r.error), duration: 2500 });
      return;
    }
    const updated = await caseService.update(item.id, {
      aiSummary: r.data.summary,
      aiFollowupRecommendation: r.data.recommendation,
    });
    setAiAnalyzing(false);
    if (updated) {
      setItem(updated);
      toast({ type: 'success', message: 'Vaka analizi tamamlandı.', duration: 2000 });
    }
  }

  async function handleUnsnooze() {
    if (!item) return;
    setUnsnoozing(true);
    const updated = await apiFetch<Case>(
      `/api/cases/${item.id}/snooze`,
      { method: 'DELETE' },
      'Erteleme kaldırılamadı',
    );
    setUnsnoozing(false);
    if (!updated) return;
    setItem(updated);
    toast({ type: 'success', title: 'Erteleme kaldırıldı', message: 'Vaka tekrar açıldı.' });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — sticky */}
      <header className="border-b border-slate-200 bg-white dark:border-ndark-border dark:bg-ndark-card">
        <div className="flex items-start gap-4 px-6 py-3">
          {/* Mobile: hamburger for left panel */}
          <button
            type="button"
            onClick={() => setLeftDrawerOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 lg:hidden"
            title="Müşteri özeti"
          >
            <Inbox size={16} />
          </button>

          <button
            type="button"
            onClick={onBack}
            className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
            title="Vakalar listesine dön"
          >
            <ArrowLeft size={16} />
          </button>

          <div className="min-w-0 flex-1">
            <nav className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
              <button type="button" onClick={onBack} className="hover:text-brand-700 hover:underline">
                Vakalar
              </button>
              {navStack.map((entry, i) => (
                <span key={`${entry.id}-${i}`} className="flex items-center gap-1">
                  <ChevronRight size={11} className="text-slate-400" />
                  <button
                    type="button"
                    onClick={() => navigateToStackItem(i)}
                    className="font-mono text-slate-600 hover:text-brand-700 hover:underline"
                    title={entry.accountName}
                  >
                    {entry.caseNumber}
                  </button>
                </span>
              ))}
              <ChevronRight size={11} className="text-slate-400" />
              <span className="font-mono text-slate-700">{item.caseNumber}</span>
              <span className="text-slate-400">—</span>
              <span className="truncate text-slate-600">{item.accountName}</span>
            </nav>
            <h1 className="mt-0.5 truncate text-lg font-semibold text-slate-900 dark:text-ndark-text">{item.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {onShowCustomer && (
                <button
                  type="button"
                  onClick={() => onShowCustomer(item.accountId)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700 hover:border-brand-300 hover:bg-brand-50 dark:border-ndark-border dark:bg-ndark-card dark:text-ndark-text dark:hover:border-brand-500 dark:hover:bg-brand-950/30"
                >
                  <Building2 size={11} />
                  {item.accountName}
                </button>
              )}

              {/* StatusPill artık görsel/display-only — geçişler StatusTransitionPanel ile yapılıyor */}
              <StatusPill status={item.status} />

              {/* FAZ 2 Collab — kullanıcı bu vakada watcher mı? */}
              <WatcherHeaderBadge caseId={item.id} />

              <PriorityBadge priority={item.priority} />
              {item.slaViolation && (
                <Badge tint="rose" icon={<ShieldAlert size={12} />}>
                  SLA İhlali
                </Badge>
              )}
              {item.slaPausedAt && <Badge tint="amber">SLA Duraklatıldı</Badge>}
              {item.slaResolutionDueAt && !item.slaViolation && !item.slaPausedAt && (
                <Badge tint="slate" icon={<Clock size={12} />}>
                  Çözüm SLA {formatRelative(item.slaResolutionDueAt)}
                </Badge>
              )}
              <CaseTypeBadge type={item.caseType} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {Object.keys(drafts).length > 0 && (
              <button
                type="button"
                onClick={handleDiscardDrafts}
                className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
                title="Taslak değişiklikleri sil"
              >
                Taslakları sil
              </button>
            )}
            <Button
              variant={Object.keys(drafts).length > 0 ? 'primary' : 'outline'}
              size="sm"
              leftIcon={<Save size={12} />}
              disabled={Object.keys(drafts).length === 0 || savingDrafts}
              onClick={handleSaveDrafts}
              title={Object.keys(drafts).length > 0
                ? `${Object.keys(drafts).length} alan kaydedilecek`
                : 'Düzenlenmiş alan yok'}
            >
              {savingDrafts ? 'Kaydediliyor…' : `Kaydet${Object.keys(drafts).length > 0 ? ` (${Object.keys(drafts).length})` : ''}`}
            </Button>
            <Button
              size="sm"
              leftIcon={<Phone size={12} />}
              onClick={handleStartCall}
              disabled={callActive}
            >
              Çağrı Başlat
            </Button>
            <button
              type="button"
              onClick={() => setStatusReportOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-400 bg-white px-3 text-xs font-medium text-violet-700 transition hover:bg-violet-50 dark:border-violet-700 dark:bg-ndark-card dark:text-violet-300 dark:hover:bg-violet-950/40"
              title="Paydaşlara gönderilebilecek profesyonel özet"
            >
              <Sparkles size={12} />
              Durum Raporu
            </button>
            <Button
              variant="outline"
              size="sm"
              leftIcon={<UserPlus size={12} />}
              onClick={() => setTransferOpen(true)}
            >
              Devret
            </Button>
            {!isSnoozeActive && (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Clock3 size={12} />}
                onClick={() => setSnoozeOpen(true)}
                title="Vakayı ertele — opsiyonel olarak kişisel takvime de düşer"
              >
                Ertele
              </Button>
            )}
            <Popover
              align="end"
              width={200}
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-ndark-border dark:bg-ndark-card dark:text-ndark-muted dark:hover:bg-ndark-bg"
                  title="Daha fazla aksiyon"
                  aria-label="Daha fazla aksiyon"
                >
                  <MoreHorizontal size={14} />
                </button>
              )}
            >
              {({ close }) => (
                <ul className="text-sm">
                  <MenuAction
                    label="İptal Et"
                    onClick={() => {
                      close();
                      toast({ type: 'info', message: 'İptal akışı status popover üzerinden çalıştırılır.' });
                    }}
                  />
                  <MenuAction
                    label="Jira'ya Aktar"
                    onClick={() => {
                      close();
                      toast({ type: 'info', message: 'Jira entegrasyonu FAZ 2 kapsamında.' });
                    }}
                  />
                  <MenuAction
                    label="Yazdır"
                    onClick={() => {
                      close();
                      window.print();
                    }}
                  />
                </ul>
              )}
            </Popover>
          </div>
        </div>
      </header>

      {/* Active call banner */}
      {callActive && (
        <ActiveCallBanner
          customerName={item.accountName}
          customerPhone={account?.phone}
          caseId={item.id}
          onNoteAdded={(note) => setItem({ ...item, notes: [note, ...item.notes] })}
          onEnd={handleEndCall}
        />
      )}

      {/* Aktarım uyarısı — FAZ 2 §20.2: 2+ aktarımda kök neden analizi tetiklenir */}
      {(item.transferCount ?? 0) >= 2 && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          <ArrowRightLeft size={16} className="shrink-0 text-amber-700 dark:text-amber-400" />
          <div className="flex-1">
            <span className="font-medium">Bu vaka {item.transferCount} kez aktarıldı.</span>{' '}
            <span className="text-amber-800 dark:text-amber-300">
              RUNA AI kök neden analizini hazırladı — aktivite akışında "🔍 AI Kök Neden Analizi" satırına bak.
            </span>
          </div>
        </div>
      )}

      {/* Snooze banner — vakayı geçici olarak ertelendiğinde */}
      {isSnoozeActive && item.snoozeUntil && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900">
          <Clock3 size={16} className="shrink-0 text-amber-700" />
          <div className="flex-1">
            <span className="font-medium">Bu vaka ertelendi.</span>{' '}
            <span className="text-amber-800">
              {new Date(item.snoozeUntil).toLocaleString('tr-TR', {
                day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
              {item.snoozeReason && ` — ${{
                CustomerWillCall: 'Müşteri tekrar arayacak',
                WaitingThirdParty: '3. taraf bekleniyor',
                Reminder: 'Hatırlatıcı',
              }[item.snoozeReason]}`}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<BellOff size={12} />}
            disabled={unsnoozing}
            onClick={handleUnsnooze}
          >
            {unsnoozing ? 'Kaldırılıyor…' : 'Erteleme Kaldır'}
          </Button>
        </div>
      )}

      {/* Body — 3 columns */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Left panel */}
        <LeftPanel
          item={item}
          accountPhone={customerContext?.primaryContact?.phone ?? account?.phone}
          accountEmail={customerContext?.primaryContact?.email ?? account?.email}
          accountContact={customerContext?.primaryContact?.fullName ?? account?.contactPerson}
          customerContext={customerContext}
          onOpenAccount={onOpenAccount}
          canLinkAccount={canLinkAccount}
          onLinkAccount={canLinkAccount ? () => setLinkAccountOpen(true) : undefined}
          onConfirmLinkSuggestion={
            canLinkAccount
              ? async (suggestion) => {
                  // Manuel onay: confirm popup spec gereği zorunlu.
                  const ok = window.confirm(
                    `Bu vakayı "${suggestion.accountName}" müşterisine bağlamak istiyor musun?`,
                  );
                  if (!ok) return;
                  const updated = await caseService.linkAccount(item.id, suggestion.accountId);
                  if (updated) {
                    setItem(updated);
                    void accountService.getCaseCustomerContext(item.id).then((out) => {
                      setCustomerContext(out?.context ?? null);
                    });
                  }
                }
              : undefined
          }
          onStartCall={handleStartCall}
          onTransfer={() => setTransferOpen(true)}
          onClaim={handleClaim}
          claiming={claiming}
          canClaim={!!user?.personId && !item.assignedPersonId && item.status !== 'Çözüldü' && item.status !== 'İptalEdildi'}
          onNoteAdded={(note) => setItem({ ...item, notes: [note, ...item.notes] })}
          onTabFocusNote={handleQuickActionAddNote}
          callActive={callActive}
          drawerOpen={leftDrawerOpen}
          onCloseDrawer={() => setLeftDrawerOpen(false)}
        />

        {/* Main */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Operational overview band — visible on ALL viewports so the
              user never depends on the xl-only right rail for current
              state, ownership, SLA risk, or RUNA AI access. */}
          <OperationalOverviewBand
            item={item}
            customerContext={customerContext}
            aiAnalyzing={aiAnalyzing}
            onAiAnalyze={handleAiAnalyze}
          />
          <nav className="sticky top-0 z-10 flex shrink-0 gap-1 border-b border-slate-200 bg-white px-4 dark:border-ndark-border dark:bg-ndark-card">
            <TabButton
              active={tab === 'detail'}
              icon={<FileText size={14} />}
              label="Detay"
              onClick={() => setTab('detail')}
            />
            <TabButton
              active={tab === 'activity'}
              icon={<HistoryIcon size={14} />}
              label="Aktivite"
              count={item.history.length}
              onClick={() => setTab('activity')}
            />
            <TabButton
              active={tab === 'notes'}
              icon={<MessageSquare size={14} />}
              label="Notlar"
              count={item.notes.length}
              onClick={() => setTab('notes')}
            />
            <TabButton
              active={tab === 'files'}
              icon={<Paperclip size={14} />}
              label="Dosyalar"
              count={item.files.length}
              onClick={() => setTab('files')}
            />
            <TabButton
              active={tab === 'links'}
              icon={<LinkIcon size={14} />}
              label="Bağlantılar"
              onClick={() => setTab('links')}
            />
            {(item.caseType === 'ProactiveTracking' || item.caseType === 'Churn') && (
              <TabButton
                active={tab === 'callLogs'}
                icon={<Mic size={14} />}
                label="Çağrı Logları"
                count={item.callLogs.length}
                onClick={() => setTab('callLogs')}
              />
            )}
          </nav>

          <div className="flex-1 overflow-y-auto p-6">
            {tab === 'detail' && (
              <DetailTab
                item={item}
                offeredSolutions={offeredSolutions}
                categories={categories}
                teams={teams}
                persons={persons}
                thirdParties={thirdParties}
                catalogPackages={catalogPackages}
                catalogProducts={catalogProducts}
                previousCases={previousCases}
                onSelectPrevious={navigateToCase}
                drafts={drafts}
                editingField={editingField}
                onStartEdit={(f) => setEditingField(f)}
                onCancelEdit={cancelEdit}
                onCommitDraft={commitDraft}
                onTransitionApplied={(updated) => setItem(updated)}
              />
            )}
            {tab === 'activity' && <ActivityTab item={item} />}
            {tab === 'notes' && (
              <NotesTab
                item={item}
                noteText={noteText}
                noteVisibility={noteVisibility}
                onChangeText={setNoteText}
                onChangeVisibility={setNoteVisibility}
                onSubmit={handleAddNote}
                onReplyAdded={handleReplyAdded}
                inputRef={noteRef}
              />
            )}
            {tab === 'files' && (
              <FilesTab item={item} onItemUpdated={(c) => setItem(c)} />
            )}
            {tab === 'links' && (
              <LinksTab item={item} onShowCase={navigateToCase} />
            )}
            {tab === 'callLogs' && (
              <CallLogsTab
                item={item}
                onAddCallLog={() => setCallNoteModal({ open: true })}
              />
            )}
          </div>
        </main>

        {/* Right panel — RUNA AI + type-specific summary (xl+ only).
            Below xl, the OperationalOverviewBand above the tabs exposes
            RUNA AI + key signals so the main flow never depends solely
            on the right rail. */}
        <RightPanel
          item={item}
          offeredSolutions={offeredSolutions}
          onCaseUpdated={(updated) => setItem(updated)}
          aiAnalyzing={aiAnalyzing}
          onAiAnalyze={handleAiAnalyze}
        />

      </div>

      {/* Phase D — Müşteri Eşleştir modal'ı. Picker companyId case'in şirketiyle
          scoped; manuel onay (auto-link yok). Phase D Step 2'de öneri section'ı
          eklenecek; mevcut picker arama davranışı korunur. */}
      {canLinkAccount && (
        <AccountSearchPicker
          open={linkAccountOpen}
          companyId={item.companyId}
          selectedAccountId={item.accountId || null}
          allowNullSelection={false}
          onClose={() => setLinkAccountOpen(false)}
          onSelect={async (account) => {
            if (!account || linkSubmitting) return;
            setLinkSubmitting(true);
            const updated = await caseService.linkAccount(item.id, account.id);
            setLinkSubmitting(false);
            if (updated) {
              setItem(updated);
              setLinkAccountOpen(false);
              // Customer context'i yeniden çek — banner kaybolur, panel zenginleşir.
              void accountService.getCaseCustomerContext(item.id).then((out) => {
                setCustomerContext(out?.context ?? null);
              });
            }
          }}
        />
      )}

      {/* Vaka aktarımı modal'ı (FAZ 2 §20.2) — AI öneri + 3 step */}
      <TransferModal
        open={transferOpen}
        caseItem={item}
        onClose={() => setTransferOpen(false)}
        onTransferred={(updated) => setItem(updated)}
      />

      {/* Vaka erteleme modal'ı — içinde "Takvime ekle" checkbox'ı default ON,
          ayrı bir "Bana Hatırlat" akışına gerek bırakmıyor. */}
      <SnoozeModal
        open={snoozeOpen}
        caseId={item.id}
        caseTitle={item.title}
        onClose={() => setSnoozeOpen(false)}
        onSnoozed={(updated) => setItem(updated)}
      />

      {/* Çağrı kaydı modal'ı — parent'a yükseltildi:
          (1) handleEndCall otomatik açar (süre pre-fill);
          (2) Çağrı Logları sekmesindeki "Çağrı Notu Gir" butonu da aynı modal'ı açar. */}
      <NewCallLogModal
        open={callNoteModal.open}
        item={item}
        prefillDurationMin={callNoteModal.prefillDurationMin}
        onClose={() => setCallNoteModal({ open: false })}
        onCreated={(c) => {
          setItem(c);
          setCallNoteModal({ open: false });
        }}
      />

      {/* Durum Raporu modal — header toolbar'dan tetiklenir.
          Self-fetch; AI çağrısı modal açılınca yapılır. Persist edilmez. */}
      <StatusReportModal
        open={statusReportOpen}
        caseId={item.id}
        onClose={() => setStatusReportOpen(false)}
      />
    </div>
  );
}

// ----------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------

function MenuAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full px-3 py-1.5 text-left text-slate-700 hover:bg-slate-100"
      >
        {label}
      </button>
    </li>
  );
}

/**
 * OperationalOverviewBand — sits above the tabs on every viewport.
 *
 * Purpose: in <1 second the operator should see current state, who owns
 * it, SLA pressure, escalation/churn signals, and RUNA AI access without
 * needing the xl-only right rail.
 *
 * No business logic. Aggregates display data already on `item` /
 * `customerContext`. RUNA Analyze button uses the SAME lifted handler
 * (handleAiAnalyze) as the right rail — see CaseDetailPage doc.
 */
function OperationalOverviewBand({
  item,
  customerContext,
  aiAnalyzing,
  onAiAnalyze,
}: {
  item: Case;
  customerContext: CaseCustomerContext | null;
  aiAnalyzing: boolean;
  onAiAnalyze: () => void;
}) {
  const escalationActive = item.escalationLevel && item.escalationLevel !== 'Yok';
  const slaResolutionRel = item.slaResolutionDueAt
    ? formatRelative(item.slaResolutionDueAt)
    : null;

  // Compact RUNA AI summary preview — 1-line clamp, full text on hover.
  const aiPreview = item.aiSummary
    ? item.aiSummary.length > 90
      ? `${item.aiSummary.slice(0, 90)}…`
      : item.aiSummary
    : null;

  return (
    <section className="shrink-0 border-b border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-ndark-border dark:bg-ndark-bg/30">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
        {/* Left cluster — state + ownership + signals */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-1 ring-1 ring-slate-200 dark:bg-ndark-card dark:ring-ndark-border">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Statü
            </span>
            <StatusPill status={item.status} />
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-ndark-text">
            <Building2 size={12} className="text-slate-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Takım
            </span>
            <span className="truncate max-w-[180px]" title={item.assignedTeamName ?? ''}>
              {item.assignedTeamName ?? '—'}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-ndark-text">
            <User size={12} className="text-slate-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Atanan
            </span>
            <span className="truncate max-w-[180px]" title={item.assignedPersonName ?? ''}>
              {item.assignedPersonName ?? 'Atanmamış'}
            </span>
          </span>
          {item.slaViolation ? (
            <Badge tint="rose" icon={<ShieldAlert size={11} />} className="text-[10.5px]">
              SLA İhlali
            </Badge>
          ) : item.slaPausedAt ? (
            <Badge tint="amber" className="text-[10.5px]">SLA Duraklatıldı</Badge>
          ) : slaResolutionRel ? (
            <Badge tint="slate" icon={<Clock size={11} />} className="text-[10.5px]">
              SLA {slaResolutionRel}
            </Badge>
          ) : null}
          {item.priority === 'Critical' && (
            <Badge tint="rose" className="text-[10.5px]">Critical</Badge>
          )}
          {escalationActive && (
            <Badge tint="amber" className="text-[10.5px]">
              Eskalasyon: {ESCALATION_LEVEL_LABELS[item.escalationLevel]}
            </Badge>
          )}
          {item.approvalState === 'Pending' && (
            <Badge tint="violet" className="text-[10.5px]">Onay bekliyor</Badge>
          )}
          {item.approvalState === 'Rejected' && (
            <Badge tint="rose" className="text-[10.5px]">Onay reddedildi</Badge>
          )}
          {customerContext && !customerContext.isActive && (
            <Badge tint="slate" className="text-[10.5px]">Müşteri pasif</Badge>
          )}
        </div>

        {/* Right cluster — RUNA AI compact entry */}
        <div className="flex shrink-0 items-center gap-2">
          {aiPreview ? (
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-violet-200 bg-violet-50/60 px-2.5 py-1.5 text-xs dark:border-violet-900/40 dark:bg-violet-950/20">
              <Sparkles size={12} className="shrink-0 text-violet-600 dark:text-violet-300" />
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                  RUNA AI
                </div>
                <div
                  className="truncate text-[11.5px] text-slate-800 dark:text-ndark-text"
                  title={item.aiSummary ?? ''}
                >
                  {aiPreview}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={onAiAnalyze}
                disabled={aiAnalyzing}
                title="Yeniden analiz başlat"
              >
                {aiAnalyzing ? '✦ Analiz ediyor…' : '✦ Yenile'}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              leftIcon={<Sparkles size={12} />}
              onClick={onAiAnalyze}
              disabled={aiAnalyzing}
              title="RUNA AI vaka analizi başlat"
            >
              {aiAnalyzing ? 'RUNA analiz ediyor…' : 'RUNA AI Analiz Et'}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function TabButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors ${
        active
          ? 'border-brand-600 text-brand-700'
          : 'border-transparent text-slate-600 hover:text-slate-800'
      }`}
    >
      {icon}
      {label}
      {count != null && count > 0 && (
        <span className="rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-600">{count}</span>
      )}
    </button>
  );
}

function LeftPanel({
  item,
  accountPhone,
  accountEmail,
  accountContact,
  customerContext,
  onOpenAccount,
  canLinkAccount,
  onLinkAccount,
  onConfirmLinkSuggestion,
  onStartCall,
  onTransfer,
  onClaim,
  claiming,
  canClaim,
  onNoteAdded,
  onTabFocusNote,
  callActive,
  drawerOpen,
  onCloseDrawer,
}: {
  item: Case;
  accountPhone?: string;
  accountEmail?: string;
  accountContact?: string;
  customerContext: CaseCustomerContext | null;
  onOpenAccount?: (accountId: string) => void;
  canLinkAccount?: boolean;
  onLinkAccount?: () => void;
  onConfirmLinkSuggestion?: (suggestion: CustomerMatchSuggestion) => Promise<void>;
  onStartCall: () => void;
  onTransfer: () => void;
  /** WR-C1 — Üstlen click handler (parent state'i günceller). */
  onClaim: () => void;
  /** WR-C1 — Claim akışı çalışırken disabled + spinner için. */
  claiming: boolean;
  /** WR-C1 — Vaka açık + atanmamış + user.personId varsa true. */
  canClaim: boolean;
  onNoteAdded: (note: import('./types').CaseNote) => void;
  onTabFocusNote: () => void;
  callActive: boolean;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}) {
  const ctxCompany = customerContext?.company ?? null;
  const content = (
    <div className="space-y-4">
      <PanelSection title="Müşteri" icon={<Building2 size={12} />}>
        <div className="space-y-1.5">
          {item.accountId ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-ndark-text">
                    {customerContext?.accountName ?? item.accountName}
                  </div>
                  {customerContext?.vknMasked && (
                    <div className="font-mono text-[11px] text-slate-500 dark:text-ndark-muted">
                      VKN {customerContext.vknMasked}
                    </div>
                  )}
                </div>
                {onOpenAccount && (
                  <button
                    type="button"
                    onClick={() => onOpenAccount(item.accountId as string)}
                    title="Müşteri Detayı'na git"
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-900/30"
                  >
                    Detay →
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tint="slate">{item.companyName}</Badge>
                {ctxCompany?.externalCustomerCode && (
                  <span
                    title="Müşteri Dış Kodu"
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-ndark-surface dark:text-ndark-muted"
                  >
                    Kod {ctxCompany.externalCustomerCode}
                  </span>
                )}
                {ctxCompany?.packageName && <Badge tint="indigo">{ctxCompany.packageName}</Badge>}
                {/* WR-A4 / PM-04 — Bağlı proje badge'i. */}
                {item.accountProjectName && (
                  <span title="Bağlı proje">
                    <Badge tint="violet">Proje: {item.accountProjectName}</Badge>
                  </span>
                )}
                {/* WR-A7b / PM-05 — Catalog ürün ve paket badge'leri. */}
                {item.packageName && (
                  <span title="Vakaya bağlı catalog paketi">
                    <Badge tint="indigo">Paket: {item.packageName}</Badge>
                  </span>
                )}
                {item.productName && (
                  <span title="Vakaya bağlı ürün">
                    <Badge tint="blue">Ürün: {item.productName}</Badge>
                  </span>
                )}
                {/* WR-A5 / PM-03 — Destek seviyesi badge'i. */}
                {item.supportLevel && (
                  <span title="Destek seviyesi">
                    <Badge tint={item.supportLevel === 'L1' ? 'slate' : 'amber'}>
                      {SUPPORT_LEVEL_LABELS[item.supportLevel] ?? item.supportLevel}
                    </Badge>
                  </span>
                )}
                <Badge tint={item.priority === 'Critical' ? 'rose' : 'blue'}>
                  {item.priority}
                </Badge>
              </div>
              {ctxCompany?.activeProducts && ctxCompany.activeProducts.length > 0 && (
                <div className="pt-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-ndark-dim">
                    Aktif Ürünler
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {ctxCompany.activeProducts.slice(0, 6).map((p) => (
                      <Badge key={p.id} tint="teal">
                        <span className="max-w-[140px] truncate">{p.productName}</span>
                        {p.productCode && (
                          <span className="ml-1 font-mono opacity-80">{p.productCode}</span>
                        )}
                      </Badge>
                    ))}
                    {ctxCompany.activeProducts.length > 6 && (
                      <span className="text-[10px] text-slate-500 dark:text-ndark-muted">
                        +{ctxCompany.activeProducts.length - 6}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {accountPhone && (
                <div className="flex items-center gap-1.5 pt-1 text-xs text-slate-600 dark:text-ndark-muted">
                  <Phone size={11} />
                  {accountPhone}
                </div>
              )}
              {accountEmail && (
                <div className="truncate text-[11px] text-slate-500 dark:text-ndark-muted">
                  {accountEmail}
                </div>
              )}
              {accountContact && (
                <div className="text-[11px] text-slate-500 dark:text-ndark-muted">
                  Yetkili: {accountContact}
                  {customerContext?.primaryContact?.title && (
                    <span className="ml-1 text-slate-400 dark:text-ndark-dim">
                      ({customerContext.primaryContact.title})
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
                  <div className="min-w-0">
                    <div className="font-medium">Bu vakaya henüz müşteri eşleştirilmedi.</div>
                    {!canLinkAccount && (
                      <div className="mt-0.5 text-[11px] opacity-80">
                        Eşleştirme için Supervisor veya Admin yetkisi gerekir.
                      </div>
                    )}
                  </div>
                </div>
                {canLinkAccount && onLinkAccount && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<Search size={12} />}
                    onClick={onLinkAccount}
                    className="w-full justify-center border-amber-300 bg-white text-amber-900 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/40"
                  >
                    Manuel müşteri ara
                  </Button>
                )}
              </div>
              {/* Phase D Step 2 — Başvuran bilgileri (müşterisiz intake context). */}
              {(item.customerCompanyName ||
                item.customerContactName ||
                item.customerContactPhone ||
                item.customerContactEmail) && (
                <div className="rounded-md border border-slate-200 px-3 py-2 text-[11px] text-slate-700 dark:border-ndark-border dark:text-ndark-text">
                  <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500 dark:text-ndark-muted">
                    Başvuran Bilgileri
                  </div>
                  <dl className="space-y-0.5">
                    {item.customerCompanyName && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500 dark:text-ndark-muted">Firma</dt>
                        <dd className="truncate">{item.customerCompanyName}</dd>
                      </div>
                    )}
                    {item.customerContactName && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500 dark:text-ndark-muted">Ad Soyad</dt>
                        <dd className="truncate">{item.customerContactName}</dd>
                      </div>
                    )}
                    {item.customerContactPhone && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500 dark:text-ndark-muted">Telefon</dt>
                        <dd className="truncate">{item.customerContactPhone}</dd>
                      </div>
                    )}
                    {item.customerContactEmail && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500 dark:text-ndark-muted">E-posta</dt>
                        <dd className="truncate">{item.customerContactEmail}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}

              {/* Phase D Step 2 — Önerilen müşteriler. Yalnız Supervisor+. */}
              {canLinkAccount && onConfirmLinkSuggestion && (
                <CustomerMatchSuggestionsPanel
                  caseId={item.id}
                  onConfirmLink={onConfirmLinkSuggestion}
                />
              )}
            </div>
          )}
        </div>
      </PanelSection>

      {/* Customer Pulse — müşterinin geniş durumu (Roadmap §"Customer Context
          Intelligence"). Self-fetch; hata olursa case detail bozulmaz. */}
      <CustomerPulsePanel source={{ kind: 'case', caseId: item.id }} />

      <PanelSection title="SLA Durumu" icon={<Clock size={12} />}>
        <div className="space-y-1.5 text-xs">
          <SlaRow label="Yanıt SLA" value={item.slaResponseDueAt ? formatDateTime(item.slaResponseDueAt) : '—'} />
          <SlaRow
            label="Çözüm SLA"
            value={item.slaResolutionDueAt ? formatDateTime(item.slaResolutionDueAt) : '—'}
          />
          {item.slaResolutionDueAt && !item.slaViolation && !item.slaPausedAt && (
            <div className="rounded-md bg-blue-50 px-2 py-1 text-[11px] text-blue-800 ring-1 ring-blue-200">
              Çözüme {formatRelative(item.slaResolutionDueAt)}
            </div>
          )}
          {item.slaViolation && (
            <div className="rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-800 ring-1 ring-rose-200">
              <ShieldAlert size={11} className="mr-1 inline" />
              SLA İhlali aktif
            </div>
          )}
          {item.slaPausedAt && (
            <div className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 ring-1 ring-amber-200">
              SLA duraklatıldı ({formatRelative(item.slaPausedAt)})
            </div>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Atama" icon={<User size={12} />}>
        <div className="space-y-1 text-xs">
          <Row label="Vaka Sahibi" value={item.assignedPersonName ?? 'Atanmadı'} />
          <Row label="Takım" value={item.assignedTeamName ?? '—'} />
          <Row label="Eskalasyon" value={ESCALATION_LEVEL_LABELS[item.escalationLevel]} />
          {/* WR-C1 — Atanmamış + açık vakalar için "Üstlen" butonu. */}
          {canClaim && (
            <button
              type="button"
              onClick={onClaim}
              disabled={claiming}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-brand-300 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-950/30 dark:text-brand-200 dark:hover:bg-brand-950/50"
              title="Bu vakayı üstlen"
            >
              {claiming ? 'Üstleniliyor…' : 'Üstlen'}
            </button>
          )}
        </div>
      </PanelSection>

      {/* FAZ 2 Collab — izleyiciler. Self-watch + Supervisor başkasını ekleyebilir. */}
      <WatchersPanel caseId={item.id} assignedPersonId={item.assignedPersonId ?? null} />

      <PanelSection title="Hızlı Aksiyonlar" icon={<Sparkles size={12} />}>
        <div className="grid grid-cols-1 gap-1.5">
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Phone size={12} />}
            onClick={onStartCall}
            disabled={callActive}
          >
            {callActive ? 'Çağrı aktif' : 'Çağrı Başlat'}
          </Button>
          <Button size="sm" variant="outline" leftIcon={<UserPlus size={12} />} onClick={onTransfer}>
            Devret
          </Button>
          <QuickNotePopover
            caseId={item.id}
            align="start"
            width={280}
            onAdded={onNoteAdded}
            trigger={({ toggle }) => (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<MessageSquare size={12} />}
                onClick={toggle}
              >
                Hızlı Not
              </Button>
            )}
          />
          <button
            type="button"
            onClick={onTabFocusNote}
            className="text-[11px] text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
          >
            Tüm not akışını aç →
          </button>
        </div>
      </PanelSection>

    </div>
  );

  return (
    <>
      <aside className="hidden w-[320px] shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50/40 p-4 lg:block">
        {content}
      </aside>
      {drawerOpen && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/30" onClick={onCloseDrawer} />
          <aside className="absolute left-0 top-0 h-full w-[320px] overflow-y-auto bg-white p-4 shadow-xl dark:bg-ndark-bg">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-ndark-muted">Müşteri Özeti</span>
              <button
                type="button"
                onClick={onCloseDrawer}
                aria-label="Müşteri özeti panelini kapat"
                className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:text-ndark-muted dark:hover:bg-ndark-card"
              >
                ✕
              </button>
            </div>
            {content}
          </aside>
        </div>
      )}
    </>
  );
}

function RightPanel({
  item,
  offeredSolutions,
  onCaseUpdated,
  aiAnalyzing,
  onAiAnalyze,
}: {
  item: Case;
  offeredSolutions: { id: string; name: string }[];
  onCaseUpdated: (updated: Case) => void;
  /** Supervisor analyze state — lifted to CaseDetailPage so the
   *  OperationalOverviewBand and this panel share a single source of
   *  truth and cannot double-fire the supervisorSummary endpoint. */
  aiAnalyzing: boolean;
  onAiAnalyze: () => void;
}) {
  const { toast } = useToast();
  const [churnAnalyzing, setChurnAnalyzing] = useState(false);
  const [churnResult, setChurnResult] = useState<ChurnConversion | null>(null);
  const [converting, setConverting] = useState(false);

  // Vaka değişince churn preview state'ini sıfırla
  useEffect(() => {
    setChurnResult(null);
  }, [item.id]);

  async function handleChurnAnalysis() {
    setChurnAnalyzing(true);
    const r = await aiService.churnConversion({
      case: { title: item.title, companyName: item.companyName, accountName: item.accountName },
      callLogs: item.callLogs,
      financialStatus: item.financialStatus,
      productUsage: item.productUsage,
      usageChangeAlert: item.usageChangeAlert,
    });
    setChurnAnalyzing(false);
    if (r.ok) {
      setChurnResult(r.data);
    } else {
      toast({ type: 'warn', message: aiErrorMessage(r.error), duration: 2500 });
    }
  }

  async function handleConvertToChurn() {
    if (!churnResult) return;
    if (!window.confirm('Vakayı Churn tipine dönüştürmek istediğinizden emin misiniz?')) return;
    setConverting(true);
    const updated = await caseService.update(item.id, {
      caseType: 'Churn',
      aiRetentionOfferSuggestion: churnResult.suggestedAction,
    });
    setConverting(false);
    if (updated) {
      onCaseUpdated(updated);
      toast({ type: 'success', message: 'Vaka Churn tipine dönüştürüldü.', duration: 2200 });
    }
  }

  return (
    <aside className="hidden w-[360px] shrink-0 overflow-y-auto border-l border-slate-200 bg-slate-50/40 p-4 xl:block">
      <div className="space-y-4">
        {/* RUNA AI — Vaka özeti / analiz */}
        <RunaAiCard
          title={item.aiSummary ? 'Vaka Özeti' : 'RUNA AI Hazır'}
          body={item.aiSummary ?? 'Bu vaka için henüz AI analizi yapılmadı.'}
          isLoading={aiAnalyzing}
          badges={
            item.aiConfidenceScore != null
              ? [`%${Math.round(item.aiConfidenceScore * 100)} güven`]
              : []
          }
          primaryAction={
            !aiAnalyzing
              ? {
                  label: item.aiSummary ? '✦ Yeniden Analiz Et' : '✦ Analiz Et',
                  onClick: onAiAnalyze,
                }
              : undefined
          }
        />

        {/* AI ek detaylar (varsa) — RUNA AI'ın altında ek context olarak */}
        {(item.aiCategoryPrediction ||
          item.aiPriorityPrediction ||
          item.aiCallBrief ||
          item.aiFollowupRecommendation ||
          item.aiRetentionOfferSuggestion ||
          item.aiRejectReason) && (
          <PanelSection title="AI Detayları" icon={<Brain size={12} />}>
            <div className="space-y-3 text-xs">
              {(item.aiCategoryPrediction || item.aiPriorityPrediction) && (
                <div className="grid grid-cols-2 gap-2">
                  <AiTile
                    label="Kategori önerisi"
                    value={item.aiCategoryPrediction ?? '—'}
                    tint="indigo"
                  />
                  <AiTile
                    label="Öncelik önerisi"
                    value={item.aiPriorityPrediction ?? '—'}
                    tint="indigo"
                  />
                </div>
              )}
              {item.aiCallBrief && (
                <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Çağrı Özeti
                  </div>
                  {item.aiCallBrief}
                </div>
              )}
              {item.aiFollowupRecommendation && (
                <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Takip Önerisi
                  </div>
                  {item.aiFollowupRecommendation}
                </div>
              )}
              {item.aiRetentionOfferSuggestion && (
                <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-900 ring-1 ring-rose-200">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                    Retention Teklif Önerisi
                  </div>
                  {item.aiRetentionOfferSuggestion}
                </div>
              )}
              {item.aiRejectReason && (
                <div className="rounded-md bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600 ring-1 ring-slate-200">
                  <strong>Önceki red:</strong> {item.aiRejectReason}
                </div>
              )}
            </div>
          </PanelSection>
        )}

        {/* QA Skor — Faz 1.5 Madde 4. Kapatılmış vakada AI değerlendirmesi varsa göster. */}
        {item.qaScoredAt && item.qaEmpathyScore != null && (
          <PanelSection title="AI QA Skoru" icon={<Star size={12} />} tint="amber">
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-3 gap-1.5">
                <QaScorePill label="Empati" value={item.qaEmpathyScore} />
                <QaScorePill label="Netlik" value={item.qaClarityScore ?? 0} />
                <QaScorePill label="Hız" value={item.qaSpeedScore ?? 0} />
              </div>
              {item.qaFeedback && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/40">
                  {item.qaFeedback}
                </p>
              )}
              <div className="text-[10px] text-slate-400 dark:text-ndark-muted">
                {formatRelative(item.qaScoredAt)} skorlanmış
              </div>
            </div>
          </PanelSection>
        )}

        {item.caseType === 'ProactiveTracking' && (
          <>
            <PanelSection title="Proaktif Takip" icon={<TrendingDown size={12} />} tint="violet">
              <div className="space-y-1 text-xs">
                <Row label="Finansal Risk"      value={item.financialStatus ?? '—'} />
                <Row label="Ürün Kullanımı"     value={item.productUsage ?? '—'} />
                <Row label="Kullanım Trendi"    value={item.usageChangeAlert ?? '—'} />
                <Row label="Müdahale Önceliği"  value={item.responseLevel ?? '—'} />
                <Row label="Toplam Çağrı"       value={String(item.callLogs.length)} />
              </div>
            </PanelSection>

            {/* RUNA AI — Churn risk değerlendirmesi */}
            <RunaAiCard
              title="Churn Risk Değerlendirmesi"
              body={
                churnResult?.reasoning ??
                'Churn riskini değerlendirmek için analiz başlatın. Finansal durum, ürün kullanımı ve arama geçmişi incelenir.'
              }
              badges={
                churnResult
                  ? [
                      `Risk: ${churnResult.churnRisk}`,
                      churnResult.shouldConvert ? 'Dönüşüm önerilir' : 'Bekle',
                    ]
                  : []
              }
              isLoading={churnAnalyzing}
              primaryAction={
                !churnResult && !churnAnalyzing
                  ? { label: '✦ Değerlendir', onClick: () => void handleChurnAnalysis() }
                  : undefined
              }
              dangerAction={
                churnResult?.shouldConvert
                  ? {
                      label: converting ? 'Dönüştürülüyor…' : "Churn'e Dönüştür",
                      onClick: () => void handleConvertToChurn(),
                      disabled: converting,
                    }
                  : undefined
              }
              secondaryAction={
                churnResult
                  ? { label: 'Yeniden', onClick: () => void handleChurnAnalysis() }
                  : undefined
              }
            />
          </>
        )}

        {item.caseType === 'Churn' && (
          <PanelSection title="Churn Yönetimi" icon={<Wallet size={12} />} tint="rose">
            <div className="space-y-2 text-xs">
              <Row label="İptal Talebi"    value={item.cancellationRequest ? 'Var' : 'Yok'} />
              <Row label="Teklif Sonucu"   value={item.offerOutcome ?? '—'} />
              <Row label="Churn Sonucu"    value={item.churnResult ?? '—'} />
              <Row label="Retention"       value={item.retentionStatus ?? '—'} />
              {item.followUpDate && (
                <Row label="Takip Tarihi" value={formatDateTime(item.followUpDate)} />
              )}
              {item.offeredSolutions && item.offeredSolutions.length > 0 && (
                <div className="space-y-1 pt-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                    Sunulan Teklifler
                  </div>
                  {item.offeredSolutions.map((id) => {
                    const def = offeredSolutions.find((o) => o.id === id);
                    return (
                      <div key={id} className="rounded bg-white px-2 py-1 text-slate-700 ring-1 ring-rose-200">
                        {def?.name ?? id}
                      </div>
                    );
                  })}
                </div>
              )}
              {item.offerRejectionReason && (
                <div className="rounded-md bg-rose-50 px-2 py-1.5 text-rose-900 ring-1 ring-rose-200">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                    Red Gerekçesi
                  </div>
                  {item.offerRejectionReason}
                </div>
              )}
            </div>
          </PanelSection>
        )}
      </div>
    </aside>
  );
}

// Customer Pulse component shared module'a taşındı:
// src/features/cases/components/CustomerPulsePanel.tsx
// CaseDetailPage <CustomerPulsePanel source={{ kind: 'case', caseId }} />
// NewCaseForm <CustomerPulsePanel source={{ kind: 'account', accountId, companyId }} />


// ──────────────────────────────────────────────────────────────
// Watcher header badge — kullanıcı bu vakanın izleyicisiyse status
// pill'inin yanında "İzliyorsunuz" göstergesi. Self-fetch + custom
// event ile WatchersPanel ile senkron.
// ──────────────────────────────────────────────────────────────

function WatcherHeaderBadge({ caseId }: { caseId: string }) {
  const { user } = useAuth();
  const [isWatching, setIsWatching] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsWatching(false);
      return;
    }
    let alive = true;
    async function check() {
      const watchers = await caseService.listWatchers(caseId);
      if (alive && user) setIsWatching(watchers.some((w) => w.userId === user.id));
    }
    void check();

    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ caseId?: string }>).detail;
      if (!detail || detail.caseId === caseId) void check();
    };
    window.addEventListener('app:watcher-changed', onChanged);
    return () => {
      alive = false;
      window.removeEventListener('app:watcher-changed', onChanged);
    };
  }, [caseId, user]);

  if (!isWatching) return null;
  return (
    <Badge tint="violet" icon={<Eye size={11} />}>
      İzliyorsunuz
    </Badge>
  );
}

// ──────────────────────────────────────────────────────────────
// Watchers panel — FAZ 2 Collab. LeftPanel'in altında, ATAMA section'undan
// hemen sonra. Self-watch toggle + Supervisor başkalarını ekleyebilir.
// ──────────────────────────────────────────────────────────────

function WatchersPanel({
  caseId,
  assignedPersonId,
}: {
  caseId: string;
  assignedPersonId: string | null;
}) {
  const { user } = useAuth();
  const [watchers, setWatchers] = useState<import('./types').CaseWatcherRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Yetki: başkasını ekleyebilen kullanıcı?
  // Supervisor+ her zaman; Agent yalnız atanmış olduğu vakaya başkasını ekleyebilir.
  const elevated = !!user && ['Supervisor', 'Admin', 'SystemAdmin'].includes(user.role);
  const isAssignedOwner = !!user?.personId && assignedPersonId === user.personId;
  const canAddOthers = elevated || isAssignedOwner;

  async function reload() {
    setLoading(true);
    const rows = await caseService.listWatchers(caseId);
    setWatchers(rows);
    setLoading(false);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const meWatching = !!user && watchers.some((w) => w.userId === user.id);

  function dispatchChanged() {
    // Header'daki badge'in tazelenmesi için sinyal
    window.dispatchEvent(new CustomEvent('app:watcher-changed', { detail: { caseId } }));
  }

  async function toggleSelf() {
    if (!user || busy) return;
    setBusy(true);
    if (meWatching) {
      const r = await caseService.removeWatcher(caseId, user.id);
      if (r) {
        setWatchers((ws) => ws.filter((w) => w.userId !== user.id));
        dispatchChanged();
      }
    } else {
      const r = await caseService.addWatcher(caseId, user.id);
      if (r) {
        await reload();
        dispatchChanged();
      }
    }
    setBusy(false);
  }

  async function removeWatcher(userId: string) {
    if (busy) return;
    setBusy(true);
    const r = await caseService.removeWatcher(caseId, userId);
    if (r) {
      setWatchers((ws) => ws.filter((w) => w.userId !== userId));
      dispatchChanged();
    }
    setBusy(false);
  }

  return (
    <PanelSection title="İzleyiciler" icon={<Eye size={12} />}>
      {loading ? (
        <div className="space-y-1.5">
          <Skeleton height={12} width="60%" />
          <Skeleton height={12} width="80%" />
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* Avatar stack — max 5, +N more rozet */}
          {watchers.length === 0 ? (
            <p className="text-[11px] text-slate-500 dark:text-ndark-muted">
              Henüz izleyici yok.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {watchers.slice(0, 5).map((w) => {
                const canRemove = (user?.id === w.userId) || elevated;
                return (
                  <button
                    key={w.userId}
                    type="button"
                    onClick={canRemove ? () => removeWatcher(w.userId) : undefined}
                    disabled={!canRemove || busy}
                    title={canRemove ? `${w.userName} — Kaldır` : w.userName}
                    className={
                      'rounded-full ring-2 ring-white transition dark:ring-ndark-card ' +
                      (canRemove ? 'hover:scale-105 hover:ring-rose-300' : 'cursor-default')
                    }
                  >
                    <NoteAvatar name={w.userName} size={28} />
                  </button>
                );
              })}
              {watchers.length > 5 && (
                <span
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-[10px] font-medium text-slate-600 ring-2 ring-white dark:bg-ndark-bg dark:text-ndark-muted dark:ring-ndark-card"
                  title={watchers.slice(5).map((w) => w.userName).join(', ')}
                >
                  +{watchers.length - 5}
                </span>
              )}
              {canAddOthers && (
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  disabled={busy}
                  title="İzleyici Ekle"
                  aria-label="İzleyici Ekle"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-500 transition hover:border-brand-400 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-ndark-border dark:text-ndark-muted dark:hover:border-brand-500"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          )}

          {/* Self-watch toggle */}
          <button
            type="button"
            onClick={toggleSelf}
            disabled={busy || !user}
            className={
              'inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ' +
              (meWatching
                ? 'border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/30 dark:text-brand-300'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-ndark-border dark:bg-ndark-card dark:text-ndark-text dark:hover:bg-ndark-bg')
            }
          >
            {meWatching ? (
              <>
                <Eye size={12} /> İzliyorum
              </>
            ) : (
              <>
                <Eye size={12} /> İzle
              </>
            )}
          </button>

          {addOpen && canAddOthers && (
            <AddWatcherModal
              open={addOpen}
              caseId={caseId}
              existingUserIds={new Set(watchers.map((w) => w.userId))}
              onClose={() => setAddOpen(false)}
              onAdded={async () => {
                setAddOpen(false);
                await reload();
              }}
            />
          )}
        </div>
      )}
    </PanelSection>
  );
}

function AddWatcherModal({
  open,
  caseId,
  existingUserIds,
  onClose,
  onAdded,
}: {
  open: boolean;
  caseId: string;
  existingUserIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [candidates, setCandidates] = useState<import('./types').MentionableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void caseService.listMentionableUsers(caseId).then((rows) => {
      setCandidates(rows.filter((c) => !existingUserIds.has(c.userId)));
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, caseId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    if (!q) return candidates;
    return candidates.filter(
      (c) =>
        c.name.toLocaleLowerCase('tr').includes(q) ||
        c.email.toLocaleLowerCase('tr').includes(q),
    );
  }, [candidates, query]);

  async function pick(userId: string) {
    setSubmitting(userId);
    const r = await caseService.addWatcher(caseId, userId);
    setSubmitting(null);
    if (r) {
      window.dispatchEvent(new CustomEvent('app:watcher-changed', { detail: { caseId } }));
      toast({ type: 'success', message: 'İzleyici eklendi.', duration: 1800 });
      onAdded();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="İzleyici Ekle" size="md">
      <div className="space-y-3">
        <TextInput
          autoFocus
          placeholder="İsim veya e-posta ile ara…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading ? (
          <div className="space-y-1.5">
            <Skeleton height={14} width="80%" />
            <Skeleton height={14} width="70%" />
            <Skeleton height={14} width="75%" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-ndark-muted">
            {candidates.length === 0
              ? 'Eklenebilecek kullanıcı yok.'
              : 'Bu aramaya uyan kullanıcı bulunamadı.'}
          </p>
        ) : (
          <ul className="max-h-[320px] space-y-1 overflow-y-auto">
            {filtered.map((c) => (
              <li key={c.userId}>
                <button
                  type="button"
                  onClick={() => pick(c.userId)}
                  disabled={!!submitting}
                  className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left transition hover:bg-brand-50 hover:border-brand-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-ndark-border dark:bg-ndark-card dark:hover:bg-brand-950/20"
                >
                  <NoteAvatar name={c.name} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800 dark:text-ndark-text">
                      {c.name}
                    </span>
                    <span className="block truncate text-[11px] text-slate-500 dark:text-ndark-muted">
                      {c.teamName ?? '—'} · {c.email}
                    </span>
                  </span>
                  {submitting === c.userId && (
                    <Loader2 size={14} className="animate-spin text-brand-500" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────
// Links tab — FAZ 2 Collab. AI öneri kartı (auto-load) + gruplanmış
// link listesi (Related / Parent / Duplicate). "Vaka Bağla" modalı.
// ──────────────────────────────────────────────────────────────

type LinkTypeMeta = { label: string; icon: React.ReactNode; pill: string };
const LINK_TYPE_META: Record<import('./types').CaseLinkType, LinkTypeMeta> = {
  Related: {
    label: 'İlişkili Vakalar',
    icon: <LinkIcon size={14} className="text-blue-600 dark:text-blue-400" />,
    pill: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  },
  Parent: {
    label: 'Üst Vaka',
    icon: <LinkIcon size={14} className="text-emerald-600 dark:text-emerald-400" />,
    pill: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  Duplicate: {
    label: 'Mükerrer',
    icon: <LinkIcon size={14} className="text-amber-600 dark:text-amber-400" />,
    pill: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
};

function LinksTab({
  item,
  onShowCase,
}: {
  item: Case;
  onShowCase: (caseId: string) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [links, setLinks] = useState<import('./types').LinkedCaseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<import('./types').LinkSuggestion[]>([]);
  const [aiLoading, setAiLoading] = useState(true);
  const [aiErrored, setAiErrored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);

  const elevated = !!user && ['Supervisor', 'Admin', 'SystemAdmin'].includes(user.role);
  const isOwner = !!user?.personId && item.assignedPersonId === user.personId;
  const canRemove = elevated || isOwner;

  async function reload() {
    setLoading(true);
    const rows = await caseService.listLinks(item.id);
    setLinks(rows);
    setLoading(false);
  }

  async function loadAi() {
    setAiLoading(true);
    setAiErrored(false);
    const r = await aiService.suggestLinks(item.id);
    setAiLoading(false);
    if (r.ok) setSuggestions(r.data.suggestions);
    else setAiErrored(true);
  }

  useEffect(() => {
    void reload();
    void loadAi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  async function addLink(linkedCaseId: string, linkType: import('./types').CaseLinkType) {
    setBusy(true);
    const r = await caseService.addLink(item.id, linkedCaseId, linkType);
    setBusy(false);
    if (r) {
      toast({ type: 'success', message: 'Bağlantı eklendi.', duration: 1500 });
      await reload();
      // AI önerisini de tazelen (uygulanan vaka tekrar önerilmesin)
      setSuggestions((prev) => prev.filter((s) => s.caseId !== linkedCaseId));
    }
  }

  async function removeLink(linkId: string) {
    setBusy(true);
    const r = await caseService.removeLink(item.id, linkId);
    setBusy(false);
    if (r) {
      toast({ type: 'success', message: 'Bağlantı kaldırıldı.', duration: 1500 });
      setLinks((ls) => ls.filter((l) => l.linkId !== linkId));
    }
  }

  // Linkleri tip bazında grupla — render sırası: Related → Parent → Duplicate
  const groups: import('./types').CaseLinkType[] = ['Related', 'Parent', 'Duplicate'];
  const grouped = useMemo(() => {
    const m: Record<string, import('./types').LinkedCaseEntry[]> = {
      Related: [], Parent: [], Duplicate: [],
    };
    for (const l of links) m[l.linkType]?.push(l);
    return m;
  }, [links]);

  return (
    <div className="space-y-4">
      {/* AI öneri kartı */}
      <section className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
        <header className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-200">
            <Sparkles size={12} />
            RUNA AI Benzer Vakalar
          </h3>
          <button
            type="button"
            onClick={loadAi}
            disabled={aiLoading}
            className="rounded p-1 text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-900/40"
            title="Benzer vakaları yeniden analiz et"
            aria-label="Benzer vakaları yeniden analiz et"
          >
            <RefreshCw size={12} />
          </button>
        </header>

        {aiLoading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-violet-800 dark:text-violet-200">
            <Loader2 size={12} className="animate-spin" />
            Analiz ediliyor…
          </div>
        ) : aiErrored ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <ShieldAlert size={12} />
            AI önerisi alınamadı. Manuel "Vaka Bağla" ile ekleyebilirsiniz.
          </p>
        ) : suggestions.length === 0 ? (
          <p className="mt-2 text-xs text-violet-700 dark:text-violet-300">
            Önerilecek benzer vaka bulunamadı.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {suggestions.map((s) => {
              const meta = LINK_TYPE_META[s.linkType];
              const conf = Math.round(s.confidence * 100);
              return (
                <li
                  key={s.caseId}
                  className="rounded-md border border-violet-100 bg-white px-3 py-2 dark:border-violet-900/40 dark:bg-ndark-card"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <button
                      type="button"
                      onClick={() => onShowCase(s.caseId)}
                      className="font-mono text-xs text-slate-600 underline-offset-2 hover:text-brand-700 hover:underline dark:text-ndark-muted"
                    >
                      {s.caseNumber}
                    </button>
                    <span className="truncate text-sm text-slate-800 dark:text-ndark-text">
                      {s.title}
                    </span>
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.pill}`}
                    >
                      {meta.label.replace(' Vakalar', '')}
                    </span>
                    <span className="text-[10px] tabular-nums text-violet-700 dark:text-violet-300">
                      %{conf}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] italic text-slate-600 dark:text-ndark-muted">
                    "{s.reason}"
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addLink(s.caseId, s.linkType)}
                      disabled={busy}
                    >
                      Bağla
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setSuggestions((prev) => prev.filter((x) => x.caseId !== s.caseId))
                      }
                    >
                      Yoksay
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Existing links — gruplandırılmış */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-ndark-muted">
            Mevcut Bağlantılar
          </h3>
          <Button size="sm" leftIcon={<Plus size={12} />} onClick={() => setLinkModalOpen(true)}>
            Vaka Bağla
          </Button>
        </div>

        {loading ? (
          <div className="space-y-2">
            <Skeleton height={36} width="100%" />
            <Skeleton height={36} width="100%" />
          </div>
        ) : links.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-ndark-muted">
            Bu vakaya bağlı vaka yok.
          </p>
        ) : (
          groups.map((t) => {
            const items = grouped[t];
            if (items.length === 0) return null;
            const meta = LINK_TYPE_META[t];
            return (
              <div key={t}>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-ndark-text">
                  {meta.icon}
                  <span>{meta.label}</span>
                  <span className="text-[10px] text-slate-500 dark:text-ndark-muted">
                    ({items.length})
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {items.map((l) => (
                    <li
                      key={l.linkId}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-ndark-border dark:bg-ndark-card"
                    >
                      <button
                        type="button"
                        onClick={() => l.linkedCase && onShowCase(l.linkedCase.id)}
                        disabled={!l.linkedCase}
                        className="font-mono text-xs text-slate-600 underline-offset-2 hover:text-brand-700 hover:underline disabled:cursor-not-allowed dark:text-ndark-muted"
                      >
                        {l.linkedCase?.caseNumber ?? '?'}
                      </button>
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-ndark-text">
                        {l.linkedCase?.title ?? '(silinmiş vaka)'}
                      </span>
                      {l.linkedCase && (
                        <span className="text-[11px] text-slate-500 dark:text-ndark-muted">
                          {l.linkedCase.status}
                        </span>
                      )}
                      {canRemove && (
                        <button
                          type="button"
                          onClick={() => removeLink(l.linkId)}
                          disabled={busy}
                          className="text-[11px] font-medium text-rose-600 hover:text-rose-700 disabled:opacity-50 dark:text-rose-400 dark:hover:text-rose-300"
                        >
                          Kaldır
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>

      {linkModalOpen && (
        <LinkCaseModal
          open={linkModalOpen}
          item={item}
          onClose={() => setLinkModalOpen(false)}
          onAdded={async () => {
            setLinkModalOpen(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

const LINK_TYPE_DESCRIPTIONS: Record<import('./types').CaseLinkType, string> = {
  Related: 'Genel ilişkili — aynı müşteri başka konu, aynı ürün vs.',
  Duplicate: 'Aynı sorun — iki yön de otomatik bağlanır.',
  Parent: 'Bu vaka, hedef vakanın bir parçası/alt-kırılımı.',
};

function LinkCaseModal({
  open,
  item,
  onClose,
  onAdded,
}: {
  open: boolean;
  item: Case;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Case[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Case | null>(null);
  const [linkType, setLinkType] = useState<import('./types').CaseLinkType>('Related');
  const [submitting, setSubmitting] = useState(false);
  // Aynı müşteri için açılış suggestion'ı
  const [initialList, setInitialList] = useState<Case[]>([]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSelected(null);
      setLinkType('Related');
      return;
    }
    // Açılışta aynı müşterinin son vakalarını öner
    void caseService
      .findByAccount(item.accountId, { excludeId: item.id })
      .then((rows) => setInitialList(rows.slice(0, 10)));
  }, [open, item.accountId, item.id]);

  // Search debounce — number/title
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const handle = window.setTimeout(async () => {
      const data = await caseService.list({ search: q }, { page: 1, pageSize: 10 });
      if (!alive) return;
      setSearching(false);
      setResults(data.items.filter((c) => c.id !== item.id));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [open, query, item.id]);

  async function submit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    const r = await caseService.addLink(item.id, selected.id, linkType);
    setSubmitting(false);
    if (r) {
      toast({ type: 'success', message: 'Bağlantı eklendi.', duration: 1500 });
      onAdded();
    }
  }

  const visible = query.trim().length >= 2 ? results : initialList;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Vaka Bağla"
      size="md"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Vazgeç
          </Button>
          <Button size="sm" onClick={submit} disabled={!selected || submitting}>
            {submitting ? 'Ekleniyor…' : 'Bağla'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Vaka Ara" hint="Vaka no, başlık veya müşteri ile ara (min. 2 karakter)">
          <TextInput
            autoFocus
            placeholder="örn. VK-... veya kategori adı"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>

        {searching ? (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-ndark-muted">
            <Loader2 size={12} className="animate-spin" />
            Aranıyor…
          </div>
        ) : visible.length === 0 ? (
          <p className="py-3 text-center text-sm text-slate-500 dark:text-ndark-muted">
            {query.trim().length >= 2 ? 'Eşleşen vaka yok.' : 'Bu müşteri için başka vaka yok.'}
          </p>
        ) : (
          <ul className="max-h-[240px] space-y-1 overflow-y-auto">
            {visible.map((c) => {
              const isSelected = selected?.id === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(c)}
                    className={
                      'flex w-full items-baseline gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition ' +
                      (isSelected
                        ? 'border-brand-400 bg-brand-50 text-brand-800 dark:border-brand-700 dark:bg-brand-950/30 dark:text-brand-200'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50/40 dark:border-ndark-border dark:bg-ndark-card dark:hover:bg-brand-950/20')
                    }
                  >
                    <span className="font-mono text-xs">{c.caseNumber}</span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="text-[11px] text-slate-500 dark:text-ndark-muted">
                      {c.status}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected && (
          <Field label="Bağlantı Tipi" required>
            <div className="space-y-1.5">
              {(['Related', 'Duplicate', 'Parent'] as import('./types').CaseLinkType[]).map((t) => {
                const meta = LINK_TYPE_META[t];
                const active = linkType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setLinkType(t)}
                    className={
                      'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition ' +
                      (active
                        ? 'border-brand-400 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/30'
                        : 'border-slate-200 bg-white hover:border-brand-300 dark:border-ndark-border dark:bg-ndark-card')
                    }
                  >
                    <span className="mt-0.5">{meta.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-800 dark:text-ndark-text">
                        {meta.label.replace(' Vakalar', '')}
                      </span>
                      <span className="block text-[11px] text-slate-500 dark:text-ndark-muted">
                        {LINK_TYPE_DESCRIPTIONS[t]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────
// Status Report Modal — paydaşlara gönderilebilecek mail-ready
// vaka durum raporu. Header toolbar'dan tetiklenir.
// Modal açıldığında AI çağrısı tetiklenir; kullanıcı kopyala-kapat
// akışıyla raporu kullanır. Persist edilmez.
// ──────────────────────────────────────────────────────────────

function StatusReportModal({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}) {
  const [report, setReport] = useState<import('./types').ActionSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const [copied, setCopied] = useState(false);

  // Modal açılınca AI çağrısı yap. Kapanınca state'i sıfırla.
  useEffect(() => {
    if (!open) {
      setReport(null);
      setLoading(false);
      setErrored(false);
      setCopied(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setErrored(false);
    setReport(null);
    void caseService.getActionSummary(caseId).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r) setReport(r);
      else setErrored(true);
    });
    return () => {
      alive = false;
    };
  }, [open, caseId]);

  async function regenerate() {
    if (loading) return;
    setLoading(true);
    setErrored(false);
    const r = await caseService.getActionSummary(caseId);
    setLoading(false);
    if (r) setReport(r);
    else setErrored(true);
  }

  async function copyToClipboard() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard izni yoksa sessiz kal — spec sadece pozitif feedback ister
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-violet-600 dark:text-violet-400" />
          <span>Durum Raporu</span>
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          {copied && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/40">
              <Check size={12} />
              Kopyalandı
            </span>
          )}
          {report && !loading && (
            <Button
              size="sm"
              variant="outline"
              leftIcon={<RefreshCw size={12} />}
              onClick={regenerate}
              title="Yenile"
            >
              Yenile
            </Button>
          )}
          <Button
            size="sm"
            leftIcon={<Copy size={12} />}
            onClick={copyToClipboard}
            disabled={!report || loading}
          >
            Kopyala
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Kapat
          </Button>
        </div>
      }
    >
      {loading && (
        <div className="flex items-center gap-2 rounded-md bg-violet-50 px-3 py-3 text-sm text-violet-900 ring-1 ring-violet-200 dark:bg-violet-950/30 dark:text-violet-200 dark:ring-violet-900/40">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
          Rapor hazırlanıyor…
        </div>
      )}

      {errored && !loading && (
        <div className="space-y-2">
          <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900/40">
            Oluşturulamadı. Tekrar deneyin.
          </p>
          <Button size="sm" variant="outline" onClick={regenerate}>
            Tekrar Dene
          </Button>
        </div>
      )}

      {report && !loading && (
        <div className="space-y-2">
          <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 px-3 py-3 font-mono text-xs leading-relaxed text-slate-800 dark:border-ndark-border dark:bg-ndark-bg dark:text-slate-200">
            {report.report}
          </pre>
          <div className="text-[11px] text-slate-500 dark:text-ndark-muted">
            Son üretim: {formatRelative(report.generatedAt)} · {report.eventCount} olay
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Phase D Step 2 — Önerilen müşteriler panel'i.
 *
 * Lazy fetch: customerMatchPending banner'ı altında render olunca öneri çağrısı
 * yapılır. Deterministic skor — AI YOK. Bağlama tıklanınca parent'a confirm +
 * linkAccount akışını delege eder. Auto-link asla yok.
 */
function CustomerMatchSuggestionsPanel({
  caseId,
  onConfirmLink,
}: {
  caseId: string;
  onConfirmLink: (suggestion: CustomerMatchSuggestion) => Promise<void>;
}) {
  const [data, setData] = useState<CustomerMatchSuggestionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const out = await caseService.getCustomerMatchSuggestions(caseId);
    setLoading(false);
    if (!out) {
      setError('Öneriler yüklenemedi.');
      return;
    }
    setData(out);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  if (loading) {
    return (
      <div className="rounded-md border border-slate-200 px-3 py-2 dark:border-ndark-border">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-ndark-muted">
          <Sparkles size={11} /> Önerilen müşteriler
        </div>
        <div className="space-y-1.5">
          <Skeleton height={42} />
          <Skeleton height={42} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-slate-200 px-3 py-2 text-[11px] text-slate-600 dark:border-ndark-border dark:text-ndark-muted">
        <div className="flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-900/30"
          >
            Tekrar dene
          </button>
        </div>
      </div>
    );
  }

  const suggestions = data?.suggestions ?? [];
  if (suggestions.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 px-3 py-2 text-[11px] text-slate-600 dark:border-ndark-border dark:text-ndark-muted">
        <div className="mb-1 flex items-center gap-1.5 font-semibold uppercase tracking-wide text-slate-500">
          <Sparkles size={11} /> Önerilen müşteriler
        </div>
        <div>Bu vaka için otomatik öneri bulunamadı. Manuel arama ile devam edebilirsin.</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 px-3 py-2 dark:border-ndark-border">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-ndark-muted">
        <Sparkles size={11} /> Önerilen müşteriler
      </div>
      <ul className="space-y-1.5">
        {suggestions.map((s) => {
          const tint = s.confidence === 'high' ? 'emerald' : s.confidence === 'medium' ? 'amber' : 'slate';
          const isSubmitting = submittingId === s.accountId;
          return (
            <li
              key={s.accountId}
              className="rounded border border-slate-200 px-2 py-1.5 dark:border-ndark-border"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-slate-900 dark:text-ndark-text">
                    {s.accountName}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Badge tint={tint}>
                      {s.confidence === 'high' ? 'Yüksek sinyal' : s.confidence === 'medium' ? 'Orta sinyal' : 'Düşük sinyal'}
                      <span className="ml-1 opacity-70">{s.score}</span>
                    </Badge>
                    {s.openCaseCount > 0 && (
                      <span className="text-[10px] text-slate-500 dark:text-ndark-muted">
                        {s.openCaseCount} açık
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.reasons.map((r, i) => (
                      <span
                        key={`${r.type}-${i}`}
                        className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-ndark-surface dark:text-ndark-muted"
                        title={r.valueMasked ?? undefined}
                      >
                        {r.label}
                        {r.valueMasked && (
                          <span className="font-mono opacity-75">{r.valueMasked}</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={isSubmitting}
                onClick={async () => {
                  setSubmittingId(s.accountId);
                  await onConfirmLink(s);
                  setSubmittingId(null);
                }}
                className="mt-2 w-full justify-center"
              >
                {isSubmitting ? 'Bağlanıyor…' : 'Bu müşteriye bağla'}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] text-slate-400 dark:text-ndark-dim">
        Öneriler deterministic sinyallere dayanır; AI değildir. Manuel onay zorunludur.
      </p>
    </div>
  );
}

function PanelSection({
  title,
  icon,
  badge,
  children,
  hidden,
  tint = 'default',
}: {
  title: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  hidden?: boolean;
  tint?: 'default' | 'violet' | 'rose' | 'amber';
}) {
  if (hidden) return null;
  const ring =
    tint === 'violet' ? 'ring-violet-200 dark:ring-violet-900/40' :
    tint === 'rose'   ? 'ring-rose-200 dark:ring-rose-900/40' :
    tint === 'amber'  ? 'ring-amber-200 dark:ring-amber-900/40' :
                         'ring-slate-200 dark:ring-ndark-border';
  return (
    <section className={`rounded-lg bg-white p-3 ring-1 ring-inset dark:bg-ndark-card ${ring}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-ndark-muted">
          {icon}
          {title}
        </h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-ndark-muted">{label}</span>
      <span className="truncate text-right text-slate-800 dark:text-ndark-text">{value}</span>
    </div>
  );
}

function AiTile({
  label,
  value,
  tint = 'slate',
}: {
  label: string;
  value: string;
  tint?: 'slate' | 'indigo';
}) {
  const cls =
    tint === 'indigo'
      ? 'bg-indigo-50 ring-indigo-200 dark:bg-indigo-950/30 dark:ring-indigo-900/40'
      : 'bg-white ring-slate-200 dark:bg-ndark-card dark:ring-ndark-border';
  return (
    <div className={`rounded-md px-2.5 py-2 ring-1 ring-inset ${cls}`}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-ndark-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-slate-800 dark:text-ndark-text">{value}</div>
    </div>
  );
}

function QaScorePill({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 4
      ? 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-200 dark:ring-emerald-900/40'
      : value >= 3
      ? 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/40'
      : 'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/30 dark:text-rose-200 dark:ring-rose-900/40';
  return (
    <div className={`rounded-md px-2 py-1.5 text-center ring-1 ring-inset ${tone}`}>
      <div className="text-[9px] font-medium uppercase tracking-wide opacity-80">{label}</div>
      <div className="mt-0.5 text-sm font-bold">{value}/5</div>
    </div>
  );
}

function SlaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-slate-800">{value}</div>
    </div>
  );
}

// KpiCompact + KpiMini kaldırıldı — KPI artık Detay sekmesinin üstünde KpiInlineRow ile gösteriliyor

// ----------------------------------------------------------------
// Tab Components
// ----------------------------------------------------------------

function DetailTab({
  item,
  offeredSolutions,
  categories,
  teams,
  persons,
  thirdParties,
  catalogPackages,
  catalogProducts,
  previousCases,
  onSelectPrevious,
  drafts,
  editingField,
  onStartEdit,
  onCancelEdit,
  onCommitDraft,
  onTransitionApplied,
}: {
  item: Case;
  offeredSolutions: { id: string; name: string }[];
  categories: { category: string; subCategories: string[] }[];
  teams: { id: string; name: string }[];
  persons: { id: string; name: string; teamId: string }[];
  thirdParties: { id: string; name: string }[];
  catalogPackages: Array<{ id: string; code: string; name: string; supportLevel: SupportLevel }>;
  catalogProducts: Array<{
    id: string;
    code: string;
    name: string;
    supportLevel: SupportLevel;
    productGroupId: string;
  }>;
  previousCases: Case[];
  onSelectPrevious: (id: string) => void;
  drafts: Partial<Case>;
  editingField: string | null;
  onStartEdit: (field: string) => void;
  onCancelEdit: () => void;
  onCommitDraft: (field: keyof Case, value: unknown) => void;
  onTransitionApplied: (updated: Case) => void;
}) {
  // Kategori cascade — taslakta seçili kategoriye göre alt-kategori opsiyonları
  const activeCategory = (drafts.category ?? item.category) as string;
  const subCategoryOptions = categories.find((c) => c.category === activeCategory)?.subCategories ?? [];
  // Takım cascade — seçili takıma göre kişi opsiyonları
  const activeTeamId = (drafts.assignedTeamId ?? item.assignedTeamId) as string | undefined;
  const personOptions = activeTeamId ? persons.filter((p) => p.teamId === activeTeamId) : persons;
  // Aktif değer = pending draft varsa onu göster, yoksa item değeri
  const v = <K extends keyof Case>(key: K): Case[K] =>
    (drafts[key] !== undefined ? drafts[key] : item[key]) as Case[K];

  return (
    <div className="space-y-5">
      {/* Statü Geçişi (header popover'ının yerini aldı — inline kart grid) */}
      <StatusTransitionPanel item={item} onApplied={onTransitionApplied} />

      {/* WR-D4 Phase 1 — Çözüm Onayı kartı (yalnız eşleşen politika varsa) */}
      <ResolutionApprovalCard
        item={item}
        onApprovalChanged={() => {
          void caseService.get(item.id).then((c) => {
            if (c) onTransitionApplied(c);
          });
        }}
      />

      {/* WR-D4 Phase 2 — İletişim bildirimleri (yalnız bu vakaya dispatch varsa) */}
      <CommunicationDispatchCard
        item={item}
        onChanged={() => {
          void caseService.get(item.id).then((c) => {
            if (c) onTransitionApplied(c);
          });
        }}
      />

      {/* Inline edit bilgi notu */}
      <p className="flex items-center gap-1.5 text-[12px] text-slate-500">
        <Pencil size={11} className="text-slate-400" />
        Alanlara tıklayarak düzenleyebilirsiniz. Değişiklikleri üst köşedeki <strong>Kaydet</strong> butonuyla saklayın.
      </p>

      {/* KPI 4-tile satırı (sol panelden buraya taşındı) */}
      <KpiInlineRow item={item} />

      <Section title="Açıklama">
        <InlineEdit
          fieldKey="description"
          type="textarea"
          value={v('description') ?? ''}
          editing={editingField === 'description'}
          isDraft={drafts.description !== undefined}
          onStart={() => onStartEdit('description')}
          onCommit={(val) => onCommitDraft('description', val)}
          onCancel={onCancelEdit}
          renderDisplay={(val) => (
            <p className="whitespace-pre-wrap text-sm text-slate-700">{String(val ?? '—')}</p>
          )}
        />
      </Section>

      <Section title="Müşteri & Sınıflandırma">
        <EditableGrid
          rows={[
            { label: 'Şirket', node: <span className="block cursor-default px-2 py-1 text-sm text-slate-800">{item.companyName}</span> },
            { label: 'Müşteri', node: <span className="block cursor-default px-2 py-1 text-sm text-slate-800">{item.accountName}</span> },
            { label: 'Kategori', node: (
              <InlineEdit
                fieldKey="category"
                type="select"
                value={v('category') ?? ''}
                editing={editingField === 'category'}
                isDraft={drafts.category !== undefined}
                onStart={() => onStartEdit('category')}
                onCommit={(val) => onCommitDraft('category', val)}
                onCancel={onCancelEdit}
                options={categories.map((c) => ({ value: c.category, label: c.category }))}
              />
            )},
            { label: 'Alt Kategori', node: (
              <InlineEdit
                fieldKey="subCategory"
                type="select"
                value={v('subCategory') ?? ''}
                editing={editingField === 'subCategory'}
                isDraft={drafts.subCategory !== undefined}
                onStart={() => onStartEdit('subCategory')}
                onCommit={(val) => onCommitDraft('subCategory', val)}
                onCancel={onCancelEdit}
                options={[{ value: '', label: '— Seçin —' }, ...subCategoryOptions.map((s) => ({ value: s, label: s }))]}
                disabled={!activeCategory}
              />
            )},
            { label: 'Talep Türü', node: (
              <InlineEdit
                fieldKey="requestType"
                type="select"
                value={v('requestType')}
                editing={editingField === 'requestType'}
                isDraft={drafts.requestType !== undefined}
                onStart={() => onStartEdit('requestType')}
                onCommit={(val) => onCommitDraft('requestType', val)}
                onCancel={onCancelEdit}
                options={CASE_REQUEST_TYPES.map((r) => ({ value: r, label: r }))}
              />
            )},
            { label: 'Ürün Grubu', node: (
              <InlineEdit
                fieldKey="productGroup"
                type="select"
                value={v('productGroup') ?? ''}
                editing={editingField === 'productGroup'}
                isDraft={drafts.productGroup !== undefined}
                onStart={() => onStartEdit('productGroup')}
                onCommit={(val) => onCommitDraft('productGroup', val)}
                onCancel={onCancelEdit}
                options={[{ value: '', label: '— Seçin —' }, ...lookupService.productGroups().map((p) => ({ value: p, label: p }))]}
              />
            )},
            // WR-A7b — Catalog Paket inline edit. BFF DI.3/4/5 enforce eder; role gate
            // (Supervisor/Admin/SystemAdmin) BFF tarafında, UI 403 ise toast gösterir.
            { label: 'Paket', node: (
              <InlineEdit
                fieldKey="packageId"
                type="select"
                value={(v('packageId') as string | null | undefined) ?? ''}
                editing={editingField === 'packageId'}
                isDraft={drafts.packageId !== undefined}
                onStart={() => onStartEdit('packageId')}
                onCommit={(val) => onCommitDraft('packageId', val || null)}
                onCancel={onCancelEdit}
                options={[
                  { value: '', label: '— Paket Yok —' },
                  ...catalogPackages.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` })),
                ]}
                renderDisplay={() => (
                  <span className="text-sm text-slate-800">
                    {(() => {
                      const pid =
                        (drafts.packageId as string | null | undefined) ?? item.packageId ?? null;
                      if (!pid) return item.packageName ?? '—';
                      const found = catalogPackages.find((p) => p.id === pid);
                      return found ? `${found.name} (${found.code})` : item.packageName ?? pid;
                    })()}
                  </span>
                )}
              />
            )},
            // WR-A7b — Catalog Ürün inline edit. BFF DI.2 enforce; role gate
            // (Supervisor/CSM/Admin/SystemAdmin) BFF tarafında.
            { label: 'Ürün', node: (
              <InlineEdit
                fieldKey="productId"
                type="select"
                value={(v('productId') as string | null | undefined) ?? ''}
                editing={editingField === 'productId'}
                isDraft={drafts.productId !== undefined}
                onStart={() => onStartEdit('productId')}
                onCommit={(val) => onCommitDraft('productId', val || null)}
                onCancel={onCancelEdit}
                options={(() => {
                  const pid =
                    (drafts.packageId as string | null | undefined) ?? item.packageId ?? null;
                  // Paket seçiliyse o pakete bağlı ürünleri öncelikle göster (cascade filter UI hint).
                  // Tüm ürünleri yine yedek olarak sun ki paketsiz ürün de eklenebilsin.
                  return [
                    { value: '', label: '— Ürün Yok —' },
                    ...catalogProducts.map((p) => ({
                      value: p.id,
                      label:
                        `${p.name} (${p.code})` +
                        (pid && p.id ? '' : '') /* paket filtresi UI yardımı; backend katı değil */,
                    })),
                  ];
                })()}
                renderDisplay={() => (
                  <span className="text-sm text-slate-800">
                    {(() => {
                      const pid =
                        (drafts.productId as string | null | undefined) ?? item.productId ?? null;
                      if (!pid) return item.productName ?? '—';
                      const found = catalogProducts.find((p) => p.id === pid);
                      return found ? `${found.name} (${found.code})` : item.productName ?? pid;
                    })()}
                  </span>
                )}
              />
            )},
            { label: 'Origin', node: (
              <InlineEdit
                fieldKey="origin"
                type="select"
                value={v('origin')}
                editing={editingField === 'origin'}
                isDraft={drafts.origin !== undefined}
                onStart={() => onStartEdit('origin')}
                onCommit={(val) => onCommitDraft('origin', val)}
                onCancel={onCancelEdit}
                options={CASE_ORIGINS.map((o) => ({ value: o, label: o }))}
              />
            )},
            { label: 'Origin Açıklama', node: (
              <InlineEdit
                fieldKey="originDescription"
                type="text"
                value={v('originDescription')}
                editing={editingField === 'originDescription'}
                isDraft={drafts.originDescription !== undefined}
                onStart={() => onStartEdit('originDescription')}
                onCommit={(val) => onCommitDraft('originDescription', String(val))}
                onCancel={onCancelEdit}
                disabled={v('origin') !== 'Diğer'}
                placeholder={v('origin') === 'Diğer' ? 'Origin = Diğer için zorunlu' : 'Yalnızca origin = Diğer'}
              />
            )},
            { label: '3. Parti Bekleniyor', node: (
              <InlineEdit
                fieldKey="thirdPartyId"
                type="select"
                value={v('thirdPartyId') ?? ''}
                editing={editingField === 'thirdPartyId'}
                isDraft={drafts.thirdPartyId !== undefined}
                onStart={() => onStartEdit('thirdPartyId')}
                onCommit={(val) => onCommitDraft('thirdPartyId', val)}
                onCancel={onCancelEdit}
                options={[{ value: '', label: '— Yok —' }, ...thirdParties.map((tp) => ({ value: tp.id, label: tp.name }))]}
                renderDisplay={() => (
                  <span className="text-sm text-slate-800">
                    {(drafts.thirdPartyName as string | undefined) ?? item.thirdPartyName ?? '—'}
                  </span>
                )}
              />
            )},
          ]}
        />
      </Section>

      {/* Atama & Eskalasyon — sol panelden bağımsız, inline-edit'li alanlar */}
      <Section title="Atama & Eskalasyon">
        <EditableGrid
          rows={[
            { label: 'Atanan Takım', node: (
              <InlineEdit
                fieldKey="assignedTeamId"
                type="select"
                value={v('assignedTeamId') ?? ''}
                editing={editingField === 'assignedTeamId'}
                isDraft={drafts.assignedTeamId !== undefined}
                onStart={() => onStartEdit('assignedTeamId')}
                onCommit={(val) => onCommitDraft('assignedTeamId', val)}
                onCancel={onCancelEdit}
                options={[{ value: '', label: '— Atanmadı —' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
                renderDisplay={() => (
                  <span className="text-sm text-slate-800">
                    {(drafts.assignedTeamName as string | undefined) ?? item.assignedTeamName ?? '—'}
                  </span>
                )}
              />
            )},
            { label: 'Atanan Kişi', node: (
              <InlineEdit
                fieldKey="assignedPersonId"
                type="select"
                value={v('assignedPersonId') ?? ''}
                editing={editingField === 'assignedPersonId'}
                isDraft={drafts.assignedPersonId !== undefined}
                onStart={() => onStartEdit('assignedPersonId')}
                onCommit={(val) => onCommitDraft('assignedPersonId', val)}
                onCancel={onCancelEdit}
                options={[
                  { value: '', label: activeTeamId ? '— Atanmadı —' : '— Önce takım seçin —' },
                  ...personOptions.map((p) => ({ value: p.id, label: p.name })),
                ]}
                disabled={!activeTeamId}
                renderDisplay={() => (
                  <span className="text-sm text-slate-800">
                    {(drafts.assignedPersonName as string | undefined) ?? item.assignedPersonName ?? '—'}
                  </span>
                )}
              />
            )},
            { label: 'Eskalasyon', node: (
              <InlineEdit
                fieldKey="escalationLevel"
                type="select"
                value={v('escalationLevel')}
                editing={editingField === 'escalationLevel'}
                isDraft={drafts.escalationLevel !== undefined}
                onStart={() => onStartEdit('escalationLevel')}
                onCommit={(val) => onCommitDraft('escalationLevel', val)}
                onCancel={onCancelEdit}
                options={ESCALATION_LEVELS.map((l) => ({ value: l, label: ESCALATION_LEVEL_LABELS[l] }))}
                renderDisplay={() => (
                  <span className="text-sm text-slate-800">
                    {ESCALATION_LEVEL_LABELS[(drafts.escalationLevel as EscalationLevel | undefined) ?? item.escalationLevel]}
                  </span>
                )}
              />
            )},
            // WR-A5 / PM-03 — Destek seviyesi. Inline edit Supervisor+ (BFF guard
            // 403 verir; UI gating role bazlı zaten yok — backend response toast
            // gösterir). Phase 1 foundation; SLA/routing entegrasyonu Phase 2.
            { label: 'Destek Seviyesi', node: (
              <InlineEdit
                fieldKey="supportLevel"
                type="select"
                value={(v('supportLevel') as string | undefined) ?? 'L1'}
                editing={editingField === 'supportLevel'}
                isDraft={drafts.supportLevel !== undefined}
                onStart={() => onStartEdit('supportLevel')}
                onCommit={(val) => onCommitDraft('supportLevel', val)}
                onCancel={onCancelEdit}
                options={SUPPORT_LEVELS.map((l) => ({ value: l, label: SUPPORT_LEVEL_LABELS[l] }))}
                renderDisplay={() => (
                  <span className="text-sm text-slate-800">
                    {SUPPORT_LEVEL_LABELS[((drafts.supportLevel as SupportLevel | undefined) ?? item.supportLevel ?? 'L1') as SupportLevel]}
                  </span>
                )}
              />
            )},
            { label: 'Vaka Sahibi', node: <span className="block cursor-default px-2 py-1 text-sm text-slate-500" title="Otomatik atanır">{item.assignedPersonName ?? 'Atanmadı'}</span> },
          ]}
        />
      </Section>

      {/* FAZ 4 — Kontrol Listesi (3-tuple template'inden snapshot, vaka açılırken yüklenir) */}
      {item.checklistItems && item.checklistItems.length > 0 && (
        <ChecklistSection item={item} onCaseUpdated={onTransitionApplied} />
      )}

      {item.caseType === 'ProactiveTracking' && (
        <Section title="Proaktif Takip Bilgileri" tint="violet">
          <EditableGrid
            rows={[
              { label: 'Finansal Risk', node: (
                <InlineEdit
                  fieldKey="financialStatus" type="select" value={v('financialStatus')}
                  editing={editingField === 'financialStatus'}
                  isDraft={drafts.financialStatus !== undefined}
                  onStart={() => onStartEdit('financialStatus')}
                  onCommit={(val) => onCommitDraft('financialStatus', val)}
                  onCancel={onCancelEdit}
                  options={FINANCIAL_STATUSES.map((s) => ({ value: s, label: s }))}
                />
              )},
              { label: 'Ürün Kullanımı', node: (
                <InlineEdit
                  fieldKey="productUsage" type="select" value={v('productUsage')}
                  editing={editingField === 'productUsage'}
                  isDraft={drafts.productUsage !== undefined}
                  onStart={() => onStartEdit('productUsage')}
                  onCommit={(val) => onCommitDraft('productUsage', val)}
                  onCancel={onCancelEdit}
                  options={PRODUCT_USAGES.map((s) => ({ value: s, label: s }))}
                />
              )},
              { label: 'Kullanım Trendi', node: (
                <InlineEdit
                  fieldKey="usageChangeAlert" type="select" value={v('usageChangeAlert')}
                  editing={editingField === 'usageChangeAlert'}
                  isDraft={drafts.usageChangeAlert !== undefined}
                  onStart={() => onStartEdit('usageChangeAlert')}
                  onCommit={(val) => onCommitDraft('usageChangeAlert', val)}
                  onCancel={onCancelEdit}
                  options={USAGE_CHANGE_ALERTS.map((s) => ({ value: s, label: s }))}
                />
              )},
              { label: 'Müdahale Önceliği', node: (
                <InlineEdit
                  fieldKey="responseLevel" type="select" value={v('responseLevel')}
                  editing={editingField === 'responseLevel'}
                  isDraft={drafts.responseLevel !== undefined}
                  onStart={() => onStartEdit('responseLevel')}
                  onCommit={(val) => onCommitDraft('responseLevel', val)}
                  onCancel={onCancelEdit}
                  options={RESPONSE_LEVELS.map((s) => ({ value: s, label: s }))}
                />
              )},
            ]}
          />
        </Section>
      )}

      {item.caseType === 'Churn' && (
        <Section title="Churn Yönetimi" tint="rose">
          <EditableGrid
            rows={[
              { label: 'İptal Talebi', node: (
                <InlineEdit
                  fieldKey="cancellationRequest" type="checkbox" value={v('cancellationRequest')}
                  editing={editingField === 'cancellationRequest'}
                  isDraft={drafts.cancellationRequest !== undefined}
                  onStart={() => onStartEdit('cancellationRequest')}
                  onCommit={(val) => onCommitDraft('cancellationRequest', val)}
                  onCancel={onCancelEdit}
                  renderDisplay={(val) => <span className="px-2 py-1 text-sm text-slate-800">{val ? 'Var' : 'Yok'}</span>}
                />
              )},
              { label: 'Teklif Sonucu', node: (
                <InlineEdit
                  fieldKey="offerOutcome" type="select" value={v('offerOutcome')}
                  editing={editingField === 'offerOutcome'}
                  isDraft={drafts.offerOutcome !== undefined}
                  onStart={() => onStartEdit('offerOutcome')}
                  onCommit={(val) => onCommitDraft('offerOutcome', val)}
                  onCancel={onCancelEdit}
                  options={[{ value: '', label: '—' }, ...OFFER_OUTCOMES.map((o) => ({ value: o, label: o }))]}
                />
              )},
              { label: 'Teklif Geçerlilik', node: (
                <InlineEdit
                  fieldKey="offerExpiryDate" type="date" value={v('offerExpiryDate')}
                  editing={editingField === 'offerExpiryDate'}
                  isDraft={drafts.offerExpiryDate !== undefined}
                  onStart={() => onStartEdit('offerExpiryDate')}
                  onCommit={(val) => onCommitDraft('offerExpiryDate', val)}
                  onCancel={onCancelEdit}
                  renderDisplay={(val) => <span className="px-2 py-1 text-sm text-slate-800">{val ? formatDateTime(String(val)) : '—'}</span>}
                />
              )},
              { label: 'Takip Tarihi', node: (
                <InlineEdit
                  fieldKey="followUpDate" type="date" value={v('followUpDate')}
                  editing={editingField === 'followUpDate'}
                  isDraft={drafts.followUpDate !== undefined}
                  onStart={() => onStartEdit('followUpDate')}
                  onCommit={(val) => onCommitDraft('followUpDate', val)}
                  onCancel={onCancelEdit}
                  renderDisplay={(val) => <span className="px-2 py-1 text-sm text-slate-800">{val ? formatDateTime(String(val)) : '—'}</span>}
                />
              )},
              { label: 'Churn Sonucu', node: <span className="px-2 py-1 text-sm text-slate-800">{item.churnResult ?? '—'}</span> },
              { label: 'Retention Durumu', node: <span className="px-2 py-1 text-sm text-slate-800">{item.retentionStatus ?? '—'}</span> },
            ]}
          />

          <div className="mt-3 grid grid-cols-1 gap-2">
            <div>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Yapılan Aksiyon
              </h4>
              <InlineEdit
                fieldKey="actionTaken" type="textarea" value={v('actionTaken') ?? ''}
                editing={editingField === 'actionTaken'}
                isDraft={drafts.actionTaken !== undefined}
                onStart={() => onStartEdit('actionTaken')}
                onCommit={(val) => onCommitDraft('actionTaken', String(val))}
                onCancel={onCancelEdit}
                renderDisplay={(val) => (
                  <p className="whitespace-pre-wrap text-sm text-slate-700">{val ? String(val) : <span className="text-slate-400">— eklenmemiş —</span>}</p>
                )}
              />
            </div>
            {(v('offerOutcome') === 'Reddedildi' || drafts.offerOutcome === 'Reddedildi') && (
              <div>
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
                  Red Gerekçesi
                </h4>
                <InlineEdit
                  fieldKey="offerRejectionReason" type="textarea" value={v('offerRejectionReason') ?? ''}
                  editing={editingField === 'offerRejectionReason'}
                  isDraft={drafts.offerRejectionReason !== undefined}
                  onStart={() => onStartEdit('offerRejectionReason')}
                  onCommit={(val) => onCommitDraft('offerRejectionReason', String(val))}
                  onCancel={onCancelEdit}
                  renderDisplay={(val) => (
                    <p className="whitespace-pre-wrap text-sm text-slate-700">{val ? String(val) : <span className="text-slate-400">— eklenmemiş —</span>}</p>
                  )}
                />
              </div>
            )}
          </div>

          {/* Sunulan Teklifler — her zaman görünür; ekle/çıkar butonları taslağa yazar */}
          <OfferedSolutionsBlock
            currentIds={(v('offeredSolutions') ?? []) as string[]}
            options={offeredSolutions}
            isDraft={drafts.offeredSolutions !== undefined}
            onChange={(newIds) => onCommitDraft('offeredSolutions', newIds)}
          />
        </Section>
      )}

      <Section title="SLA & Tarihler">
        <DetailGrid
          rows={[
            ['Yanıt SLA', item.slaResponseDueAt ? formatDateTime(item.slaResponseDueAt) : '—'],
            ['Çözüm SLA', item.slaResolutionDueAt ? formatDateTime(item.slaResolutionDueAt) : '—'],
            ['SLA Duraklatıldı', item.slaPausedAt ? formatDateTime(item.slaPausedAt) : 'Hayır'],
            ['Toplam Pause', `${item.slaPausedDurationMin} dk`],
            ['Açılış', formatDateTime(item.createdAt)],
            ['Son Güncelleme', formatDateTime(item.updatedAt)],
            ['Çözüm', item.resolvedAt ? formatDateTime(item.resolvedAt) : '—'],
          ]}
        />
      </Section>

      {item.resolutionNote && (
        <Section title="Çözüm Notu" tint="emerald">
          <p className="whitespace-pre-wrap rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
            {item.resolutionNote}
          </p>
        </Section>
      )}

      {item.cancellationReason && (
        <Section title="İptal Gerekçesi">
          <p className="whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
            {item.cancellationReason}
          </p>
        </Section>
      )}

      {/* Sol panelden buraya taşındı — bu müşteriye ait kapalı/çözülmüş vakalar */}
      {previousCases.length > 0 && (
        <Section title={`Önceki Vakalar (${previousCases.length})`}>
          <ul className="space-y-1.5">
            {previousCases.slice(0, 3).map((p) => {
              const refDate = p.resolvedAt ?? p.updatedAt;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onSelectPrevious(p.id)}
                    className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/40 dark:border-ndark-border dark:bg-ndark-card dark:hover:border-brand-500 dark:hover:bg-brand-950/20"
                  >
                    <span className="font-mono text-[11px] text-slate-500 dark:text-ndark-muted">{p.caseNumber}</span>
                    <span className="flex-1 truncate text-sm font-medium text-slate-800 dark:text-ndark-text">{p.title}</span>
                    <StatusPill status={p.status} />
                    <span className="text-[11px] text-slate-500 dark:text-ndark-muted">{formatRelative(refDate)}</span>
                  </button>
                </li>
              );
            })}
            {previousCases.length > 3 && (
              <li className="pl-2 text-[11px] text-slate-500">
                +{previousCases.length - 3} vaka daha…
              </li>
            )}
          </ul>
        </Section>
      )}

      {/* Custom Fields — şirket FieldDefinition'larına göre dinamik */}
      <CustomFieldsCaseSection item={item} onCommitDraft={onCommitDraft} drafts={drafts} />
    </div>
  );
}

// ----------------------------------------------------------------
// Custom Fields — vakanın bağlı olduğu şirketin FieldDefinition'larını
// gösterir; inline edit ile değer güncellenir, drafts üzerinden Kaydet'e kadar
// commit edilir.
// ----------------------------------------------------------------

function CustomFieldsCaseSection({
  item,
  drafts,
  onCommitDraft,
}: {
  item: Case;
  drafts: Partial<Case>;
  onCommitDraft: (field: keyof Case, value: unknown) => void;
}) {
  const allDefs = useMemo(() => lookupService.fieldDefinitions(), []);
  const defs = useMemo(
    () =>
      allDefs
        .filter((d) => d.companyId === item.companyId)
        .filter((d) => d.isActive)
        .filter((d) => !d.caseType || d.caseType === item.caseType)
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [allDefs, item.companyId, item.caseType],
  );

  if (defs.length === 0) return null;

  const currentValues =
    (drafts.customFields as Record<string, unknown> | undefined) ??
    (item.customFields as Record<string, unknown> | undefined) ??
    {};

  function update(fieldKey: string, value: unknown) {
    const next = { ...currentValues, [fieldKey]: value };
    onCommitDraft('customFields', next);
  }

  return (
    <Section title="Dinamik Alanlar" tint="default">
      <div className="space-y-3 px-3 py-3">
        {defs.map((def) => (
          <CustomFieldRenderer
            key={def.id}
            definition={def}
            value={currentValues[def.fieldKey]}
            onChange={(v) => update(def.fieldKey, v)}
          />
        ))}
      </div>
    </Section>
  );
}

// ----------------------------------------------------------------
// Sunulan Teklifler — Churn yönetimindeki çoklu teklif seçim alanı
// ----------------------------------------------------------------

function OfferedSolutionsBlock({
  currentIds,
  options,
  isDraft,
  onChange,
}: {
  currentIds: string[];
  options: { id: string; name: string; description?: string }[];
  isDraft: boolean;
  onChange: (newIds: string[]) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  function handleRemove(id: string) {
    onChange(currentIds.filter((x) => x !== id));
  }

  return (
    <>
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Sunulan Teklifler
            {isDraft && (
              <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 ring-1 ring-amber-200">
                Taslak
              </span>
            )}
          </h4>
          <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
            + Teklif Sun
          </Button>
        </div>
        {currentIds.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/50 px-3 py-2 text-xs text-slate-500">
            Henüz teklif sunulmadı. <strong>+ Teklif Sun</strong> ile listeden seçim yapabilirsiniz.
          </div>
        ) : (
          <ul className="space-y-1">
            {currentIds.map((id) => {
              const def = options.find((o) => o.id === id);
              return (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded-md bg-rose-50/60 px-3 py-1.5 text-sm ring-1 ring-rose-200"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-slate-800">{def?.name ?? `Bilinmeyen teklif (${id})`}</div>
                    {def?.description && (
                      <div className="truncate text-[11px] text-slate-500">{def.description}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(id)}
                    className="shrink-0 rounded p-1 text-rose-500 hover:bg-rose-100 hover:text-rose-700"
                    title="Tekliften çıkar"
                    aria-label={`${def?.name ?? id} teklifini çıkar`}
                  >
                    <X size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <OfferedSolutionsPickerModal
        open={pickerOpen}
        currentIds={currentIds}
        options={options}
        onClose={() => setPickerOpen(false)}
        onSave={(newIds) => {
          onChange(newIds);
          setPickerOpen(false);
        }}
      />
    </>
  );
}

function OfferedSolutionsPickerModal({
  open,
  currentIds,
  options,
  onClose,
  onSave,
}: {
  open: boolean;
  currentIds: string[];
  options: { id: string; name: string; description?: string }[];
  onClose: () => void;
  onSave: (newIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(currentIds);

  // Modal her açılışında mevcut seçimi başlangıç olarak yükle
  useEffect(() => {
    if (open) setSelected(currentIds);
  }, [open, currentIds]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Müşteriye Teklif Sun"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-500">
            {selected.length} teklif seçildi
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Vazgeç
            </Button>
            <Button onClick={() => onSave(selected)}>Uygula</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        <p className="text-xs text-slate-500">
          Müşteriyi tutabilmek için sunulacak retention teklif(ler)ini seçin. Çoklu seçim
          mümkündür; mevcut listeye eklenir/çıkarılır.
        </p>
        {options.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-500">
            Tanımlı teklif yok. Admin → Teklif Tanımları'ndan ekleyin.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {options.map((o) => {
              const checked = selected.includes(o.id);
              return (
                <li key={o.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition ${
                      checked
                        ? 'border-rose-300 bg-rose-50/60 dark:border-rose-900/40 dark:bg-rose-950/30'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-ndark-border dark:bg-ndark-card dark:hover:border-ndark-border dark:hover:bg-ndark-bg'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.id)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800">{o.name}</div>
                      {o.description && (
                        <div className="text-[11px] text-slate-500">{o.description}</div>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------
// Kontrol Listesi section — FAZ 4
// 3-tuple match'ten gelen snapshot item'ları gösterir; check/uncheck
// caseService.toggleChecklistItem ile persist edilir, parent'a bildirilir.
// ----------------------------------------------------------------

function ChecklistSection({
  item,
  onCaseUpdated,
}: {
  item: Case;
  onCaseUpdated: (updated: Case) => void;
}) {
  const items = item.checklistItems ?? [];
  const total = items.length;
  const checkedCount = items.filter((i) => i.checked).length;
  const requiredItems = items.filter((i) => i.required);
  const requiredPending = requiredItems.filter((i) => !i.checked).length;
  const allRequiredDone = requiredPending === 0;
  const pct = total > 0 ? Math.round((checkedCount / total) * 100) : 0;

  async function handleToggle(itemId: string, currentlyChecked: boolean) {
    const updated = await caseService.toggleChecklistItem(item.id, itemId, !currentlyChecked);
    if (updated) onCaseUpdated(updated);
  }

  return (
    <Section title="Kontrol Listesi" tint={allRequiredDone ? 'emerald' : 'default'}>
      {/* Progress header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="font-medium text-slate-800">
            {checkedCount} / {total}
          </span>
          <span>· %{pct} tamamlandı</span>
          {requiredItems.length > 0 && (
            <Badge tint={allRequiredDone ? 'emerald' : 'rose'}>
              {requiredPending === 0
                ? 'Zorunlu maddeler tamam'
                : `${requiredPending} zorunlu eksik`}
            </Badge>
          )}
        </div>
        <div className="hidden sm:block min-w-[120px] flex-1 max-w-[220px]">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full transition-all ${allRequiredDone ? 'bg-emerald-500' : 'bg-brand-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <ul className="space-y-1.5">
        {items.map((it) => (
          <li
            key={it.id}
            className={`flex items-start gap-2.5 rounded-md border px-3 py-2 transition ${
              it.checked
                ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20'
                : it.required
                  ? 'border-rose-200 bg-rose-50/40 dark:border-rose-900/40 dark:bg-rose-950/20'
                  : 'border-slate-200 bg-white dark:border-ndark-border dark:bg-ndark-card'
            }`}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={it.checked}
              onClick={() => void handleToggle(it.id, it.checked)}
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                it.checked
                  ? 'border-emerald-500 bg-emerald-500 text-white'
                  : 'border-slate-300 bg-white hover:border-slate-400 dark:border-ndark-border dark:bg-ndark-card dark:hover:border-ndark-muted'
              }`}
              title={it.checked ? 'İşareti kaldır' : 'Tamamlandı olarak işaretle'}
            >
              {it.checked && <Check size={12} />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`text-sm ${
                    it.checked ? 'text-slate-500 line-through' : 'text-slate-800'
                  }`}
                >
                  {it.label}
                </span>
                {it.required && !it.checked && (
                  <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700">
                    Zorunlu
                  </span>
                )}
              </div>
              {it.checked && it.checkedAt && (
                <div className="mt-0.5 text-[10px] text-slate-400">
                  {it.checkedBy ?? 'Bilinmiyor'} · {formatDateTime(it.checkedAt)}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ----------------------------------------------------------------
// KPI Inline Row — Detay sekmesinin üstünde 4-tile satır
// ----------------------------------------------------------------
function KpiInlineRow({ item }: { item: Case }) {
  const minutes = (a: string, b: string) =>
    Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
  const fmt = (m: number) => {
    if (m < 60) return `${m} dk`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} sa`;
    return `${Math.round(h / 24)} gün`;
  };
  const firstReview = item.history.find(
    (h) => h.action === 'Statü değişti' && h.toValue === 'İncelemede',
  );
  const responseMin = firstReview ? minutes(item.createdAt, firstReview.at) : null;
  const resolutionMin = item.resolvedAt ? minutes(item.createdAt, item.resolvedAt) : null;
  const fcr = responseMin != null && resolutionMin != null && resolutionMin <= 24 * 60;
  const reopened = item.history.some(
    (h) => h.action === 'Statü değişti' && h.fromValue === 'Çözüldü' && h.toValue === 'YenidenAcildi',
  );

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <KpiInlineTile icon={<TrendingUp size={12} />} label="Müdahale Süresi" value={responseMin != null ? fmt(responseMin) : '—'} />
      <KpiInlineTile icon={<CheckCircle2 size={12} />} label="Çözüm Süresi"   value={resolutionMin != null ? fmt(resolutionMin) : '—'} />
      <KpiInlineTile
        icon={<Target size={12} />}
        label="İlk Temas Çözüm"
        value={fcr ? 'Evet' : resolutionMin != null ? 'Hayır' : '—'}
        tone={fcr ? 'good' : resolutionMin != null ? 'warn' : 'neutral'}
      />
      <KpiInlineTile
        icon={<HistoryIcon size={12} />}
        label="Yeniden Açılma"
        value={reopened ? 'Var' : 'Yok'}
        tone={reopened ? 'warn' : 'neutral'}
      />
    </div>
  );
}

function KpiInlineTile({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const cls =
    tone === 'good' ? 'bg-emerald-50 ring-emerald-200' :
    tone === 'warn' ? 'bg-amber-50 ring-amber-200' :
                       'bg-slate-50 ring-slate-200';
  return (
    <div className={`rounded-lg p-3 ring-1 ring-inset ${cls}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-600 dark:text-ndark-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-ndark-text">{value}</div>
    </div>
  );
}

// ----------------------------------------------------------------
// Inline edit (click-to-edit; ESC/click outside iptal eder; commit draft state'e gider,
// header'daki Kaydet butonu drafts'ı caseService.update ile flush eder)
// ----------------------------------------------------------------
type InlineEditType = 'text' | 'textarea' | 'select' | 'checkbox' | 'date';

function InlineEdit({
  fieldKey,
  type,
  value,
  options,
  editing,
  isDraft,
  onStart,
  onCommit,
  onCancel,
  renderDisplay,
  placeholder,
  disabled,
}: {
  fieldKey: string;
  type: InlineEditType;
  value: unknown;
  options?: { value: string; label: string }[];
  editing: boolean;
  isDraft: boolean;
  onStart: () => void;
  onCommit: (newValue: unknown) => void;
  onCancel: () => void;
  renderDisplay?: (val: unknown) => React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<unknown>(value);

  // editing açıldığında draft'ı resetle
  useEffect(() => {
    if (editing) setDraft(value);
  }, [editing, value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          if (disabled) return;
          e.preventDefault();
          onStart();
        }}
        title={disabled ? '' : `${fieldKey} alanını düzenle`}
        aria-label={disabled ? undefined : `${fieldKey} alanını düzenle`}
        className={`group relative w-full rounded-md border text-left transition ${
          disabled
            ? 'cursor-default border-transparent'
            : 'cursor-pointer border-transparent hover:border-slate-200 hover:bg-slate-50'
        } ${isDraft ? 'border-amber-300 bg-amber-50' : ''}`}
      >
        <span className="block px-2 py-1 pr-7">
          {renderDisplay ? renderDisplay(value) : (value ? String(value) : <span className="text-slate-400">—</span>)}
        </span>
        {!disabled && !isDraft && (
          <Pencil
            size={12}
            aria-hidden
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
        {isDraft && (
          <span className="absolute right-1 top-1 rounded bg-amber-200 px-1 text-[9px] font-semibold text-amber-900">
            taslak
          </span>
        )}
      </button>
    );
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && type !== 'textarea' && !(e.shiftKey)) {
      e.preventDefault();
      onCommit(draft);
    }
  }

  // Aktif edit durumunda kullanılan ✓ ve ✗ butonları
  const editControls = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-role="commit-draft"
        onMouseDown={(e) => {
          e.preventDefault();
          onCommit(draft);
        }}
        className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-200"
        title="Onayla (Enter)"
        aria-label="Onayla"
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
        className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-50 text-rose-600 ring-1 ring-rose-200 hover:bg-rose-100"
        title="İptal (ESC)"
        aria-label="İptal"
      >
        <X size={14} />
      </button>
    </div>
  );

  if (type === 'textarea') {
    return (
      <div className="rounded-md ring-2 ring-blue-500">
        <TextArea
          autoFocus
          value={String(draft ?? '')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            // Click outside iptal — eğer relatedTarget Kaydet/Voice butonuna gitmiyorsa
            const next = e.relatedTarget as HTMLElement | null;
            if (next?.dataset?.role === 'commit-draft' || next?.dataset?.role === 'voice-input') {
              onCommit(draft);
            } else {
              onCancel();
            }
          }}
          onKeyDown={handleKey}
          placeholder={placeholder}
          rows={4}
        />
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-slate-500">
          <VoiceNoteButton
            onTranscript={(chunk) =>
              setDraft((prev: unknown) => {
                const cur = String(prev ?? '');
                return cur ? `${cur} ${chunk}` : chunk;
              })
            }
          />
          <div className="flex items-center gap-2">
            <span>ESC iptal</span>
            {editControls}
          </div>
        </div>
      </div>
    );
  }

  if (type === 'select') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex-1 rounded-md ring-2 ring-blue-500">
          <Select
            autoFocus
            value={String(draft ?? '')}
            onChange={(e) => {
              setDraft(e.target.value);
              onCommit(e.target.value);
            }}
            onBlur={(e) => {
              const next = e.relatedTarget as HTMLElement | null;
              if (next?.dataset?.role === 'commit-draft') return; // commit zaten onChange'de
              onCancel();
            }}
            onKeyDown={handleKey}
          >
            {options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {editControls}
      </div>
    );
  }

  if (type === 'checkbox') {
    return (
      <div className="flex items-center gap-2 rounded-md px-2 py-1 ring-2 ring-blue-500">
        <input
          type="checkbox"
          autoFocus
          checked={Boolean(draft)}
          onChange={(e) => {
            setDraft(e.target.checked);
            onCommit(e.target.checked);
          }}
          onKeyDown={handleKey}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        <span className="flex-1 text-sm text-slate-700">{Boolean(draft) ? 'Var' : 'Yok'}</span>
        {editControls}
      </div>
    );
  }

  // text / date
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        type={type === 'date' ? 'date' : 'text'}
        value={String(draft ?? '')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const next = e.relatedTarget as HTMLElement | null;
          if (next?.dataset?.role === 'commit-draft') {
            onCommit(draft);
          } else {
            onCancel();
          }
        }}
        onKeyDown={handleKey}
        placeholder={placeholder}
        className="flex-1 rounded-md border border-blue-500 bg-white px-3 py-1.5 text-sm text-slate-800 ring-2 ring-blue-500/40 focus:outline-none dark:bg-ndark-card dark:text-ndark-text"
      />
      {editControls}
    </div>
  );
}

type ActivityFilter = 'all' | 'status' | 'assign' | 'files' | 'notes' | 'calls' | 'fields' | 'checklist';

interface FilterDef {
  key: ActivityFilter;
  label: string;
  types: CaseHistoryActionType[];
  /** Tailwind class'ları — chip aktif iken arka plan + nokta rengi */
  active: string;
  dot: string;
  /** Tailwind class'ları — chip pasif (renkli ama tonlu) */
  inactive: string;
  /** Custom matcher — types yetersizse (örn. Atama hem Transfer hem assignment FieldUpdate). */
  match?: (h: CaseHistoryEntry) => boolean;
}

// Atama filtresi için sayılan FieldUpdate alanları — bu alanlardaki değişimler
// "Atama"ya düşer, "Alan"a düşmez (BUG 2).
const ASSIGNMENT_FIELDS = new Set([
  'assignedPersonId',
  'assignedTeamId',
  'assignedPersonName',
  'assignedTeamName',
]);

const ACTIVITY_FILTERS: FilterDef[] = [
  { key: 'all',       label: 'Hepsi',   types: [],
    active:   'bg-slate-700 text-white shadow-sm',
    inactive: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
    dot:      'bg-slate-500' },
  { key: 'status',    label: 'Statü',   types: ['StatusChange', 'CaseCreated', 'SLAApplied'],
    active:   'bg-brand-600 text-white shadow-sm',
    inactive: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
    dot:      'bg-brand-500' },
  { key: 'assign',    label: 'Atama',   types: ['Transfer'],
    active:   'bg-amber-600 text-white shadow-sm',
    inactive: 'bg-amber-50 text-amber-700 hover:bg-amber-100',
    dot:      'bg-amber-500',
    match: (h) =>
      h.actionType === 'Transfer' ||
      (h.actionType === 'FieldUpdate' && ASSIGNMENT_FIELDS.has(h.fieldName ?? '')) },
  { key: 'files',     label: 'Dosya',   types: ['FileUploaded', 'FileRemoved'],
    active:   'bg-blue-600 text-white shadow-sm',
    inactive: 'bg-blue-50 text-blue-700 hover:bg-blue-100',
    dot:      'bg-blue-500' },
  { key: 'notes',     label: 'Not',     types: ['NoteAdded'],
    active:   'bg-emerald-600 text-white shadow-sm',
    inactive: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
    dot:      'bg-emerald-500' },
  { key: 'calls',     label: 'Çağrı',   types: ['CallLogAdded'],
    active:   'bg-violet-600 text-white shadow-sm',
    inactive: 'bg-violet-50 text-violet-700 hover:bg-violet-100',
    dot:      'bg-violet-500' },
  { key: 'fields',    label: 'Alan',    types: ['FieldUpdate'],
    active:   'bg-slate-600 text-white shadow-sm',
    inactive: 'bg-slate-100 text-slate-600 hover:bg-slate-200',
    dot:      'bg-slate-400',
    // Atamayla çift sayım olmasın — assignment field'lar "Atama"ya gider.
    match: (h) =>
      h.actionType === 'FieldUpdate' && !ASSIGNMENT_FIELDS.has(h.fieldName ?? '') },
  { key: 'checklist', label: 'Kontrol', types: ['ChecklistToggle'],
    active:   'bg-teal-600 text-white shadow-sm',
    inactive: 'bg-teal-50 text-teal-700 hover:bg-teal-100',
    dot:      'bg-teal-500' },
];

function matchesFilter(h: CaseHistoryEntry, f: FilterDef): boolean {
  if (f.match) return f.match(h);
  return !!h.actionType && f.types.includes(h.actionType);
}

/** Bir history entry için dot rengi — chip rengiyle eşleşmesi için custom matcher dahil. */
function dotColorFor(h: CaseHistoryEntry): string {
  if (!h.actionType) return 'bg-slate-400';
  const def = ACTIVITY_FILTERS.find((f) => f.key !== 'all' && matchesFilter(h, f));
  return def?.dot ?? 'bg-slate-400';
}

function ActivityTab({ item }: { item: Case }) {
  const [filter, setFilter] = useState<ActivityFilter>('all');

  // Her filtre için sayım — chip'in yanında badge olarak gösterilir
  const counts = useMemo(() => {
    const map: Record<ActivityFilter, number> = {
      all: item.history.length, status: 0, assign: 0, files: 0,
      notes: 0, calls: 0, fields: 0, checklist: 0,
    };
    for (const h of item.history) {
      for (const f of ACTIVITY_FILTERS) {
        if (f.key === 'all') continue;
        if (matchesFilter(h, f)) map[f.key]++;
      }
    }
    return map;
  }, [item.history]);

  const filtered = useMemo(() => {
    if (filter === 'all') return item.history;
    const def = ACTIVITY_FILTERS.find((f) => f.key === filter);
    if (!def) return item.history;
    return item.history.filter((h) => matchesFilter(h, def));
  }, [item.history, filter]);

  return (
    <div className="space-y-3">
      {/* Filtre chip'leri — her tipin kendi rengi, aktif iken doygun, pasifte tonlu */}
      <div className="flex flex-wrap gap-1.5">
        {ACTIVITY_FILTERS.map((f) => {
          const n = counts[f.key];
          const isActive = filter === f.key;
          const isDisabled = n === 0 && f.key !== 'all';
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => !isDisabled && setFilter(f.key)}
              disabled={isDisabled}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                isActive
                  ? f.active
                  : isDisabled
                    ? 'bg-slate-50 text-slate-400 cursor-not-allowed'
                    : f.inactive
              }`}
            >
              {f.label}
              <span
                className={`rounded-full px-1.5 py-0 text-[10px] ${
                  isActive ? 'bg-white/25 text-white' : 'bg-white/80 text-slate-600'
                }`}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          Bu filtreyle eşleşen kayıt yok.
        </p>
      ) : (
        <ol className="relative space-y-3 border-l-2 border-slate-200 pl-4">
          {filtered.map((h) => {
        // Dosya yüklendi/silindi — özel render: kâğıt ikonu, dosya adı vurgulu.
        if (h.actionType === 'FileUploaded' || h.actionType === 'FileRemoved') {
          const isUpload = h.actionType === 'FileUploaded';
          const fileName = isUpload ? h.toValue : h.fromValue;
          return (
            <li key={h.id} className="relative">
              <span
                className={`absolute -left-[22px] top-1.5 inline-block h-3 w-3 rounded-full ring-4 ring-white ${
                  isUpload ? 'bg-blue-500' : 'bg-rose-500'
                }`}
              />
              <div
                className={`rounded-md border px-3 py-2 ${
                  isUpload ? 'border-blue-200 bg-blue-50/60' : 'border-rose-200 bg-rose-50/60'
                }`}
              >
                <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                  <Paperclip size={12} className={isUpload ? 'text-blue-700' : 'text-rose-700'} />
                  <span className={`font-medium ${isUpload ? 'text-blue-900' : 'text-rose-900'}`}>
                    {isUpload ? 'Dosya yüklendi:' : 'Dosya silindi:'}
                  </span>
                  <span
                    className={
                      isUpload
                        ? 'font-semibold text-slate-800'
                        : 'text-slate-700 line-through decoration-slate-300'
                    }
                  >
                    {fileName ?? '—'}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                  <Calendar size={11} />
                  <span>{formatDateTime(h.at)}</span>
                  <span>·</span>
                  <span>{h.actor}</span>
                </div>
              </div>
            </li>
          );
        }

        // Transfer aksiyonları için blue-tint custom render — diğer log'lardan ayrışsın.
        if (h.actionType === 'Transfer') {
          return (
            <li key={h.id} className="relative">
              <span className="absolute -left-[22px] top-1.5 inline-block h-3 w-3 rounded-full bg-blue-500 ring-4 ring-white dark:ring-ndark-bg" />
              <div className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 dark:border-blue-900/40 dark:bg-blue-950/20">
                <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                  <span className="inline-flex items-center gap-1 font-medium text-blue-900 dark:text-blue-200">
                    <ArrowRightLeft size={12} /> Aktarıldı:
                  </span>
                  <span className="text-slate-700 line-through decoration-slate-300 dark:text-ndark-muted">{h.fromValue ?? '—'}</span>
                  <span className="text-slate-400">→</span>
                  <span className="font-semibold text-slate-800 dark:text-ndark-text">{h.toValue}</span>
                </div>
                {h.note && (
                  <p className="mt-1 text-xs italic text-blue-800 dark:text-blue-300">{h.note}</p>
                )}
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-ndark-muted">
                  <Calendar size={11} />
                  <span>{formatDateTime(h.at)}</span>
                  <span>·</span>
                  <span>{h.actor}</span>
                </div>
              </div>
            </li>
          );
        }

        const fieldLabel = h.fieldName ? CASE_FIELD_LABELS[h.fieldName] ?? h.fieldName : null;
        const hasFrom = h.fromValue != null && h.fromValue !== '' && h.fromValue !== '—';
        const hasTo = h.toValue != null && h.toValue !== '';
        return (
          <li key={h.id} className="relative">
            <span
              className={`absolute -left-[22px] top-1.5 inline-block h-3 w-3 rounded-full ring-4 ring-white ${dotColorFor(h)}`}
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              <span className="font-medium text-slate-800">{h.action}</span>
              {fieldLabel && (
                <span className="text-xs font-medium text-slate-500">{fieldLabel}{hasTo ? ':' : ''}</span>
              )}
              {hasFrom && hasTo && (
                <span className="inline-flex items-baseline gap-1.5 text-xs">
                  <span className="text-slate-500 line-through decoration-slate-300">{h.fromValue}</span>
                  <span className="text-slate-400">→</span>
                  <span className="font-medium text-slate-800">{h.toValue}</span>
                </span>
              )}
              {!hasFrom && hasTo && (
                <span className="text-xs font-medium text-slate-800">{h.toValue}</span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
              <Calendar size={11} />
              <span>{formatDateTime(h.at)}</span>
              <span>·</span>
              <span>{h.actor}</span>
            </div>
          </li>
        );
          })}
        </ol>
      )}
    </div>
  );
}

// İsmin baş harfine göre avatar arka plan rengi (solid).
// Yumuşak palet — yüksek-doygun marka renkleri (Tailwind 600 tonu).
// Türkçe karakterler (Ç,Ş,Ğ,Ü,Ö,İ) telaffuz yakınlığıyla Latin grubuna düşer.
function avatarColor(name: string): string {
  const ch = (name?.trim()?.[0] ?? 'A').toLocaleUpperCase('tr');
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 69)  return '#7C3AED'; // A-E violet
  if (code >= 70 && code <= 74)  return '#2563EB'; // F-J blue
  if (code >= 75 && code <= 79)  return '#059669'; // K-O emerald
  if (code >= 80 && code <= 84)  return '#D97706'; // P-T amber
  if (code >= 85 && code <= 90)  return '#E11D48'; // U-Z rose
  // Türkçe özel karakterler:
  if (ch === 'Ç') return '#7C3AED'; // C grubu
  if (ch === 'Ğ') return '#2563EB'; // G grubu
  if (ch === 'İ') return '#2563EB'; // I grubu
  if (ch === 'Ö') return '#059669'; // O grubu
  if (ch === 'Ş') return '#D97706'; // S grubu
  if (ch === 'Ü') return '#E11D48'; // U grubu
  return '#64748B'; // slate-500 fallback (non-Latin)
}

function avatarInitials(name: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toLocaleUpperCase('tr');
  return (parts[0][0] + parts[parts.length - 1][0]).toLocaleUpperCase('tr');
}

function NoteAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const bg = avatarColor(name);
  const initials = avatarInitials(name);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white shadow-sm ring-2 ring-white dark:ring-ndark-card"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize: size <= 28 ? 11 : size <= 36 ? 13 : 14,
      }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

function NotesTab({
  item,
  noteText,
  noteVisibility,
  onChangeText,
  onChangeVisibility,
  onSubmit,
  onReplyAdded,
  inputRef,
}: {
  item: Case;
  noteText: string;
  noteVisibility: NoteVisibility;
  onChangeText: (s: string) => void;
  onChangeVisibility: (v: NoteVisibility) => void;
  onSubmit: () => void;
  onReplyAdded: (parentNoteId: string) => void;
  inputRef: React.RefObject<MentionTextareaHandle>;
}) {
  const [voiceListening, setVoiceListening] = useState(false);
  const { user } = useAuth();
  const currentName = user?.fullName ?? 'Ben';

  return (
    <div className="space-y-4">
      {/* Yeni not kartı — dashed border (yazma alanı vurgusu) */}
      <div className="rounded-xl border-2 border-dashed border-slate-200 bg-white p-4 transition focus-within:border-brand-400 dark:border-ndark-border dark:bg-ndark-card dark:focus-within:border-brand-500">
        <div className="flex items-start gap-3">
          <NoteAvatar name={currentName} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500 dark:text-ndark-muted">
                {currentName} yanıtlıyor…
              </span>
              <VoiceNoteButton
                onTranscript={(chunk) => onChangeText(noteText ? `${noteText} ${chunk}` : chunk)}
                onListeningChange={setVoiceListening}
              />
            </div>
            <div className="mt-1.5">
              <MentionTextarea
                ref={inputRef}
                caseId={item.id}
                value={noteText}
                onChange={onChangeText}
                placeholder={voiceListening ? 'Dinleniyor…' : 'Not yazın — @ ile kişi etiketleyebilirsiniz…'}
                rows={3}
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs">
                <button
                  onClick={() => onChangeVisibility('Internal')}
                  className={
                    'rounded-full px-2.5 py-1 font-medium transition ' +
                    (noteVisibility === 'Internal'
                      ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-900/40'
                      : 'text-slate-500 hover:bg-slate-100 dark:text-ndark-muted dark:hover:bg-ndark-card')
                  }
                >
                  İç Not
                </button>
                <button
                  onClick={() => onChangeVisibility('Customer')}
                  className={
                    'rounded-full px-2.5 py-1 font-medium transition ' +
                    (noteVisibility === 'Customer'
                      ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-900/40'
                      : 'text-slate-500 hover:bg-slate-100 dark:text-ndark-muted dark:hover:bg-ndark-card')
                  }
                >
                  Müşteriye Görünür
                </button>
              </div>
              <Button
                size="sm"
                onClick={onSubmit}
                disabled={!noteText.trim()}
                leftIcon={<Send size={14} />}
              >
                Not Ekle
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Not akışı — kart kart */}
      {item.notes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-300 dark:bg-ndark-card dark:text-ndark-muted">
            <MessageSquare size={28} />
          </div>
          <p className="mt-3 text-sm font-medium text-slate-600 dark:text-ndark-text">
            Henüz not eklenmemiş
          </p>
          <p className="mt-1 text-xs text-slate-400 dark:text-ndark-muted">
            @ ile ekip üyelerini etiketleyebilirsiniz
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {item.notes.map((n) => (
            <NoteCard
              key={n.id}
              caseId={item.id}
              note={n}
              currentName={currentName}
              onReplyAdded={onReplyAdded}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * NoteReactions — bir notenun (top-level veya reply) reaksiyon chip'leri + picker.
 * Optimistic update: tiklamada local state hemen toggle olur, API arka planda;
 * backend hata verirse local state geri alinir.
 */
function NoteReactions({
  caseId,
  noteId,
  initial,
  size = 'md',
}: {
  caseId: string;
  noteId: string;
  initial: import('./types').CaseNoteReactionRow[];
  size?: 'sm' | 'md';
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // initial degisirse (case re-fetch sonrasi) state'i resync et
  useEffect(() => {
    setRows(initial);
  }, [initial]);

  // Outside click → picker kapanir
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (!pickerRef.current?.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [pickerOpen]);

  // Aggregate: emoji → { count, mine }
  const grouped = useMemo(() => {
    const map = new Map<NoteReactionEmoji, { count: number; mine: boolean }>();
    for (const r of rows) {
      const cur = map.get(r.emoji) ?? { count: 0, mine: false };
      cur.count += 1;
      if (user && r.userId === user.id) cur.mine = true;
      map.set(r.emoji, cur);
    }
    return map;
  }, [rows, user]);

  // Picker'da kullanici henuz vermedigi emoji'leri secebilsin diye:
  // tum whitelist'i goster, mevcut/yok ayrimi chip'lerde gozukur.
  const visibleEmojis: NoteReactionEmoji[] = NOTE_REACTION_EMOJIS.filter((e) => grouped.has(e));

  async function toggle(emoji: NoteReactionEmoji) {
    if (!user) return;
    setPickerOpen(false);

    const cur = grouped.get(emoji);
    const willRemove = cur?.mine ?? false;
    const tempId = `temp-${Date.now()}`;

    // Optimistic — functional update; revert sirasinda da functional update
    // ile sadece bu kullanicinin bu emoji'sini geri al/koy. Araya baska
    // (websocket/poll) update girse bile bozulmaz. (Smoke Audit P1.6)
    setRows((prev) =>
      willRemove
        ? prev.filter((r) => !(r.emoji === emoji && r.userId === user.id))
        : [...prev, { id: tempId, userId: user.id, emoji }],
    );

    const res = await caseService.toggleReaction(caseId, noteId, emoji);
    if (!res) {
      // Targeted revert — sadece optimistic mutasyonu geri al.
      setRows((prev) =>
        willRemove
          ? // remove'u geri al: emoji + user kombinasyonu hala yoksa ekle
            prev.some((r) => r.emoji === emoji && r.userId === user.id)
            ? prev
            : [...prev, { id: tempId, userId: user.id, emoji }]
          : // add'i geri al: temp id'yi (yoksa ilk eslesen) sil
            prev.filter((r) => r.id !== tempId),
      );
      toast({ type: 'error', message: 'Reaksiyon kaydedilemedi.' });
    }
  }

  const chipBase =
    size === 'sm'
      ? 'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] transition'
      : 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition';
  const triggerBase =
    size === 'sm'
      ? 'inline-flex items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 transition hover:border-brand-400 hover:text-brand-500 dark:border-ndark-border dark:text-ndark-muted dark:hover:border-brand-500 dark:hover:text-brand-400'
      : 'inline-flex items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 transition hover:border-brand-400 hover:text-brand-500 dark:border-ndark-border dark:text-ndark-muted dark:hover:border-brand-500 dark:hover:text-brand-400';
  const triggerSize = size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';

  return (
    <div className="relative mt-2 flex flex-wrap items-center gap-1">
      {visibleEmojis.map((e) => {
        const meta = NOTE_REACTION_META[e];
        const info = grouped.get(e)!;
        const mine = info.mine;
        const cls = mine
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/60 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-ndark-border dark:bg-ndark-bg/40 dark:text-ndark-muted dark:hover:bg-ndark-card';
        return (
          <button
            key={e}
            type="button"
            onClick={() => toggle(e)}
            className={chipBase + ' ' + cls}
            title={meta.label}
          >
            <span aria-hidden>{meta.symbol}</span>
            <span className="tabular-nums">{info.count}</span>
          </button>
        );
      })}

      <div ref={pickerRef} className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className={triggerBase + ' ' + triggerSize}
          title="Reaksiyon ekle"
          aria-label="Reaksiyon ekle"
        >
          <SmilePlus size={size === 'sm' ? 11 : 13} />
        </button>
        {pickerOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-1 flex items-center gap-1 rounded-full border border-slate-200 bg-white px-1.5 py-1 shadow-md dark:border-ndark-border dark:bg-ndark-card">
            {NOTE_REACTION_EMOJIS.map((e) => {
              const meta = NOTE_REACTION_META[e];
              const mine = grouped.get(e)?.mine ?? false;
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggle(e)}
                  className={
                    'rounded-full px-1.5 py-0.5 text-base transition ' +
                    (mine
                      ? 'bg-brand-100 dark:bg-brand-500/20'
                      : 'hover:bg-slate-100 dark:hover:bg-ndark-bg')
                  }
                  title={meta.label}
                  aria-label={meta.label}
                >
                  {meta.symbol}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * NoteCard — parent note + thread (yanıtlar) + reply composer.
 * Yanıtlar lazy fetch edilir (kullanıcı "X yanıt" linkine bastığında).
 */
function NoteCard({
  caseId,
  note,
  currentName,
  onReplyAdded,
}: {
  caseId: string;
  note: CaseNote;
  currentName: string;
  onReplyAdded: (parentNoteId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replies, setReplies] = useState<CaseNote[] | null>(null);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const { toast } = useToast();

  const isInternal = note.visibility === 'Internal';
  const pill = isInternal
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
  const replyCount = note.replyCount ?? 0;

  async function loadReplies() {
    setLoadingReplies(true);
    try {
      const r = await caseService.listReplies(caseId, note.id);
      setReplies(r);
    } catch {
      toast({ type: 'error', message: 'Yanıtlar yüklenemedi.' });
    } finally {
      setLoadingReplies(false);
    }
  }

  function toggleThread() {
    const next = !expanded;
    setExpanded(next);
    if (next && replies === null) {
      void loadReplies();
    }
  }

  async function handleSubmitReply(content: string, visibility: NoteVisibility) {
    const created = await caseService.addReply(caseId, note.id, {
      content,
      visibility,
      authorName: currentName,
    });
    if (!created) return false;
    // Thread'i guncelle — yeni reply en sona eklenir (createdAt ASC)
    setReplies((prev) => (prev ? [...prev, created] : [created]));
    setExpanded(true);
    setComposerOpen(false);
    onReplyAdded(note.id);
    toast({
      type: 'success',
      message: visibility === 'Internal' ? 'İç yanıt eklendi.' : 'Müşteriye görünür yanıt eklendi.',
      duration: 2500,
    });
    return true;
  }

  return (
    <li className="group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md dark:border-ndark-border dark:bg-ndark-card">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <NoteAvatar name={note.authorName} size={40} />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-slate-900 dark:text-ndark-text">
            {note.authorName}
          </span>
          <span
            className={
              'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ' + pill
            }
          >
            {isInternal ? 'İç Not' : 'Müşteriye Görünür'}
          </span>
        </div>
        <span
          className="shrink-0 text-xs text-slate-400 dark:text-ndark-muted"
          title={formatDateTime(note.createdAt)}
        >
          {formatRelative(note.createdAt)}
        </span>
      </div>

      {/* Body */}
      <div className="border-t border-slate-100 px-4 pt-3 pb-3 dark:border-ndark-border/60">
        <MentionContent
          content={note.content}
          className="text-sm leading-relaxed text-slate-700 dark:text-slate-300"
        />

        {/* Reaksiyon chip'leri + picker */}
        <NoteReactions
          caseId={caseId}
          noteId={note.id}
          initial={note.reactions ?? []}
        />

        {/* Aksiyon satiri — Yanitla + thread aç/kapa */}
        <div className="mt-3 flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => setComposerOpen((v) => !v)}
            className="inline-flex items-center gap-1 font-medium text-slate-500 transition hover:text-brand-600 dark:text-ndark-muted dark:hover:text-brand-400"
          >
            <CornerDownRight size={13} />
            Yanıtla
          </button>
          {replyCount > 0 && (
            <button
              type="button"
              onClick={toggleThread}
              className="inline-flex items-center gap-1 font-medium text-brand-600 transition hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
            >
              <MessageSquare size={13} />
              {replyCount} yanıt {expanded ? '▴' : '▾'}
            </button>
          )}
        </div>
      </div>

      {/* Thread — açıldığında reply'lar */}
      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 dark:border-ndark-border/60 dark:bg-ndark-bg/40">
          {loadingReplies && replies === null ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {(replies ?? []).map((r) => (
                <ReplyItem key={r.id} caseId={caseId} reply={r} parentAuthor={note.authorName} />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Reply composer — inline */}
      {composerOpen && (
        <ReplyComposer
          caseId={caseId}
          parentAuthor={note.authorName}
          parentVisibility={note.visibility}
          currentName={currentName}
          onCancel={() => setComposerOpen(false)}
          onSubmit={handleSubmitReply}
        />
      )}
    </li>
  );
}

function ReplyItem({ caseId, reply, parentAuthor }: { caseId: string; reply: CaseNote; parentAuthor: string }) {
  const isInternal = reply.visibility === 'Internal';
  const pill = isInternal
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
  return (
    <li className="rounded-lg border-l-2 border-brand-400 bg-white px-3 py-2 shadow-sm dark:border-brand-500 dark:bg-ndark-card">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400 dark:text-ndark-muted">
        <CornerDownRight size={11} />
        <span className="font-medium text-slate-500 dark:text-ndark-muted">
          {parentAuthor}
        </span>
        <span>'a yanıt</span>
      </div>
      <div className="flex items-center gap-2">
        <NoteAvatar name={reply.authorName} size={28} />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-slate-900 dark:text-ndark-text">
            {reply.authorName}
          </span>
          <span
            className={
              'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ' + pill
            }
          >
            {isInternal ? 'İç' : 'Müşteri'}
          </span>
        </div>
        <span
          className="shrink-0 text-[11px] text-slate-400 dark:text-ndark-muted"
          title={formatDateTime(reply.createdAt)}
        >
          {formatRelative(reply.createdAt)}
        </span>
      </div>
      <div className="mt-1.5 pl-9">
        <MentionContent
          content={reply.content}
          className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300"
        />
        <NoteReactions
          caseId={caseId}
          noteId={reply.id}
          initial={reply.reactions ?? []}
          size="sm"
        />
      </div>
    </li>
  );
}

function ReplyComposer({
  caseId,
  parentAuthor,
  parentVisibility,
  currentName,
  onCancel,
  onSubmit,
}: {
  caseId: string;
  parentAuthor: string;
  parentVisibility: NoteVisibility;
  currentName: string;
  onCancel: () => void;
  onSubmit: (content: string, visibility: NoteVisibility) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  // Reply parent visibility'i miras alir; kullanici degistirebilir.
  const [visibility, setVisibility] = useState<NoteVisibility>(parentVisibility);
  const [busy, setBusy] = useState(false);
  const composerRef = useRef<MentionTextareaHandle>(null);
  useEffect(() => {
    composerRef.current?.focus();
  }, []);
  return (
    <div className="border-t border-slate-100 bg-slate-50/80 px-4 py-3 dark:border-ndark-border/60 dark:bg-ndark-bg/40">
      <div className="flex items-start gap-2">
        <NoteAvatar name={currentName} size={28} />
        <div className="min-w-0 flex-1">
          <MentionTextarea
            ref={composerRef}
            caseId={caseId}
            value={text}
            onChange={setText}
            placeholder={`${parentAuthor}'a yanıt yazın — @ ile kişi etiketleyebilirsiniz…`}
            rows={2}
          />
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => setVisibility('Internal')}
                className={
                  'rounded-full px-2 py-0.5 font-medium transition ' +
                  (visibility === 'Internal'
                    ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-900/40'
                    : 'text-slate-500 hover:bg-slate-100 dark:text-ndark-muted dark:hover:bg-ndark-card')
                }
              >
                İç Not
              </button>
              <button
                type="button"
                onClick={() => setVisibility('Customer')}
                className={
                  'rounded-full px-2 py-0.5 font-medium transition ' +
                  (visibility === 'Customer'
                    ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-900/40'
                    : 'text-slate-500 hover:bg-slate-100 dark:text-ndark-muted dark:hover:bg-ndark-card')
                }
              >
                Müşteriye Görünür
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
                İptal
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  if (!text.trim() || busy) return;
                  setBusy(true);
                  const ok = await onSubmit(text.trim(), visibility);
                  if (ok) setText('');
                  setBusy(false);
                }}
                disabled={!text.trim() || busy}
                leftIcon={<Send size={13} />}
              >
                {busy ? 'Gönderiliyor…' : 'Yanıtla'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface UploadProgress {
  fileName: string;
  fileSize: number;
  percent: number;
  status: 'queued' | 'uploading' | 'finalizing' | 'done' | 'error';
  errorMessage?: string;
}

function FilesTab({
  item,
  onItemUpdated,
}: {
  item: Case;
  onItemUpdated: (c: Case) => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadProgress[]>([]);

  const remainingSlots = CASE_FILE_MAX_COUNT - item.files.length;
  const maxMb = Math.round(CASE_FILE_MAX_SIZE / (1024 * 1024));

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    if (list.length > remainingSlots) {
      toast({
        type: 'warn',
        message: `Bu vakaya en fazla ${remainingSlots} dosya daha eklenebilir (toplam limit ${CASE_FILE_MAX_COUNT}).`,
      });
      return;
    }

    const oversized = list.filter((f) => f.size > CASE_FILE_MAX_SIZE);
    if (oversized.length > 0) {
      toast({
        type: 'error',
        message: `${oversized.length} dosya ${maxMb} MB sınırını aşıyor: ${oversized.map((f) => f.name).join(', ')}`,
      });
      return;
    }

    setUploading(true);
    // Kuyruk başlangıç durumu
    setUploadQueue(
      list.map((f) => ({
        fileName: f.name,
        fileSize: f.size,
        percent: 0,
        status: 'queued',
      })),
    );

    let lastCase: Case | null = null;
    let successCount = 0;
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      // Bu dosya yüklenmeye başladı
      setUploadQueue((q) =>
        q.map((u, idx) => (idx === i ? { ...u, status: 'uploading' } : u)),
      );

      const result = await caseService.addFile(item.id, file, (percent) => {
        setUploadQueue((q) =>
          q.map((u, idx) =>
            idx === i ? { ...u, percent, status: percent >= 100 ? 'finalizing' : 'uploading' } : u,
          ),
        );
      });

      if (!result || 'error' in result) {
        const errMsg = result && 'error' in result ? result.error : 'Yükleme başarısız';
        setUploadQueue((q) =>
          q.map((u, idx) => (idx === i ? { ...u, status: 'error', errorMessage: errMsg } : u)),
        );
        if (result && 'error' in result) {
          toast({ type: 'error', message: result.error });
        }
        continue;
      }

      setUploadQueue((q) =>
        q.map((u, idx) => (idx === i ? { ...u, status: 'done', percent: 100 } : u)),
      );
      lastCase = result.caseUpdated;
      successCount += 1;
    }

    setUploading(false);

    if (lastCase) onItemUpdated(lastCase);
    if (successCount > 0) {
      toast({
        type: 'success',
        message:
          successCount === 1
            ? 'Dosya yüklendi ✓'
            : `${successCount} dosya yüklendi ✓`,
        duration: 2000,
      });
    }

    // Kuyruk 3 saniye sonra otomatik temizlenir (kullanıcı sonucu görsün)
    window.setTimeout(() => setUploadQueue([]), 3000);
  }

  async function handleRemove(file: CaseFile) {
    if (!window.confirm(`"${file.fileName}" dosyasını silmek istediğinizden emin misiniz?`)) {
      return;
    }
    const updated = await caseService.removeFile(item.id, file.id);
    if (updated) {
      onItemUpdated(updated);
      toast({ type: 'success', message: 'Dosya silindi.', duration: 2000 });
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) {
      void uploadFiles(e.dataTransfer.files);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Maks. {maxMb} MB / dosya · {CASE_FILE_MAX_COUNT} dosya / vaka.{' '}
          <span className="text-slate-400">
            ({item.files.length}/{CASE_FILE_MAX_COUNT})
          </span>
        </p>
        <Button
          size="sm"
          variant="outline"
          leftIcon={<UploadCloud size={12} />}
          onClick={() => inputRef.current?.click()}
          disabled={uploading || remainingSlots <= 0}
        >
          {uploading ? 'Yükleniyor…' : 'Dosya Seç'}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center text-sm transition ${
          dragActive
            ? 'border-brand-500 bg-brand-50 text-brand-700'
            : 'border-slate-300 bg-slate-50/50 text-slate-500 hover:border-brand-400 hover:bg-brand-50/40'
        }`}
      >
        <UploadCloud size={20} className={dragActive ? 'text-brand-600' : 'text-slate-400'} />
        <span>
          Dosyaları buraya sürükleyin veya{' '}
          <span className="font-medium text-brand-700">tıklayın</span>
        </span>
        <span className="text-[11px] text-slate-400">
          Birden fazla dosya seçilebilir
        </span>
      </div>

      {/* Yükleme kuyruğu — her dosya için canlı progress bar */}
      {uploadQueue.length > 0 && (
        <ul className="space-y-2 rounded-md bg-slate-50/80 p-2 ring-1 ring-slate-200">
          {uploadQueue.map((u, i) => {
            const statusLabel: Record<UploadProgress['status'], string> = {
              queued: 'Sırada bekliyor',
              uploading: `Yükleniyor… %${u.percent}`,
              finalizing: 'Kaydediliyor…',
              done: 'Yüklendi ✓',
              error: u.errorMessage ?? 'Hata',
            };
            const barColor =
              u.status === 'error'
                ? 'bg-rose-500'
                : u.status === 'done'
                  ? 'bg-emerald-500'
                  : 'bg-brand-500';
            return (
              <li key={`${u.fileName}-${i}`} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 truncate text-slate-700">
                    <Paperclip size={11} className="flex-shrink-0 text-slate-400" />
                    <span className="truncate font-medium">{u.fileName}</span>
                    <span className="flex-shrink-0 text-slate-400">({formatBytes(u.fileSize)})</span>
                  </span>
                  <span
                    className={`flex-shrink-0 font-medium ${
                      u.status === 'error'
                        ? 'text-rose-600'
                        : u.status === 'done'
                          ? 'text-emerald-600'
                          : 'text-brand-700'
                    }`}
                  >
                    {statusLabel[u.status]}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={`h-full ${barColor} transition-all duration-200`}
                    style={{
                      width:
                        u.status === 'finalizing' || u.status === 'done'
                          ? '100%'
                          : u.status === 'error'
                            ? '100%'
                            : `${u.percent}%`,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {item.files.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">Henüz dosya yok.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md ring-1 ring-slate-200">
          {item.files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Paperclip size={14} className="text-slate-400" />
              <span className="flex-1 truncate text-slate-800" title={f.fileName}>
                {f.fileName}
              </span>
              <span className="hidden text-xs text-slate-500 sm:inline">
                {formatBytes(f.fileSize)}
              </span>
              <span className="hidden text-xs text-slate-500 md:inline">
                {formatDateTime(f.uploadedAt)}
              </span>
              <button
                type="button"
                onClick={() => void caseService.downloadFile(item.id, f.id)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-700"
                title="İndir"
              >
                <Download size={12} />
              </button>
              <button
                type="button"
                onClick={() => handleRemove(f)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50"
                title="Sil"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CallLogsTab({
  item,
  onAddCallLog,
}: {
  item: Case;
  onAddCallLog: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Çağrı kayıtları — toplam <strong>{item.callLogs.length}</strong>.
        </p>
        <Button size="sm" variant="outline" leftIcon={<Mic size={12} />} onClick={onAddCallLog}>
          Çağrı Notu Gir
        </Button>
      </div>
      {item.callLogs.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">Çağrı kaydı yok.</p>
      ) : (
        <ul className="space-y-2">
          {item.callLogs.map((cl) => (
            <li key={cl.id} className="rounded-md bg-violet-50/40 px-3 py-2 ring-1 ring-violet-200">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-800">{cl.callerName}</span>
                <span className="text-[11px] text-slate-500">
                  {formatDateTime(cl.callDate)} · {cl.durationMin} dk
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tint="violet">{cl.callDisposition}</Badge>
                <Badge tint="slate">{cl.callOutcome}</Badge>
                {cl.nextFollowupDate && (
                  <span className="text-[11px] text-slate-600">
                    Sonraki: {formatDateTime(cl.nextFollowupDate)}
                  </span>
                )}
              </div>
              {cl.description && (
                <p className="mt-1.5 text-xs text-slate-700">{cl.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewCallLogModal({
  open,
  item,
  prefillDurationMin,
  onClose,
  onCreated,
}: {
  open: boolean;
  item: Case;
  /** Çağrı sonlandığında handleEndCall'dan gelen dakika sayısı — varsa initial state'i bununla doldur. */
  prefillDurationMin?: number;
  onClose: () => void;
  onCreated: (c: Case) => void;
}) {
  const [callerName, setCallerName] = useState('');
  const [durationMin, setDurationMin] = useState(5);
  const [disposition, setDisposition] = useState<CallDisposition>('Cevapladı');
  const [outcome, setOutcome] = useState<CallOutcome>('Memnun');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setCallerName('');
      setDurationMin(prefillDurationMin ?? 5);
      setDisposition('Cevapladı');
      setOutcome('Memnun');
      setDescription('');
    }
  }, [open, prefillDurationMin]);

  async function handleSave() {
    if (!callerName.trim()) {
      toast({ type: 'warn', message: 'Arayan / muhatap adı zorunlu.' });
      return;
    }
    setSubmitting(true);
    const trimmedDescription = description.trim();
    const r = await caseService.addCallLog(item.id, {
      callerName: callerName.trim(),
      durationMin,
      callDisposition: disposition,
      callOutcome: outcome,
      description: trimmedDescription || undefined,
    });
    if (!r) {
      setSubmitting(false);
      toast({ type: 'error', message: 'Çağrı kaydı eklenemedi.' });
      return;
    }
    // Mention mirror — call log description'da @[Name](userId) varsa BE'nin
    // CaseMention parse'ı yan-bir Internal not aracılığıyla tetiklenir.
    // (addCallLog endpoint'i mention parse etmiyor; addNote ediyor.)
    if (trimmedDescription && /@\[[^\]]+\]\([^)]+\)/.test(trimmedDescription)) {
      await caseService.addNote(item.id, {
        content: `Çağrı kaydı (${callerName.trim()}): ${trimmedDescription}`,
        visibility: 'Internal',
        authorName: 'Mock User',
      });
    }
    onCreated(r.caseUpdated);
    onClose();
    setSubmitting(false);
    toast({ type: 'success', message: 'Çağrı kaydedildi. AI özet hazırlanıyor…', duration: 1800 });

    // Auto-summarize: arka planda; sonuç gelince case'in aiCallBrief alanı güncellenir.
    void (async () => {
      const aiR = await aiService.callSummary({
        callLog: {
          note: r.callLog.description,
          outcome: r.callLog.callOutcome,
          disposition: r.callLog.callDisposition,
        },
        caseSubject: item.title,
        customerName: item.accountName,
      });
      if (aiR.ok && aiR.data.summary) {
        const updated = await caseService.update(item.id, { aiCallBrief: aiR.data.summary });
        if (updated) {
          onCreated(updated);
          toast({ type: 'success', message: 'Çağrı özeti AI tarafından hazırlandı.', duration: 2000 });
        }
      } else if (!aiR.ok) {
        // Sessiz fail — UI'da call log zaten var
        if (aiR.error.kind !== 'unconfigured') {
          toast({ type: 'warn', message: aiErrorMessage(aiR.error), duration: 2200 });
        }
      }
    })();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Çağrı Kaydı Ekle"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Vazgeç
          </Button>
          <Button onClick={handleSave} disabled={submitting || !callerName.trim()}>
            {submitting ? 'Kaydediliyor…' : 'Kaydet'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Muhatap" required>
          <TextInput
            autoFocus
            placeholder="ör. Ayşe Yılmaz"
            value={callerName}
            onChange={(e) => setCallerName(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Süre (dk)" required>
            <TextInput
              type="number"
              min={1}
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value) || 0)}
            />
          </Field>
          <Field label="Çağrı Sonucu" required>
            <Select
              value={disposition}
              onChange={(e) => setDisposition(e.target.value as CallDisposition)}
            >
              {CALL_DISPOSITIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Müşteri Tepkisi" required>
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value as CallOutcome)}>
              {CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Açıklama"
          hint="AI bu metni özetleyerek aiCallBrief alanına yazacak. @ ile takım arkadaşını etiketleyebilirsin."
          actions={
            <VoiceNoteButton
              onTranscript={(chunk) =>
                setDescription((t) => (t ? `${t} ${chunk}` : chunk))
              }
            />
          }
        >
          <MentionTextarea
            caseId={item.id}
            value={description}
            onChange={setDescription}
            rows={4}
            placeholder="Çağrıda ne konuşuldu, hangi karar verildi… (@ekip arkadaşı)"
          />
        </Field>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function Section({
  title,
  tint = 'default',
  children,
}: {
  title: string;
  tint?: 'default' | 'violet' | 'rose' | 'emerald';
  children: React.ReactNode;
}) {
  const ring =
    tint === 'violet'  ? 'ring-violet-200 bg-violet-50/30' :
    tint === 'rose'    ? 'ring-rose-200 bg-rose-50/30' :
    tint === 'emerald' ? 'ring-emerald-200 bg-emerald-50/30' :
                          'ring-slate-200 bg-white';
  return (
    <section className={`rounded-lg p-4 ring-1 ring-inset ${ring}`}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</h3>
      {children}
    </section>
  );
}

function DetailGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-md ring-1 ring-slate-200 sm:grid-cols-2">
      {rows.map(([label, value], i) => (
        <div
          key={label}
          className={`flex flex-col gap-0.5 px-3 py-2 ${
            i < rows.length - 1 ? 'border-b border-slate-100 sm:border-b-0' : ''
          }`}
        >
          <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className="text-sm text-slate-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EditableGrid({ rows }: { rows: { label: string; node: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-md ring-1 ring-slate-200 sm:grid-cols-2">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={`flex flex-col gap-0.5 px-2 py-1.5 ${
            i < rows.length - 1 ? 'border-b border-slate-100 sm:border-b-0' : ''
          }`}
        >
          <dt className="px-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">{r.label}</dt>
          <dd>{r.node}</dd>
        </div>
      ))}
    </dl>
  );
}
