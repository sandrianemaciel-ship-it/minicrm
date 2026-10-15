"use strict";
// Testes de análise comercial lidos do Qlik (só leitura no Qlik):
//   1) Metas do mês por representante (pasta "Vendas/Faturamento Times - Agrupada" do app Vendas Dellamed SAP)
//   2) Potencial x Não comprou x Deficitário por cliente, ano contra ano (pasta "Potenciais x Não Comprou x Deficitários")
//   3) Mix sugerido e itens que fazem sentido para o cliente (app "Pasta Mestre", pasta "Dash")
const { withApp, readAllPages } = require("./qlik");
const L = require("./logic");
const { isoLocal, hoje, commitEmLotes, docIdCod } = require("./hub");

const PASTA_MESTRE = "3ac230ee-8b32-46e1-8314-dad53a6b2bc4";
const LINHA_ORTHO = "ORTHOCARE"; // valor do campo LINHA_ITEM (filtro "Linha" da pasta)
const META_ORTHO = 0.10;          // Meta Ortho = sempre 10% da Meta Comercial
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

const txt = c => c == null ? "" : String(c.text != null ? c.text : (c.num != null ? c.num : "")).trim();
const num = c => c && c.num != null && !isNaN(c.num) ? c.num : 0;
const r2 = v => Math.round((v || 0) * 100) / 100;
const serialToIso = s => s ? new Date(Date.UTC(1899, 11, 30) + Math.floor(s) * 86400000).toISOString().slice(0, 10) : null;
const codNorm = c => String(c == null ? "" : c).trim().replace(/^0+(?=\d)/, "");

// Dias úteis (segunda a sexta, sem feriados) de "ref" até o fim do mês, contando o dia de hoje.
function diasUteisRestantes(ref = hoje()){
  const fim = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  let n = 0;
  for(const d = new Date(ref); d <= fim; d.setDate(d.getDate() + 1)){ const w = d.getDay(); if(w !== 0 && w !== 6) n++; }
  return n;
}

async function cubo(app, dims, meas, extra = {}){
  const o = await app.createSessionObject({ qInfo: { qType: "hub-analise" }, qHyperCubeDef: Object.assign({
    qDimensions: dims.map(d => ({ qDef: { qFieldDefs: [d] }, qNullSuppression: true })),
    qMeasures: meas.map(m => ({ qDef: { qDef: m } })), qSuppressZero: true, qSuppressMissing: true, qInitialDataFetch: [] }, extra) });
  return readAllPages(o, await o.getLayout());
}

// ---------- 1) Metas ----------
// Mesmas fórmulas da pasta: Meta Comercial = if(vMetaComercialBudget='1', Valor_Meta, Valor_Meta_Budget);
// Valor Total de Pedidos (- Canc) = sum({<COD_TIPO_REP-={'Z2'}>} VL_TOTAL); Ortho = o mesmo com Linha = ORTHOCARE.
async function lerMetas(cfg, ref = hoje(), log = console.log){
  const ano = ref.getFullYear(), mes = MESES[ref.getMonth()];
  const per = `Ano={${ano}},Mês={'${mes}'}`;
  return withApp(cfg, async (app) => {
    const rows = await cubo(app, ["Time", "REPRESENTANTE"], [
      `if($(vMetaComercialBudget)='1',sum({<${per}>} Valor_Meta),sum({<${per}>} Valor_Meta_Budget))`,
      `sum({<${per},COD_TIPO_REP-={'Z2'}>} VL_TOTAL)`,
      `sum({<${per},COD_TIPO_REP-={'Z2'},LINHA_ITEM={'${LINHA_ORTHO}'}>} VL_TOTAL)`,
      `count({<${per},TIPO_OPER={'11.Pedidos'},COD_TIPO_REP-={'Z2'}>} distinct CD_PEDIDO)`
    ]);
    const out = rows.map(r => ({ time: txt(r[0]), rep: txt(r[1]), meta: r2(num(r[2])), vendido: r2(num(r[3])), vendOrtho: r2(num(r[4])), pedidos: num(r[5]) }));
    log(`Metas de ${mes}/${ano}: ${out.length} representantes lidos (${out.filter(x => x.meta > 0).length} com meta).`);
    return out;
  });
}
// Junta as linhas do Qlik às pessoas do organograma (mesma regra de nomes da carteira).
function metasPorPessoa(linhas, apelidos){
  const porPessoa = {}; const sem = [];
  for(const l of linhas){
    const id = apelidos.get(L.norm(l.rep));
    if(!id){ if(l.meta > 0) sem.push(l.rep); continue; }
    const p = porPessoa[id] || (porPessoa[id] = { rep: l.rep, time: l.time, meta: 0, vendido: 0, vendOrtho: 0, pedidos: 0 });
    p.meta = r2(p.meta + l.meta); p.vendido = r2(p.vendido + l.vendido); p.vendOrtho = r2(p.vendOrtho + l.vendOrtho); p.pedidos += l.pedidos;
    if(l.meta > 0) p.time = l.time;
  }
  return { porPessoa, sem };
}
// Conta exibida no Hub (a página refaz a mesma conta com o dia de hoje).
function calcMeta(m, du){
  const metaOrtho = r2(m.meta * META_ORTHO);
  const falta = r2(m.meta - m.vendido), faltaOrtho = r2(metaOrtho - m.vendOrtho);
  return { meta: m.meta, vendido: m.vendido, falta, pct: m.meta ? m.vendido / m.meta : null, porDia: du ? r2(Math.max(0, falta) / du) : null,
    metaOrtho, vendOrtho: m.vendOrtho, faltaOrtho, porDiaOrtho: du ? r2(Math.max(0, faltaOrtho) / du) : null, diasUteis: du };
}

// ---------- 2 e 3) Análise por cliente ----------
function classificaYoy(v25, v26){
  if(v25 > 0 && v26 <= 0) return "Não comprou";
  return v26 > v25 ? "Potencial" : "Deficitário";
}

// Pedidos de jan até o mês anterior, ano passado x este ano (mesma regra da "Legenda" da pasta, com VL_TOTAL).
async function lerPotenciais(cfg, ref, log){
  const ano = ref.getFullYear(); const ate = Math.max(1, ref.getMonth()); // jan..mês anterior
  const per = a => `Ano={${a}},Mês={"<=${ate}"}`;
  return withApp(cfg, async (app) => {
    const rows = await cubo(app, ["COD_CLIENTE"], [`sum({<${per(ano - 1)}>} VL_TOTAL)`, `sum({<${per(ano)}>} VL_TOTAL)`]);
    const m = new Map();
    rows.forEach(r => m.set(codNorm(txt(r[0])), { v25: r2(num(r[1])), v26: r2(num(r[2])) }));
    log(`Potenciais x deficitários (jan-${MESES[ate - 1]} ${ano - 1} x ${ano}): ${m.size} clientes com pedidos.`);
    return { mapa: m, ate, ano };
  });
}

// Seleciona valores de um campo pelo código normalizado (sem zeros à esquerda), lendo os valores do próprio campo.
async function selecionarCodigos(app, campo, codigos){
  const quer = new Set(codigos.map(codNorm));
  const lo = await app.createSessionObject({ qInfo: { qType: "hub-lista" }, qListObjectDef: { qDef: { qFieldDefs: [campo] }, qInitialDataFetch: [] } });
  const lay = await lo.getLayout(); const total = lay.qListObject.qSize.qcy; const elems = [];
  for(let top = 0; top < total; top += 10000){
    const pg = await lo.getListObjectData("/qListObjectDef", [{ qTop: top, qLeft: 0, qWidth: 1, qHeight: Math.min(10000, total - top) }]);
    pg[0].qMatrix.forEach(r => { if(quer.has(codNorm(r[0].qText))) elems.push(r[0].qElemNumber); });
  }
  if(elems.length) await lo.selectListObjectValues("/qListObjectDef", elems, false);
  return { total, achados: elems.length };
}
async function selecionarValores(app, campo, valores){
  const f = await app.getField(campo);
  await f.selectValues(valores.map(v => ({ qText: String(v), qIsNumeric: typeof v === "number", qNumber: typeof v === "number" ? v : 0 })), false, false);
}

// Pasta Mestre: situação financeira e itens comprados por cliente (2 anos), só dos clientes do Hub.
async function lerPastaMestre(cfg, codigos, ref, log){
  const ano = ref.getFullYear(); const ate = Math.max(1, ref.getMonth());
  const per = a => `Ano={${a}},Mês={"<=${ate}"}`;
  const ped = `TIPO_OPER={'11.Pedidos'},Cancelado={'0'},FAT={'S'}`;
  return withApp(Object.assign({}, cfg, { appId: PASTA_MESTRE }), async (app) => {
    const sel = await selecionarCodigos(app, "COD_CLIENTE", codigos);
    log(`Pasta Mestre: ${sel.achados} de ${codigos.length} clientes do Hub encontrados (campo COD_CLIENTE com ${sel.total} valores).`);
    if(!sel.achados) throw new Error("nenhum cliente do Hub encontrado no campo COD_CLIENTE da Pasta Mestre");
    const fin = new Map();
    const rf = await cubo(app, ["COD_CLIENTE"], ["max([Limite Crédito])", "only([Situação Financeira])", "max([Vencimento Limite])", "max(Carteira_Total)", "sum(Vencido_CR)"], { qSuppressZero: false });
    rf.forEach(r => fin.set(codNorm(txt(r[0])), { lim: r2(num(r[1])), sit: txt(r[2]) || null, venc: serialToIso(num(r[3])), cart: r2(num(r[4])), vencido: r2(num(r[5])) }));
    await selecionarValores(app, "Ano", [ano - 1, ano]);
    const rows = await cubo(app, ["COD_CLIENTE", "Item C/ Código"], [
      `sum({<${per(ano - 1)}>} VL_TOTAL)`, `sum({<${per(ano)}>} VL_TOTAL)`,
      `sum({<${per(ano - 1)}>} QT_PEDIDO)`, `sum({<${per(ano)}>} QT_PEDIDO)`,
      `FirstSortedValue({<${ped}>} DISTINCT VL_UNITARIO, -DATA_EMISSAO)`,
      `max({<${ped}>} DATA_EMISSAO)`,
      `FirstSortedValue({<${ped}>} DISTINCT QT_PEDIDO, -DATA_EMISSAO)`,
      `sum({<${ped}>} QT_PEDIDO)`,
      `only(LINHA_ITEM)`, `only(SUB_FAMILIA_ITEM)`
    ]);
    const itens = [];
    for(const r of rows){
      const cod = codNorm(txt(r[0])); const item = txt(r[1]);
      if(!cod || !item || item === "-") continue;
      itens.push({ cod, item, v25: r2(num(r[2])), v26: r2(num(r[3])), q25: num(r[4]), q26: num(r[5]), pu: r2(num(r[6])),
        dt: serialToIso(num(r[7])), qu: num(r[8]), qt: num(r[9]), linha: txt(r[10]) || null, sub: txt(r[11]) || null });
    }
    log(`Pasta Mestre: ${fin.size} clientes com dados financeiros · ${itens.length} pares cliente x item (${ano - 1}-${ano}).`);
    return { fin, itens };
  });
}

const mediana = a => { if(!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

// Mix sugerido: itens que o cliente comprou menos este ano (jan..mês anterior) que no ano passado,
// do maior para o menor valor perdido, com o último preço pago e a quantidade do último pedido.
function mixSugerido(lista, max = 6){
  return lista.filter(i => i.v25 > 0 && i.v26 < i.v25)
    .map(i => ({ item: i.item, linha: i.linha, sub: i.sub, v25: i.v25, v26: i.v26, gap: r2(i.v25 - i.v26), q25: i.q25, q26: i.q26,
      pu: i.pu, dt: i.dt, qSug: Math.max(i.qu || 0, Math.round(Math.max(0, i.q25 - i.q26) / 3)) || i.qu || 1, st: i.v26 <= 0 ? "Não comprou" : "Deficitário" }))
    .sort((a, b) => b.gap - a.gap).slice(0, max);
}

// Itens que o cliente não compra, mas que os clientes do Hub que compram o mesmo que ele também compram
// (confiança da associação "quem compra A também compra B") ou que a maioria do segmento dele compra.
function montarCruzadas(itens, segDe){
  const porCli = new Map(), porItem = new Map(), info = new Map(), precos = new Map();
  for(const i of itens){
    if(!(i.qt > 0 || i.v25 > 0 || i.v26 > 0)) continue;
    (porCli.get(i.cod) || porCli.set(i.cod, new Set()).get(i.cod)).add(i.item);
    (porItem.get(i.item) || porItem.set(i.item, new Set()).get(i.item)).add(i.cod);
    if(!info.has(i.item)) info.set(i.item, { linha: i.linha, sub: i.sub });
    if(i.pu > 0) (precos.get(i.item) || precos.set(i.item, []).get(i.item)).push(i.pu);
  }
  const co = new Map(); // item -> Map(item -> nº de clientes que compram os dois)
  for(const set of porCli.values()){
    const arr = [...set]; if(arr.length > 80) continue; // distribuidores enormes distorcem a associação
    for(const a of arr){ const m = co.get(a) || co.set(a, new Map()).get(a); for(const b of arr) if(a !== b) m.set(b, (m.get(b) || 0) + 1); }
  }
  const segCount = new Map(), segItem = new Map();
  for(const [cod, set] of porCli){ const s = segDe(cod); if(!s) continue; segCount.set(s, (segCount.get(s) || 0) + 1); const m = segItem.get(s) || segItem.set(s, new Map()).get(s); set.forEach(it => m.set(it, (m.get(it) || 0) + 1)); }
  return function cruzadas(cod, max = 3){
    const tem = porCli.get(cod) || new Set(); const cand = new Map();
    for(const a of tem){
      const na = (porItem.get(a) || new Set()).size; if(na < 5) continue;
      for(const [b, n] of co.get(a) || []){
        if(tem.has(b) || n < 5) continue;
        const conf = n / na;
        if(conf >= 0.3 && (!cand.has(b) || cand.get(b).conf < conf)) cand.set(b, { item: b, conf: Math.round(conf * 100) / 100, base: a, n, tipo: "associacao" });
      }
    }
    const s = segDe(cod); const ns = segCount.get(s) || 0;
    if(ns >= 10) for(const [b, n] of segItem.get(s) || []){
      if(tem.has(b)) continue; const pen = n / ns;
      if(pen >= 0.3 && !cand.has(b)) cand.set(b, { item: b, conf: Math.round(pen * 100) / 100, base: null, seg: s, n, tipo: "segmento" });
    }
    return [...cand.values()].sort((x, y) => y.conf - x.conf).slice(0, max)
      .map(c => Object.assign(c, info.get(c.item) || {}, { pu: r2(mediana(precos.get(c.item) || [])) }));
  };
}

// Grava em cada cliente do Hub o campo "analise" (uma vez por dia; a página só lê).
async function analisarClientes(db, cfg, clientes, { dry, log = console.log, ref = hoje(), forcar = false } = {}){
  const dia = isoLocal(ref);
  const st = db ? await db.doc("hub_sync/analise").get() : null;
  if(!forcar && st && st.exists && st.data().dia === dia){ log("Análise de clientes (potencial, mix) já feita hoje."); return null; }
  const codigos = [...new Set(clientes.map(c => codNorm(c.cod)).filter(Boolean))];
  const pot = await lerPotenciais(cfg, ref, log);
  const pm = await lerPastaMestre(cfg, codigos, ref, log);
  const segDe = (() => { const m = new Map(clientes.map(c => [codNorm(c.cod), c.seg || null])); return cod => m.get(cod); })();
  const cruzadas = montarCruzadas(pm.itens, segDe);
  const porCli = new Map(); pm.itens.forEach(i => (porCli.get(i.cod) || porCli.set(i.cod, []).get(i.cod)).push(i));
  const refTxt = `jan-${MESES[pot.ate - 1]}`;
  const cont = { Potencial: 0, Deficitário: 0, "Não comprou": 0, sem: 0 };
  const ops = clientes.map(c => {
    const k = codNorm(c.cod); const p = pot.mapa.get(k);
    const potO = p ? { v25: p.v25, v26: p.v26, leg: classificaYoy(p.v25, p.v26), anoAnt: pot.ano - 1, ano: pot.ano, per: refTxt } : null;
    cont[potO ? potO.leg : "sem"]++;
    const analise = { dia, per: refTxt, ano: pot.ano, pot: potO, fin: pm.fin.get(k) || null, mix: mixSugerido(porCli.get(k) || []), cross: cruzadas(k) };
    return [db.doc("hub_clientes/" + docIdCod(c.cod)), { analise }, true];
  });
  log(`Análise de clientes: ${cont.Potencial} potenciais · ${cont["Deficitário"]} deficitários · ${cont["Não comprou"]} não compraram · ${cont.sem} sem pedidos em ${refTxt} dos dois anos.`);
  log(`Mix sugerido para ${ops.filter(o => o[1].analise.mix.length).length} clientes · itens novos sugeridos para ${ops.filter(o => o[1].analise.cross.length).length}.`);
  await commitEmLotes(db, ops, dry);
  if(!dry) await db.doc("hub_sync/analise").set({ dia, em: new Date().toISOString(), per: refTxt, ano: pot.ano, clientes: ops.length, cont });
  return cont;
}

async function gravarMetas(db, cfg, apelidos, { dry, log = console.log, ref = hoje() } = {}){
  const linhas = await lerMetas(cfg, ref, log);
  const { porPessoa, sem } = metasPorPessoa(linhas, apelidos);
  const du = diasUteisRestantes(ref);
  log(`Metas no organograma: ${Object.keys(porPessoa).length} pessoas · ${du} dias úteis restantes no mês.` + (sem.length ? ` ${sem.length} representantes com meta estão fora do organograma.` : ""));
  // O log do GitHub de um repositório público é público: só contagens, sem valores por pessoa ou cliente.
  if(!dry && db) await db.doc("hub_sync/metas").set({ mes: isoLocal(ref).slice(0, 7), em: new Date().toISOString(), diasUteis: du, metaOrthoPct: META_ORTHO, linhaOrtho: LINHA_ORTHO, porPessoa });
  return { porPessoa, du };
}

module.exports = { diasUteisRestantes, metasPorPessoa, calcMeta, classificaYoy, mixSugerido, montarCruzadas, analisarClientes, gravarMetas, codNorm, LINHA_ORTHO };
