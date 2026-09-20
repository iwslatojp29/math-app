const CATALOG_URL = 'https://developers.openai.com/api/docs/models.md';
const MODEL_DOCS = 'https://developers.openai.com/api/docs/models/';
const MODELS_URL = 'https://api.openai.com/v1/models';
const MAX_BODY_CHARS = 1024 * 1024;
const MAX_CANDIDATES = 32;
// Must cover the largest max_output_tokens request in lesson_pipeline.py.
const MIN_LESSON_OUTPUT_TOKENS = 28000;
const SPECIALIZED = /(?:^|-)(?:audio|realtime|image|embedding|transcribe|tts|search|codex|cyber|chat|oss|moderation|daybreak|deep)(?:-|$)/i;

class CatalogError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function diagnosticReason(error, fallback) {
  // Only errors constructed here are allowed through. Upstream messages may
  // contain credentials, request headers, response bodies or internal URLs.
  return error instanceof CatalogError ? error.code : fallback;
}

function genericId(id) {
  return typeof id === 'string' && /^gpt-\d[a-z0-9.-]{0,90}$/.test(id) && !SPECIALIZED.test(id);
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

// Match the recommendation sentence, not the first model link or model creation date.
// Observed official models.md (2026-09-20): "use [GPT-6 Astra](...), our flagship model ...".
function parseCatalog(markdown) {
  const entries = [];
  const seen = new Set();
  for (const match of markdown.matchAll(/\[([^\]\r\n]{1,120})\]\((?:https:\/\/developers\.openai\.com)?\/api\/docs\/models\/([a-z0-9.-]+?)(?:\.md)?\)/g)) {
    const [, label, id] = match;
    if (genericId(id) && !seen.has(id) && !/[\u0000-\u001f\u007f]/.test(label)) {
      seen.add(id);
      entries.push({ id, label });
    }
  }
  const recommendation = markdown.match(/\buse\s+\[[^\]\r\n]+\]\((?:https:\/\/developers\.openai\.com)?\/api\/docs\/models\/([a-z0-9.-]+?)(?:\.md)?\),?\s+our\s+flagship\s+model\b/i);
  const latestId = recommendation && genericId(recommendation[1]) ? recommendation[1] : null;
  return { entries, latestId };
}

export function validOutputTokens(value) {
  return Number.isSafeInteger(value) && value >= MIN_LESSON_OUTPUT_TOKENS;
}

function pdfResponsesCapacity(markdown, id) {
  const declared = markdown.match(/^Model ID:\s*`([^`]+)`\s*$/m)?.[1];
  const input = markdown.match(/^- Input modalities:\s*([^\r\n]+)$/m)?.[1].trim().toLowerCase().split(/\s*,\s*/);
  const output = markdown.match(/^- Output modalities:\s*([^\r\n]+)$/m)?.[1].trim().toLowerCase();
  const maxOutputText = markdown.match(/^- ([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*) max output tokens[ \t]*$/m)?.[1];
  const maxOutputTokens = Number(maxOutputText?.replaceAll(',', ''));
  return declared === id && input?.includes('text') && input.includes('image') &&
    input.every(value => value === 'text' || value === 'image') && output === 'text' &&
    /^- structured_outputs[ \t]*$/m.test(markdown) &&
    validOutputTokens(maxOutputTokens) &&
    /^\|\s*Responses\s*\|\s*`v1\/responses`\s*\|\s*Supported\s*\|\s*$/m.test(markdown) ? maxOutputTokens : null;
}

async function readText(fetchImpl, url, options, deadline, stage) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CatalogError(`${stage}_timeout`);
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        // Never follow a redirect with an Authorization header. Manual mode
        // preserves the HTTP status for diagnostics instead of throwing an
        // indistinguishable network error on a legitimate upstream redirect.
        const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal });
        if (!response.ok) throw new CatalogError(`${stage}_http_${Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 'error'}`);
        if (Number(response.headers.get('Content-Length')) > MAX_BODY_CHARS) throw new CatalogError(`${stage}_too_large`);
        const body = await response.text();
        if (body.length > MAX_BODY_CHARS) throw new CatalogError(`${stage}_too_large`);
        return body;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CatalogError(`${stage}_timeout`));
        }, remaining);
      }),
    ]);
  } catch (error) {
    throw error instanceof CatalogError ? error : new CatalogError(`${stage}_${controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'network'}`);
  } finally {
    clearTimeout(timer);
  }
}

function cachedResult(previous, available, checkedAt, reason) {
  const verifiedAt = timestamp(previous?.verifiedAt) || (previous?.latestVerified ? timestamp(previous.checkedAt) : null);
  const seen = new Set();
  const models = verifiedAt && Array.isArray(previous?.models) ? previous.models.filter(model => {
    if (!genericId(model?.id) || !available.has(model.id) || seen.has(model.id) || !validOutputTokens(model.maxOutputTokens)) return false;
    seen.add(model.id);
    return true;
  }).map(({ id, maxOutputTokens }) => ({ id, label: id, maxOutputTokens })) : [];
  return {
    defaultModel: models.some(model => model.id === previous?.defaultModel) ? previous.defaultModel : null,
    latestVerified: false,
    checkedAt,
    verifiedAt,
    models,
    diagnosticReason: reason,
    warning: models.length
      ? '公式カタログの最新情報を確認できません。前回確認した候補を表示しています。'
      : '公式カタログの最新情報を確認できません。時間をおいて再試行してください。',
  };
}

/**
 * Resolve the live official recommendation against this API account's models.
 * checkedAt is this attempt; verifiedAt is the last successful latest verification.
 * latestVerified=false must never be labelled "latest confirmed", including cache hits.
 * Cache this result outside this module; never cache apiKey or upstream error bodies.
 */
export async function fetchCatalog({ apiKey, fetchImpl = fetch, previous = null, timeoutMs = 12000 } = {}) {
  const checkedAt = new Date().toISOString();
  const unavailable = {
    defaultModel: null, latestVerified: false, checkedAt, verifiedAt: null, models: [],
    diagnosticReason: 'api_not_configured',
    warning: '利用可能なモデルを確認できません。API 設定を確認して再試行してください。',
  };
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) return unavailable;
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 15000)) : 12000;
  const deadline = Date.now() + duration;
  const [availabilityResult, catalogResult] = await Promise.allSettled([
    readText(fetchImpl, MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } }, deadline, 'api')
      .then(text => {
        let value;
        try { value = JSON.parse(text); } catch { throw new CatalogError('api_invalid_response'); }
        if (!Array.isArray(value?.data)) throw new CatalogError('api_invalid_response');
        return new Set(value.data.filter(model => genericId(model?.id) &&
          !(typeof model.shutdown_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(model.shutdown_date) && model.shutdown_date <= checkedAt.slice(0, 10)))
          .map(model => model.id));
      }),
    readText(fetchImpl, CATALOG_URL, { headers: { Accept: 'text/markdown' } }, deadline, 'catalog').then(parseCatalog),
  ]);
  if (availabilityResult.status !== 'fulfilled') return { ...unavailable, diagnosticReason: diagnosticReason(availabilityResult.reason, 'api_invalid_response') };
  const available = availabilityResult.value;
  if (catalogResult.status !== 'fulfilled' || !catalogResult.value.entries.length) {
    return cachedResult(previous, available, checkedAt, catalogResult.status === 'rejected' ? diagnosticReason(catalogResult.reason, 'catalog_invalid_response') : 'catalog_unrecognized');
  }
  const { entries, latestId } = catalogResult.value;
  // Put only the actual official recommendation first. Other entries retain catalog order.
  const candidates = entries.filter(model => available.has(model.id));
  const ordered = [...candidates.filter(model => model.id === latestId), ...candidates.filter(model => model.id !== latestId)];
  const bounded = ordered.slice(0, MAX_CANDIDATES);
  const valid = new Map();
  let next = 0;
  let incomplete = ordered.length > bounded.length;
  const failures = new Set();
  // At most 34 outbound requests and four concurrent documentation reads.
  await Promise.all(Array.from({ length: Math.min(4, bounded.length) }, async () => {
    while (next < bounded.length) {
      const model = bounded[next++];
      try {
        const markdown = await readText(fetchImpl, `${MODEL_DOCS}${model.id}.md`, { headers: { Accept: 'text/markdown' } }, deadline, 'model_docs');
        const maxOutputTokens = pdfResponsesCapacity(markdown, model.id);
        if (maxOutputTokens !== null) valid.set(model.id, maxOutputTokens);
        else if (model.id === latestId) failures.add('model_docs_unsupported');
      } catch (error) {
        failures.add(diagnosticReason(error, 'model_docs_invalid_response'));
        incomplete = true;
      }
    }
  }));
  const models = bounded.filter(model => valid.has(model.id)).map(model => ({ ...model, maxOutputTokens: valid.get(model.id) }));
  const latestVerified = Boolean(latestId && valid.has(latestId));
  const result = {
    defaultModel: latestVerified ? latestId : null,
    latestVerified,
    checkedAt,
    verifiedAt: latestVerified ? checkedAt : null,
    models,
  };
  if (!latestVerified) {
    result.diagnosticReason = !latestId ? 'catalog_recommendation_unrecognized' : !available.has(latestId) ? 'api_latest_unavailable' : [...failures].sort()[0] || 'model_docs_unsupported';
    result.warning = latestId && !available.has(latestId)
      ? '公式の最新モデルは、この API 設定では利用できません。表示された候補から選択してください。'
      : '公式の最新モデルを確認できません。表示された候補を選択するか、再試行してください。';
  } else if (incomplete) {
    result.diagnosticReason = [...failures].sort()[0] || 'catalog_candidate_limit';
    result.warning = '一部のモデル候補を確認できませんでした。確認できた候補を表示しています。';
  }
  return result;
}
