import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Save, Info } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextArea, TextInput } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/services/AuthContext';
import {
  adminService,
  type ExternalKbAuthType,
  type ExternalKbSetting,
  type ExternalKbSettingInput,
} from '@/services/adminService';
import { lookupService } from '@/services/caseService';

/**
 * WR-KB1 — Dış Bilgi Bankası Entegrasyonu (Admin yapılandırma ekranı).
 *
 * SADECE configuration. Bu ekran ileride bağlanacak external KB / Vector DB
 * API'sı için bağlantı parametrelerini saklar. Hiçbir alan API çağrısı
 * tetiklemez; raw API key TUTULMAZ — yalnız `apiKeySecretName` (env var
 * referans adı) saklanır.
 *
 * Per-company admin gate: BFF tarafında `assertCompanyAdmin` enforce edilir.
 * Admin yalnız UserCompany.role=Admin olduğu şirketleri görür/düzenler;
 * SystemAdmin tüm aktif şirketleri görür.
 */

const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 120000;
const TOPK_MIN = 1;
const TOPK_MAX = 20;

const AUTH_TYPE_OPTIONS: { value: ExternalKbAuthType; label: string }[] = [
  { value: 'none', label: 'Kimlik doğrulama yok' },
  { value: 'apiKey', label: 'API Key' },
  { value: 'bearerToken', label: 'Bearer Token' },
];

type StrictnessValue = 'lenient' | 'normal' | 'strict';

interface DraftState {
  enabled: boolean;
  providerName: string;
  baseUrl: string;
  askEndpointPath: string;
  searchEndpointPath: string;
  healthEndpointPath: string;
  statsEndpointPath: string;
  categorizeEndpointPath: string;
  analyzeEndpointPath: string;
  authType: ExternalKbAuthType;
  apiKeySecretName: string;
  timeoutMs: number;
  defaultTopK: number;
  defaultStrictness: StrictnessValue;
  defaultRerank: boolean;
  defaultVerify: boolean;
  showCitations: boolean;
  allowAgentUse: boolean;
  allowSupervisorUse: boolean;
  allowCsmUse: boolean;
  notes: string;
}

function toDraft(s: ExternalKbSetting): DraftState {
  return {
    enabled: s.enabled,
    providerName: s.providerName ?? '',
    baseUrl: s.baseUrl ?? '',
    askEndpointPath: s.askEndpointPath || '/api/v1/kb/ask',
    searchEndpointPath: s.searchEndpointPath || '/api/v1/kb/search',
    healthEndpointPath: s.healthEndpointPath || '/api/v1/health',
    statsEndpointPath: s.statsEndpointPath || '/api/v1/stats',
    categorizeEndpointPath: s.categorizeEndpointPath || '/api/v1/categorize',
    analyzeEndpointPath: s.analyzeEndpointPath || '/api/v1/analyze',
    authType: s.authType,
    apiKeySecretName: s.apiKeySecretName ?? '',
    timeoutMs: s.timeoutMs,
    defaultTopK: s.defaultTopK,
    defaultStrictness: s.defaultStrictness ?? 'lenient',
    defaultRerank: s.defaultRerank ?? true,
    defaultVerify: s.defaultVerify ?? true,
    showCitations: s.showCitations,
    allowAgentUse: s.allowAgentUse,
    allowSupervisorUse: s.allowSupervisorUse,
    allowCsmUse: s.allowCsmUse,
    notes: s.notes ?? '',
  };
}

function toPatch(d: DraftState): ExternalKbSettingInput {
  return {
    enabled: d.enabled,
    providerName: d.providerName.trim() || null,
    baseUrl: d.baseUrl.trim() || null,
    askEndpointPath: d.askEndpointPath.trim() || '/api/v1/kb/ask',
    searchEndpointPath: d.searchEndpointPath.trim() || '/api/v1/kb/search',
    healthEndpointPath: d.healthEndpointPath.trim() || '/api/v1/health',
    statsEndpointPath: d.statsEndpointPath.trim() || '/api/v1/stats',
    categorizeEndpointPath: d.categorizeEndpointPath.trim() || '/api/v1/categorize',
    analyzeEndpointPath: d.analyzeEndpointPath.trim() || '/api/v1/analyze',
    authType: d.authType,
    apiKeySecretName: d.authType === 'none' ? null : d.apiKeySecretName.trim() || null,
    timeoutMs: d.timeoutMs,
    defaultTopK: d.defaultTopK,
    defaultStrictness: d.defaultStrictness,
    defaultRerank: d.defaultRerank,
    defaultVerify: d.defaultVerify,
    showCitations: d.showCitations,
    allowAgentUse: d.allowAgentUse,
    allowSupervisorUse: d.allowSupervisorUse,
    allowCsmUse: d.allowCsmUse,
    notes: d.notes.trim() || null,
  };
}

export function AdminExternalKbPage() {
  const { user } = useAuth();
  void user;

  // lookupService.companies() bootstrap üzerinden zaten allowedCompanyIds ile
  // filtrelenmiş şirketleri döndürür. Per-company admin gate (UserCompany.role)
  // BFF tarafında `assertCompanyAdmin` ile enforce edilir; UI seçiciye yetkisiz
  // şirket geçerse PATCH 403 alır ve toast gösterilir.
  // Bootstrap zaten yalnız isActive=true şirketleri döndürür.
  const manageable = useMemo(() => lookupService.companies(), []);

  const [companyId, setCompanyId] = useState<string>('');
  const [setting, setSetting] = useState<ExternalKbSetting | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();

  // İlk yüklemede default şirket: ilk manageable şirket.
  useEffect(() => {
    if (!companyId && manageable.length > 0) {
      setCompanyId(manageable[0].id);
    }
  }, [companyId, manageable]);

  // Şirket değişince ayarları yükle.
  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    setLoading(true);
    setErrors({});
    void adminService.externalKbSettings
      .get(companyId)
      .then((s) => {
        if (!alive) return;
        if (s) {
          setSetting(s);
          setDraft(toDraft(s));
        } else {
          setSetting(null);
          setDraft(null);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [companyId]);

  function update<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    if (errors[key as string]) {
      setErrors((e) => {
        const { [key as string]: _, ...rest } = e;
        return rest;
      });
    }
  }

  function validate(d: DraftState): Record<string, string> {
    const e: Record<string, string> = {};
    if (!d.authType) e.authType = 'authType zorunlu.';
    if (d.authType !== 'none' && !d.apiKeySecretName.trim()) {
      e.apiKeySecretName = 'apiKey/bearerToken seçiliyse secret referans adı zorunlu.';
    }
    if (
      !Number.isFinite(d.timeoutMs) ||
      d.timeoutMs < TIMEOUT_MIN ||
      d.timeoutMs > TIMEOUT_MAX
    ) {
      e.timeoutMs = `${TIMEOUT_MIN}-${TIMEOUT_MAX} arası olmalı.`;
    }
    if (!Number.isFinite(d.defaultTopK) || d.defaultTopK < TOPK_MIN || d.defaultTopK > TOPK_MAX) {
      e.defaultTopK = `${TOPK_MIN}-${TOPK_MAX} arası olmalı.`;
    }
    return e;
  }

  async function handleSave() {
    if (!draft || !companyId) return;
    const validationErrors = validate(draft);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setSaving(true);
    const r = await adminService.externalKbSettings.save(companyId, toPatch(draft));
    setSaving(false);
    if (r.ok) {
      setSetting(r.item);
      setDraft(toDraft(r.item));
      toast({ type: 'success', message: 'Ayarlar kaydedildi ✓', duration: 2500 });
    }
  }

  if (manageable.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-slate-600 dark:text-ndark-muted">
            Yönetebileceğin şirket bulunmuyor. Yöneticilik atanmış bir şirkette olman gerekiyor.
          </p>
        </CardBody>
      </Card>
    );
  }

  // Form henüz yüklenmediyse skeleton.
  const showSkeleton = loading || !draft;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BookOpen size={18} className="text-brand-600" />
        <h2 className="text-lg font-semibold text-slate-800 dark:text-ndark-text">
          Bilgi Bankası Entegrasyonu
        </h2>
      </div>

      {/* Bilgi şeridi */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-200">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Bu ekran dış Bilgi Bankası entegrasyonu için bağlantı tanımlarını saklar.
          <strong> API bağlantısı sonraki fazda eklenecektir.</strong> Bu sayfa hiçbir dış servisi
          çağırmaz; raw API anahtarı saklanmaz — yalnız environment secret referans adı tutulur.
        </span>
      </div>

      {/* Şirket seçici (birden fazla yönetilebilir şirket varsa) */}
      {manageable.length > 1 && (
        <Card>
          <CardBody>
            <Field label="Şirket" hint="Yönetim yetkin olan şirketler listelenir">
              <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {manageable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </CardBody>
        </Card>
      )}

      {/* Form */}
      <Card>
        <CardBody>
          {showSkeleton ? (
            <div className="space-y-3">
              <Skeleton height={20} width="40%" />
              <Skeleton height={14} width="80%" />
              <Skeleton height={14} width="70%" />
              <Skeleton height={14} width="60%" />
            </div>
          ) : (
            <div className="space-y-5">
              {/* Toggle */}
              <Field label="Entegrasyon Aktif" hint="Kapalıyken hiçbir yerde gösterilmez.">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={draft.enabled}
                    onChange={(e) => update('enabled', e.target.checked)}
                  />
                  <span className="text-sm text-slate-700 dark:text-ndark-muted">
                    {draft.enabled ? 'Aktif' : 'Pasif'}
                  </span>
                </label>
              </Field>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Sağlayıcı Adı" hint="ör. Varuna KB, External Vector DB">
                  <TextInput
                    value={draft.providerName}
                    onChange={(e) => update('providerName', e.target.value)}
                    placeholder="Sağlayıcı"
                  />
                </Field>
                <Field label="Base URL" hint="Opsiyonel; sonraki fazda kullanılır">
                  <TextInput
                    value={draft.baseUrl}
                    onChange={(e) => update('baseUrl', e.target.value)}
                    placeholder="https://kb.example.com"
                  />
                </Field>
                <Field label="Ask Endpoint Path" hint="Soru-cevap endpoint relative path">
                  <TextInput
                    value={draft.askEndpointPath}
                    onChange={(e) => update('askEndpointPath', e.target.value)}
                    placeholder="/api/v1/kb/ask"
                  />
                </Field>
                <Field label="Search Endpoint Path" hint="Arama endpoint relative path">
                  <TextInput
                    value={draft.searchEndpointPath}
                    onChange={(e) => update('searchEndpointPath', e.target.value)}
                    placeholder="/api/v1/kb/search"
                  />
                </Field>
                <Field label="Health Endpoint Path" hint="Sağlık kontrolü relative path">
                  <TextInput
                    value={draft.healthEndpointPath}
                    onChange={(e) => update('healthEndpointPath', e.target.value)}
                    placeholder="/api/v1/health"
                  />
                </Field>
                <Field label="Stats Endpoint Path" hint="İstatistik relative path">
                  <TextInput
                    value={draft.statsEndpointPath}
                    onChange={(e) => update('statsEndpointPath', e.target.value)}
                    placeholder="/api/v1/stats"
                  />
                </Field>
                <Field label="Categorize Endpoint Path" hint="Kategorize endpoint">
                  <TextInput
                    value={draft.categorizeEndpointPath}
                    onChange={(e) => update('categorizeEndpointPath', e.target.value)}
                    placeholder="/api/v1/categorize"
                  />
                </Field>
                <Field label="Analyze Endpoint Path" hint="Analiz endpoint">
                  <TextInput
                    value={draft.analyzeEndpointPath}
                    onChange={(e) => update('analyzeEndpointPath', e.target.value)}
                    placeholder="/api/v1/analyze"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Auth Türü" required error={errors.authType}>
                  <Select
                    value={draft.authType}
                    onChange={(e) => update('authType', e.target.value as ExternalKbAuthType)}
                  >
                    {AUTH_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="API Key Secret Referansı"
                  hint="API anahtarı değeri burada saklanmaz. Sadece ortam değişkeni adı saklanır. Örn: EXTERNAL_KB_API_KEY"
                  error={errors.apiKeySecretName}
                >
                  <TextInput
                    value={draft.apiKeySecretName}
                    onChange={(e) => update('apiKeySecretName', e.target.value)}
                    placeholder="EXTERNAL_KB_API_KEY"
                    disabled={draft.authType === 'none'}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Timeout (ms)"
                  hint={`${TIMEOUT_MIN}-${TIMEOUT_MAX} arası`}
                  error={errors.timeoutMs}
                >
                  <TextInput
                    type="number"
                    value={String(draft.timeoutMs)}
                    onChange={(e) => update('timeoutMs', Number(e.target.value))}
                    min={TIMEOUT_MIN}
                    max={TIMEOUT_MAX}
                  />
                </Field>
                <Field
                  label="Varsayılan topK"
                  hint={`${TOPK_MIN}-${TOPK_MAX} arası`}
                  error={errors.defaultTopK}
                >
                  <TextInput
                    type="number"
                    value={String(draft.defaultTopK)}
                    onChange={(e) => update('defaultTopK', Number(e.target.value))}
                    min={TOPK_MIN}
                    max={TOPK_MAX}
                  />
                </Field>
                <Field label="Varsayılan Strictness" hint="ask/search için varsayılan">
                  <Select
                    value={draft.defaultStrictness}
                    onChange={(e) => update('defaultStrictness', e.target.value as StrictnessValue)}
                  >
                    <option value="lenient">Esnek (lenient)</option>
                    <option value="normal">Normal</option>
                    <option value="strict">Katı (strict)</option>
                  </Select>
                </Field>
                <Field label="Rerank (varsayılan)">
                  <label className="flex items-center gap-2 px-1 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.defaultRerank}
                      onChange={(e) => update('defaultRerank', e.target.checked)}
                    />
                    <span>{draft.defaultRerank ? 'Açık' : 'Kapalı'}</span>
                  </label>
                </Field>
                <Field label="Verify (varsayılan)">
                  <label className="flex items-center gap-2 px-1 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.defaultVerify}
                      onChange={(e) => update('defaultVerify', e.target.checked)}
                    />
                    <span>{draft.defaultVerify ? 'Açık' : 'Kapalı'}</span>
                  </label>
                </Field>
              </div>

              <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-ndark-border dark:bg-ndark-card/40">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Davranış
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-ndark-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded"
                    checked={draft.showCitations}
                    onChange={(e) => update('showCitations', e.target.checked)}
                  />
                  Kaynak alıntılarını göster
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-ndark-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded"
                    checked={draft.allowAgentUse}
                    onChange={(e) => update('allowAgentUse', e.target.checked)}
                  />
                  Agent kullanabilir
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-ndark-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded"
                    checked={draft.allowSupervisorUse}
                    onChange={(e) => update('allowSupervisorUse', e.target.checked)}
                  />
                  Supervisor kullanabilir
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-ndark-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded"
                    checked={draft.allowCsmUse}
                    onChange={(e) => update('allowCsmUse', e.target.checked)}
                  />
                  CSM kullanabilir
                </label>
              </div>

              <Field label="Notlar" hint="Opsiyonel admin notu">
                <TextArea
                  value={draft.notes}
                  onChange={(e) => update('notes', e.target.value)}
                  rows={3}
                  placeholder="Bu entegrasyon için iç not (opsiyonel)"
                />
              </Field>

              <div className="flex items-center justify-between border-t border-slate-200 pt-3 dark:border-ndark-border">
                <div className="text-xs text-slate-500 dark:text-ndark-muted">
                  {setting?.updatedAt
                    ? `Son güncelleme: ${new Date(setting.updatedAt).toLocaleString('tr-TR')}`
                    : 'Henüz kaydedilmedi.'}
                </div>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  leftIcon={<Save size={14} />}
                >
                  {saving ? 'Kaydediliyor…' : 'Kaydet'}
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
