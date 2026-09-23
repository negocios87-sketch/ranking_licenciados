const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Variáveis de ambiente (configurar no Render) ────────────
const API_TOKEN = process.env.PIPEDRIVE_TOKEN;
const ORG       = process.env.PIPEDRIVE_ORG || 'boardacademy';
const FILTER_ID = process.env.FILTER_ID     || '';

const META_CSV_URL = process.env.META_CSV_URL || '';
// Ex: https://docs.google.com/spreadsheets/d/e/SEU_ID/pub?gid=SEU_GID&single=true&output=csv

const BASE = `https://${ORG}.pipedrive.com/api/v1`;

// ── Helpers ─────────────────────────────────────────────────
async function pipeGet(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const res  = await fetch(`${BASE}${endpoint}${sep}api_token=${API_TOKEN}`);
  if (!res.ok) throw new Error(`Pipedrive ${res.status} → ${endpoint}`);
  return res.json();
}

async function fetchAllDeals() {
  const all = [];
  let start = 0;
  while (true) {
    const json = await pipeGet(
      `/deals?${FILTER_ID ? `filter_id=${FILTER_ID}&` : ''}status=won&limit=500&start=${start}`
    );
    (json.data || []).forEach(d => all.push(d));
    if (!json.additional_data?.pagination?.more_items_in_collection) break;
    start += 500;
  }
  return all;
}

async function fetchPipelines() {
  const json = await pipeGet('/pipelines');
  return (json.data || []).map(p => ({ id: String(p.id), name: p.name }));
}

async function fetchCSV(url) {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) return [];
  const csv  = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].replace(/^\uFEFF/, '').split(',')
    .map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim());
    return obj;
  });
}

// ── Meta: extrai nome normalizado da planilha ────────────────
const PT_MONTHS = ['janeiro','fevereiro','março','abril','maio','junho','julho',
                   'agosto','setembro','outubro','novembro','dezembro'];

function normalizeName(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function parseMetaSheet(rows, targetYM) {
  // Retorna Map: nomePlanilha(normalizado) → valorMeta
  const result = new Map();
  if (!rows?.length) return result;

  const keys    = Object.keys(rows[0]);
  const find    = (...terms) => keys.find(k => terms.some(t => k.toLowerCase().includes(t)));
  const anoCol  = find('ano','year');
  const mesCol  = find('mes','mês','month');
  const metaCol = find('financeira','financial') || find('meta','goal','objetivo');
  const nomeCol = find('nome','name','licenciado','pipeline','funil','lic','unidade','franquia');

  if (!metaCol || !nomeCol) {
    console.warn('[meta] colunas não encontradas. keys:', keys);
    return result;
  }

  console.log(`[meta] cols → nome:${nomeCol} meta:${metaCol} mes:${mesCol} ano:${anoCol}`);

  const [targetYear, targetMonth] = targetYM.split('-').map(Number);

  const parseM = raw => {
    const n = parseInt(raw); if (!isNaN(n)) return n;
    const i = PT_MONTHS.findIndex(m => (raw||'').toLowerCase().includes(m));
    return i >= 0 ? i + 1 : -1;
  };

  for (const row of rows) {
    const nomeBruto = row[nomeCol] || '';
    if (!nomeBruto.trim()) continue;

    // Filtro mês/ano
    const ano = anoCol ? parseInt(row[anoCol]) : targetYear;
    const mes = mesCol ? parseM(row[mesCol])   : targetMonth;
    if (ano !== targetYear || mes !== targetMonth) continue;

    const raw = (row[metaCol] || '').replace(/[^\d.,]/g,'').replace(',','.');
    const val = parseFloat(raw);
    if (!isNaN(val) && val > 0) {
      result.set(normalizeName(nomeBruto), val);
    }
  }

  console.log(`[meta] ${result.size} entradas para ${targetYM}:`, [...result.keys()]);
  return result;
}

function matchPipeline(pipeName, metaMap) {
  const pn = normalizeName(pipeName); // ex: "lic-cwb"
  // Match exato
  if (metaMap.has(pn)) return metaMap.get(pn);
  // Tenta sem prefixo "lic-"
  const sem = pn.replace(/^lic-\s*/, '');
  for (const [k, v] of metaMap) {
    const ksem = k.replace(/^lic-\s*/, '');
    if (k === pn || ksem === sem || ksem === pn || k === sem) return v;
  }
  return null;
}

// ── Cache simples (5 min) ─────────────────────────────────────
let cache = null, cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ── GET /api/debug-meta (remover depois de resolver) ─────────
app.get('/api/debug-meta', async (req, res) => {
  try {
    const rows = await fetchCSV(META_CSV_URL);
    if (!rows.length) return res.json({ ok: false, error: 'CSV vazio ou URL inválida' });
    const keys = Object.keys(rows[0]);
    const find = (...terms) => keys.find(k => terms.some(t => k.toLowerCase().includes(t)));
    res.json({
      ok: true,
      totalLinhas: rows.length,
      colunas: keys,
      colunaDetectadaNome: find('nome','name','licenciado','pipeline','funil','lic','unidade','franquia'),
      colunaDetectadaMeta: find('financeira','financial','receita','vendas','faturamento','meta fin') || find('meta','goal','objetivo'),
      colunaDetectadaMes:  find('mes','mês','month'),
      colunaDetectadaAno:  find('ano','year'),
      primeiras5Linhas: rows.slice(0, 5),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/ranking ─────────────────────────────────────────
app.get('/api/ranking', async (req, res) => {
  if (!API_TOKEN) return res.status(500).json({ ok: false, error: 'PIPEDRIVE_TOKEN não configurado.' });

  try {
    const month = req.query.month || new Date().toISOString().substring(0, 7);
    const cacheKey = month;

    if (cache?.key === cacheKey && Date.now() - cachedAt < CACHE_TTL) {
      return res.json(cache.data);
    }

    const [deals, pipelines, metaRows] = await Promise.all([
      fetchAllDeals(),
      fetchPipelines(),
      fetchCSV(META_CSV_URL)
    ]);

    const licPipelines = pipelines.filter(p => p.name.toUpperCase().startsWith('LIC-'));

    const metaMap = parseMetaSheet(metaRows, month);

    const rankMap = {};
    for (const p of licPipelines) {
      const meta = matchPipeline(p.name, metaMap);
      if (meta === null) continue; // não está na planilha de metas → fora do ranking
      rankMap[p.id] = {
        id:     p.id,
        name:   p.name,
        label:  p.name.replace(/^LIC-\s*/i, '').trim(),
        vendas: 0,
        meta,
      };
    }

    for (const deal of deals) {
      if (deal.status !== 'won' || !deal.won_time) continue;
      if (deal.won_time.substring(0, 7) !== month) continue;
      const pipeId = String(deal.pipeline_id);
      if (!rankMap[pipeId]) continue;
      rankMap[pipeId].vendas += parseFloat(deal.value || 0);
    }

    const ranking = Object.values(rankMap).sort((a, b) => b.vendas - a.vendas);

    // Log de diagnóstico (ver nos logs do Render)
    console.log(`[ranking] mês: ${month} | deals won: ${deals.filter(d=>d.status==='won').length} | pipelines LIC: ${licPipelines.length}`);
    ranking.forEach(r => console.log(`  ${r.name}: vendas=${r.vendas} meta=${r.meta}`));
    const payload = { ok: true, month, ranking };

    cache = { key: cacheKey, data: payload };
    cachedAt = Date.now();

    res.json(payload);
  } catch (e) {
    console.error('[/api/ranking]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`✓ Porta ${PORT}`));
