"use strict";
// Clientes que inativam no mês: mesma lógica da Pipeline de Retenção.
//  - Base fixa do mês (hub_bases/AAAA-MM): levantada no dia 1, contada por grupo de clientes (Cód Grupo).
//    Quem está na base fica em "Inativam no mês" até o fechamento, mesmo que compre e a data de inativação mude.
//  - Fechamento (dia 1 do mês seguinte): Ganho/Perdido do vendedor ficam; com pedido identificado vira
//    Ganho automático; o resto vira Perdido automático. O resultado vai para o histórico do cliente e ele
//    volta para a Carteira de clientes com o status novo.
//  - Leitura da Pipeline de Retenção (somente leitura): copia para o Hub o que a equipe preencheu lá.
const { hash, lerVarios, commitEmLotes, isoLocal, hoje, classificar, docIdCod } = require("./hub");

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const mkLabel = mk => { const [y, m] = mk.split("-").map(Number); return MESES[m - 1] + "/" + y; };
const mkDe = d => isoLocal(d).slice(0, 7);
function mesAnterior(mk){ const [y, m] = mk.split("-").map(Number); return mkDe(new Date(y, m - 2, 1)); }
const ETAPA_L = { carteira: "Inativam no mês", inativam: "Inativam no mês", inativo: "Inativado", contato: "Contato feito",
  proposta: "Proposta enviada", negociando: "Negociando", ganho: "Ganho", perdido: "Negociação perdida" };
const grupoDe = c => (c.codGrupo && String(c.codGrupo).trim()) || ("c" + String(c.cod).trim());

// ---------- base fixa do mês ----------
// clientes: lista do Qlik já filtrada pelo organograma (cod, codGrupo, vendId, dtUltFat, dtInat).
// extraCods: códigos que a Pipeline de Retenção tem no mês (levantados por ela no dia 1). Nos meses em que a
// Pipeline ainda é usada, a base dela é a oficial: substitui a do Hub (só os clientes do organograma).
async function garantirBase(db, mk, clientes, { dry, log, extraCods, fonteExtra }){
  const ref = db.doc("hub_bases/" + mk);
  const snap = await ref.get();
  const porCod = new Map(clientes.map(c => [String(c.cod).trim(), c]));
  const item = c => ({ c: String(c.cod).trim(), g: grupoDe(c), v: c.vendId || null });
  if(snap.exists){
    const b = snap.data();
    const set = new Set((b.itens || []).map(i => i.c));
    if(extraCods && !(b.fonte || []).includes(fonteExtra) && !b.fechado){
      const itens = [...extraCods].filter(c => porCod.has(c)).map(c => item(porCod.get(c)));
      const grupos = new Set(itens.map(i => i.g)).size;
      if(!dry) await ref.set({ itens, fonte: [fonteExtra], grupos, clientes: itens.length, baseAnteriorHub: { grupos: b.grupos || 0, clientes: b.clientes || 0 }, substituidaEm: new Date().toISOString() }, { merge: true });
      log(`Base de ${mkLabel(mk)} passou a ser a da Pipeline de Retenção (levantada no dia 1): ${grupos} grupos (${itens.length} clientes do organograma). Antes: ${b.grupos || 0} grupos.`);
      return { set: new Set(itens.map(i => i.c)), base: { ...b, itens, grupos, clientes: itens.length } };
    }
    return { set, base: b };
  }
  const hj = hoje();
  const lista = extraCods ? [...extraCods].filter(c => porCod.has(c)).map(c => porCod.get(c)) : clientes.filter(c => classificar(c.dtUltFat, c.dtInat, hj) === "risco");
  const set = new Set(lista.map(c => String(c.cod).trim()));
  const fonte = extraCods ? [fonteExtra] : ["qlik"];
  const itens = lista.map(item);
  const base = { mk, criadaEm: new Date().toISOString(), fonte, itens, grupos: new Set(itens.map(i => i.g)).size, clientes: itens.length, fechado: false };
  if(!dry) await ref.set(base);
  log(`Base fixa de ${mkLabel(mk)} criada: ${base.grupos} grupos de clientes (${base.clientes} clientes) que inativam no mês. Meta de recuperação: 70%.`);
  return { set, base };
}

// ---------- fechamento do mês ----------
// Regra igual à da Pipeline: Ganho e Negociação perdida do vendedor ficam; com pedido identificado vira Ganho
// automático; o resto vira Perdido automático.
function resultadoDoMes(ex, pedidoAnt){
  if(ex.stage === "ganho") return { r: "ganho", a: false };
  if(ex.stage === "perdido") return { r: "perdido", a: false };
  if(ex.pedidoId || pedidoAnt > 0) return { r: "ganho", a: true };
  return { r: "perdido", a: true };
}
async function fecharMes(db, mk, { dry, log, pedidosAnt }){
  const ref = db.doc("hub_bases/" + mk);
  const snap = await ref.get();
  if(!snap.exists || snap.data().fechado) return null;
  const base = snap.data();
  const docs = await db.collection("hub_clientes").where("mesRisco", "==", mk).get();
  const hjIso = isoLocal(hoje());
  const porCod = new Map();
  const ops = [];
  const cont = { ganho: 0, perdido: 0, ganhoAuto: 0, perdidoAuto: 0 };
  docs.docs.forEach(d => {
    const ex = d.data();
    const cod = String(ex.cod || d.id).trim();
    const pedAnt = pedidosAnt ? (pedidosAnt.get(cod) || 0) : 0;
    const { r, a } = resultadoDoMes(ex, pedAnt);
    const etapa = ETAPA_L[ex.stage] || ex.stage || "";
    const valor = r === "ganho" ? (Number(ex.valor) || (ex.pedidoId && ex.pedidoId.valor) || Math.round(pedAnt) || 0) : 0;
    const f = { mes: mk, resultado: r, auto: a, fonte: ex.travaPipeline === mk ? "pipeline" : "hub", etapa, ofensor: ex.ofensor || null, ofDet: ex.ofDet || null, valor, pedidoId: ex.pedidoId || null, acao: ex.acao || null, valorProposta: ex.valorProposta || null, linhas: ex.linhas || [] };
    porCod.set(cod, { r, a: a, e: etapa, o: ex.ofensor || null, val: valor });
    cont[r]++; if(a) cont[r === "ganho" ? "ganhoAuto" : "perdidoAuto"]++;
    const txt = `Fechamento de ${mkLabel(mk)} (inativam no mês): ${r === "ganho" ? "Ganho" : "Negociação perdida"}${a ? " automático" : ""}` +
      (a ? (r === "ganho" ? " — pedido identificado no Qlik e não movido pelo vendedor." : ` — estava em "${etapa}", sem pedido e sem ação do vendedor.`) : "") +
      (ex.ofensor ? ` Ofensor: ${ex.ofensor}.` : "") + " O cliente voltou para a Carteira de clientes.";
    ops.push([db.doc("hub_clientes/" + d.id), {
      fechamentos: (ex.fechamentos || []).filter(x => x.mes !== mk).concat(f),
      crm: [{ d: hjIso, t: txt, autor: "Fechamento automático", resp: "" }].concat(ex.crm || []),
      hist: [{ d: hjIso, t: txt }].concat(ex.hist || []).slice(0, 30),
      stage: "carteira", dtEtapa: hjIso, ofensor: null, ofDet: null, valorProposta: null, linhas: [], acao: null, valor: 0,
      pedidoId: null, travaPipeline: null
    }, true]);
  });
  const itens = (base.itens || []).map(i => porCod.has(i.c) ? { ...i, ...porCod.get(i.c) } : { ...i, r: "perdido", a: true, e: "fora do Hub" });
  ops.push([ref, { itens, fechado: true, fechadoEm: new Date().toISOString(), resumo: cont }, true]);
  await commitEmLotes(db, ops, dry);
  const gr = new Map(); itens.forEach(i => { if(i.r === "ganho" || !gr.has(i.g)) gr.set(i.g, i.r); });
  const recup = [...gr.values()].filter(x => x === "ganho").length;
  log(`Fechamento de ${mkLabel(mk)}: ${cont.ganho} ganho (${cont.ganhoAuto} automático) · ${cont.perdido} perdido (${cont.perdidoAuto} automático). Grupos recuperados: ${recup} de ${gr.size} (${gr.size ? Math.round(recup / gr.size * 100) : 0}%; meta 70%).`);
  return cont;
}

// ---------- Pipeline de Retenção (somente leitura) ----------
async function lerPipeline(fpipe, meses, log){
  const out = {};
  for(const mk of meses){
    const meta = await fpipe.doc("months/" + mk).get();
    if(!meta.exists){ log(`Pipeline de Retenção: mês ${mk} não existe.`); continue; }
    const chunks = await fpipe.collection("months/" + mk + "/chunks").get();
    const leads = []; chunks.docs.forEach(c => (c.data().leads || []).forEach(l => leads.push(l)));
    out[mk] = { fechado: !!meta.data().fechado, leads };
  }
  return out;
}
function ofDetDaPipeline(of, d){
  if(!of) return null;
  d = d || {}; const o = { tipo: of };
  if(d.itemPerdido) o.item = d.itemPerdido; if(d.precoConcorrencia) o.preco = Number(d.precoConcorrencia) || null; if(d.comprovacaoId) o.anexo = "p_" + d.comprovacaoId;
  if(d.linhasCompradas) o.linhas = d.linhasCompradas; if(d.itemFaltante) o.item = d.itemFaltante; if(d.quantidadeDesejada) o.qtd = Number(d.quantidadeDesejada) || null;
  if(d.meiosTentados) o.meios = d.meiosTentados;
  return o;
}
const etapaHub = s => (s === "inativam" || s === "inativo" || !s) ? "carteira" : s;
function resumoPipeline(l){
  return {
    stage: etapaHub(l.stage), etapaPipe: l.stage || "inativam", ofensor: l.ofensor || null, ofDet: ofDetDaPipeline(l.ofensor, l.ofensorDetalhe),
    acao: l.acao || null, whatsapp: l.whatsapp || "", semWpp: !!l.whatsappIndisponivel, decisor: l.contatoDecisor || "",
    dtUltContato: l.dtUltimoContato || null, prox: l.dtProximoContato || null, horaProx: l.horaProximoContato || null,
    valorProposta: l.valorProposta || null, linhas: l.linhasPositivadas || [], valor: Number(l.valorPedido) || 0,
    notes: l.notes || "", hist: (l.hist || []).map(h => ({ d: String(h.d || "").slice(0, 10), t: h.t })),
    fechamentoAuto: l.fechamentoAuto || null, pedidoIdentificado: l.pedidoIdentificado || null, vendedor: l.vendedor || ""
  };
}
// Copia para o Hub o que foi preenchido na Pipeline. Mês aberto: o cliente fica em leitura no Hub (travaPipeline) e
// espelha etapa, CRM, ofensor e proposta. Mês fechado: o resultado entra em "Resultados de meses anteriores".
async function importarPipeline(db, fpipe, dados, { dry, log, mkAtual, clientes }){
  const porCod = new Map(clientes.map(c => [String(c.cod).trim(), c]));
  const hjIso = isoLocal(hoje());
  const idxRef = db.doc("hub_sync/pipeline");
  const idxSnap = await idxRef.get();
  const idx = idxSnap.exists ? (idxSnap.data().h || {}) : {};
  const mudou = [];
  for(const [mk, m] of Object.entries(dados)){
    for(const l of m.leads){
      const cod = String(l.cod || "").trim();
      if(!porCod.has(cod)) continue;
      const res = resumoPipeline(l);
      const h = hash(JSON.stringify([m.fechado, res]));
      if(idx[cod + "|" + mk] === h) continue;
      mudou.push({ cod, mk, fechado: m.fechado, res, h });
    }
    // Mês fechado sem base no Hub (ex.: setembro/2026): monta a base a partir da Pipeline, para o histórico do Dashboard.
    if(m.fechado){
      const bref = db.doc("hub_bases/" + mk);
      const bs = await bref.get();
      if(!bs.exists){
        const itens = m.leads.filter(l => porCod.has(String(l.cod).trim())).map(l => { const c = porCod.get(String(l.cod).trim()); const st = l.stage;
          return { c: String(l.cod).trim(), g: (l.codGrupo && String(l.codGrupo).trim()) || grupoDe(c), v: c.vendId || null, r: st === "ganho" ? "ganho" : "perdido", a: !!l.fechamentoAuto || (st !== "ganho" && st !== "perdido"), e: ETAPA_L[st] || st || "", o: l.ofensor || null, val: st === "ganho" ? (Number(l.valorPedido) || 0) : 0 }; });
        if(!dry) await bref.set({ mk, criadaEm: new Date().toISOString(), fonte: ["pipeline"], itens, grupos: new Set(itens.map(i => i.g)).size, clientes: itens.length, fechado: true, fechadoEm: new Date().toISOString() });
        log(`Base de ${mkLabel(mk)} montada a partir da Pipeline de Retenção: ${itens.length} clientes do organograma.`);
      }
    }
  }
  if(!mudou.length){ log("Pipeline de Retenção: nada novo para copiar."); return 0; }
  const lidos = await lerVarios(db, [...new Set(mudou.map(x => docIdCod(x.cod)))]);
  const anexos = new Set(); const ops = [];
  const porDoc = new Map();
  mudou.forEach(x => { const id = docIdCod(x.cod); if(!porDoc.has(id)) porDoc.set(id, []); porDoc.get(id).push(x); });
  for(const [id, lista] of porDoc){
    const ex = lidos.get(id); if(!ex) continue;
    let crm = (ex.crm || []).slice(); let fech = (ex.fechamentos || []).slice();
    const upd = {};
    lista.sort((a, b) => a.mk.localeCompare(b.mk)).forEach(x => {
      const r = x.res; const pref = `Pipeline de Retenção · ${mkLabel(x.mk)}: `;
      const novos = r.hist.slice().reverse().concat(r.notes ? [{ d: r.dtUltContato || hjIso, t: "CRM: " + r.notes }] : []);
      novos.forEach(n => { const t = pref + n.t; if(!crm.some(c => c.t === t)) crm.unshift({ d: n.d || hjIso, t, autor: "Pipeline de Retenção", resp: r.vendedor || "", origem: "pipeline:" + x.mk }); });
      if(r.ofDet && r.ofDet.anexo) anexos.add(r.ofDet.anexo);
      if(x.fechado){
        const res = r.stage === "ganho" ? "ganho" : "perdido";
        fech = fech.filter(f => f.mes !== x.mk).concat({ mes: x.mk, resultado: res, auto: !!r.fechamentoAuto, fonte: "pipeline", etapa: ETAPA_L[r.etapaPipe] || "", ofensor: r.ofensor, ofDet: r.ofDet, valor: res === "ganho" ? r.valor : 0, acao: r.acao, valorProposta: r.valorProposta, linhas: r.linhas });
        if(ex.travaPipeline === x.mk) Object.assign(upd, { travaPipeline: null, stage: "carteira", dtEtapa: hjIso, ofensor: null, ofDet: null, valorProposta: null, linhas: [], acao: null, valor: 0 });
      }else if(x.mk === mkAtual){
        Object.assign(upd, { travaPipeline: x.mk, stage: r.stage, ofensor: r.ofensor, ofDet: r.ofDet, acao: r.acao, whatsapp: r.whatsapp || ex.whatsapp || "", semWpp: r.semWpp,
          decisor: r.decisor, dtUltContato: r.dtUltContato, prox: r.prox, horaProx: r.horaProx, valorProposta: r.valorProposta, linhas: r.linhas });
        if(r.valor > 0) upd.valor = r.valor;
        if(r.stage !== (ex.stage || "carteira")) upd.dtEtapa = hjIso;
      }
    });
    crm.sort((a, b) => String(b.d).localeCompare(String(a.d)));
    upd.crm = crm; upd.fechamentos = fech;
    ops.push([db.doc("hub_clientes/" + id), upd, true]);
  }
  // Comprovantes de preço/concorrência: copia o anexo da Pipeline para hub_anexos (uma vez).
  for(const a of anexos){
    const dest = db.doc("hub_anexos/" + a);
    if((await dest.get()).exists) continue;
    const src = await fpipe.doc("attachments/" + a.slice(2)).get();
    if(src.exists){ const d = src.data(); ops.push([dest, { dataUrl: d.dataUrl, name: d.name || "comprovante", type: d.type || "" }, false]); }
  }
  mudou.forEach(x => { idx[x.cod + "|" + x.mk] = x.h; });
  ops.push([idxRef, { h: idx }, false]);
  await commitEmLotes(db, ops, dry);
  log(`Pipeline de Retenção: ${porDoc.size} clientes atualizados com o que a equipe preencheu lá (${Object.keys(dados).map(mkLabel).join(", ")}).`);
  return porDoc.size;
}

module.exports = { garantirBase, fecharMes, lerPipeline, importarPipeline, resultadoDoMes, resumoPipeline, mesAnterior, mkLabel, grupoDe };
