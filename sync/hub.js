"use strict";
// Converte a tabela de clientes do Qlik no formato da Carteira de clientes do Hub
// e grava no Firestore (coleções hub_*), sem apagar o que os vendedores preencheram.
const L = require("./logic");

const NUM_FIELDS = new Set(["pedPend", "valVenc"]);
const DATE_FIELDS = new Set(["dtCad", "dt1Fat", "dtUltFat", "dtInat", "dtUltPedAberto"]);

// ---------- datas (horário de Brasília: o workflow define TZ=America/Sao_Paulo) ----------
const pad = n => String(n).padStart(2, "0");
const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function hoje(){ const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function pd(s){ if(!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
const dias = (a, b) => Math.round((a - b) / 86400000);

// Regra da carteira (a mesma da página):
//   inativam no mês = data de inativação dentro do mês vigente (tem prioridade)
//   ativo = comprou nos últimos 89 dias · inativo = 90 dias ou mais sem compra
function classificar(dtUltFat, dtInat, ref = hoje()){
  const ini = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const fim = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  const di = pd(dtInat);
  if(di && di >= ini && di <= fim) return "risco";
  const uf = pd(dtUltFat);
  if(!uf) return "inativo";
  return dias(ref, uf) <= 89 ? "ativo" : "inativo";
}
const PIPE_LABEL = { ativo: "Ativos", risco: "Inativariam no mês", inativo: "Inativos" };

// ---------- leitura das colunas ----------
function buildColMap(headers, columnMap = {}){
  const custom = {};
  Object.entries(columnMap).forEach(([k, v]) => { if(!k.startsWith("_")) custom[L.norm(k)] = v; });
  // "Cód Tipo Representante" (VE, GV, Z1…) vem antes do alias genérico, que o confundiria com "Representante".
  return headers.map(h => custom[L.norm(h)] || (/tipo\s*represent/.test(L.norm(h)) ? "tipoRep" : L.aliasHeader(h)));
}
const asText = c => c == null ? null : (c.text != null ? c.text : (c.num != null ? String(c.num) : null));
const asNum = c => c == null ? 0 : (c.num != null ? c.num : L.cleanNum(c.text));
const asDate = c => c == null ? null : (L.excelDateToISO(c.text) || (c.num != null ? L.excelDateToISO(c.num) : null));

function slug(t){ return L.norm(t).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50); }
const docIdCod = cod => String(cod).trim().replace(/\//g, "-");

// Retorna { clientes, pessoas, colMap, unmapped, ignorados }
// apelidos: Map(nome normalizado -> id da pessoa), montado com o organograma do Hub (nome e "alias").
function mapaDePessoas(pessoasDocs){
  const m = new Map();
  pessoasDocs.forEach(p => { [p.nome].concat(p.alias || []).forEach(n => { if(n) m.set(L.norm(n), p.id); }); });
  // O id do organograma segue a grafia do Qlik (ex.: "jessica-soares-porto"): vale como apelido também.
  pessoasDocs.forEach(p => { const n = L.norm(String(p.id || "").replace(/-/g, " ")); if(n && !m.has(n)) m.set(n, p.id); });
  return m;
}
// A carteira de cada pessoa do organograma (vendedores e líderes) é a dos clientes em que ela é o
// VENDEDOR INTERNO, ou seja, Cód Tipo Representante = VE. Representante (Z1), Key Account (Z3) e os
// demais tipos não definem carteira. Clientes cujo vendedor interno não está no organograma ficam fora.
function mapClientes({ headers, rows }, columnMap, apelidos = new Map()){
  const colMap = buildColMap(headers, columnMap);
  const unmapped = headers.filter((h, i) => !colMap[i]);
  const clientes = []; const pessoas = new Map(); const foraNomes = new Map(); const vistos = new Set(); let ignorados = 0, foraDoOrganograma = 0, outrosTipos = 0;
  for(const row of rows){
    const r = {};
    colMap.forEach((key, i) => {
      if(!key) return;
      const c = row[i];
      if(NUM_FIELDS.has(key)) r[key] = asNum(c);
      else if(DATE_FIELDS.has(key)) r[key] = asDate(c);
      else r[key] = L.cleanTxt(asText(c));
    });
    if(!r.cod){ ignorados++; continue; }
    // Tabela com uma linha por cliente e tipo de representante: só a linha VE vale.
    if(r.tipoRep != null && String(r.tipoRep).trim().toUpperCase() !== "VE"){ outrosTipos++; continue; }
    const vendInterno = r.vendInt || (r.tipoRep != null ? r.rep : null);
    if(vistos.has(String(r.cod).trim())) continue;
    const achado = vendInterno && apelidos.has(L.norm(vendInterno)) ? vendInterno : null;
    if(!achado){ foraDoOrganograma++; const n = vendInterno || "(sem vendedor interno)"; foraNomes.set(n, (foraNomes.get(n) || 0) + 1); continue; }
    vistos.add(String(r.cod).trim());
    const vendId = apelidos.get(L.norm(achado));
    pessoas.set(vendId, (pessoas.get(vendId) || 0) + 1);
    const inadSim = /^s(im)?$/i.test(String(r.inad || "").trim());
    clientes.push({
      cod: String(r.cod).trim(), cli: r.cli || null, cnpj: r.cnpj || null, uf: r.uf || null, cid: r.cid || null,
      seg: r.seg || "Segmento Não Definido", tel: r.tel || null, email: r.email || null,
      inad: (r.valVenc || 0) > 0 ? r.valVenc : (inadSim ? 0.01 : 0),
      dtCad: r.dtCad || null, dtUltFat: r.dtUltFat || null, dtInat: r.dtInat || null,
      statusErp: r.statusErp || null, rep: r.tipoRep != null ? null : (r.rep || null), vendId
    });
  }
  return { clientes, porPessoa: pessoas, colMap, unmapped, ignorados, foraDoOrganograma, foraNomes };
}

// ---------- gravação ----------
// Campos que vêm do Qlik e são atualizados a cada sincronização. Todo o resto
// (etapa, CRM, ofensor, proposta, agenda, histórico) é do vendedor e nunca é sobrescrito.
const CAMPOS_QLIK = ["cod", "cli", "cnpj", "uf", "cid", "seg", "email", "inad", "dtCad", "dtUltFat", "dtInat", "statusErp", "rep"];

async function commitEmLotes(db, ops, dry){
  if(dry) return;
  for(let i = 0; i < ops.length; i += 400){
    const b = db.batch();
    ops.slice(i, i + 400).forEach(([ref, data, merge]) => merge ? b.set(ref, data, { merge: true }) : b.set(ref, data));
    await b.commit();
  }
}

// Garante que todo o organograma (config/organograma.json) existe no banco, sem mexer em quem já está lá
// (a gestão pode ter ajustado e-mail, time ou acesso pela página).
async function syncPessoas(db, organograma, { dry, log }){
  const snap = await db.collection("hub_pessoas").get();
  const atuais = new Set(snap.docs.map(d => d.id));
  const ops = organograma.filter(p => !atuais.has(p.id)).map(p => { const { id, ...resto } = p; return [db.doc("hub_pessoas/" + id), { ...resto, origem: "organograma" }, false]; });
  await commitEmLotes(db, ops, dry);
  if(ops.length) log(`Pessoas: ${ops.length} do organograma cadastradas no banco.`);
}

// ---------- índice de sincronização (economiza leituras do Firebase) ----------
// Em vez de ler todos os clientes a cada execução, o robô guarda em poucos documentos (hub_sync/indice_N)
// uma "impressão digital" do que já gravou: carteira | vendedor interno | hash dos dados do Qlik.
// Só lê um cliente do banco quando a carteira ou o vendedor mudou, e só grava quem mudou de verdade.
function hash(str){ let h = 0x811c9dc5; for(let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }
const POR_PARTE = 4000;
async function lerIndice(db){
  const snap = await db.collection("hub_sync").get();
  const m = new Map(); let partes = 0;
  snap.docs.forEach(d => { if(d.id.startsWith("indice_")){ partes++; Object.entries(d.data().m || {}).forEach(([k, v]) => m.set(k, v)); } });
  return { m, partes };
}
async function gravarIndice(db, m, partesAntes){
  const ids = [...m.keys()].sort(); const partes = Math.max(1, Math.ceil(ids.length / POR_PARTE));
  const b = db.batch();
  for(let i = 0; i < partes; i++){ const o = {}; ids.slice(i * POR_PARTE, (i + 1) * POR_PARTE).forEach(k => { o[k] = m.get(k); }); b.set(db.doc("hub_sync/indice_" + i), { m: o }); }
  for(let i = partes; i < partesAntes; i++) b.delete(db.doc("hub_sync/indice_" + i));
  await b.commit();
}
async function lerVarios(db, ids){
  const out = new Map();
  for(let i = 0; i < ids.length; i += 100){
    const snaps = await db.getAll(...ids.slice(i, i + 100).map(id => db.doc("hub_clientes/" + id)));
    snaps.forEach(s => { if(s.exists) out.set(s.id, s.data()); });
  }
  return out;
}
const trabalhado = c => (c.crm || []).length > 0 || (c.stage && c.stage !== "carteira") || c.origem === "prospeccao";

async function syncClientes(db, clientes, { dry, log, pedidos }){
  const hj = hoje(); const hjIso = isoLocal(hj); const agora = new Date().toISOString();
  let { m: idx, partes } = await lerIndice(db);
  if(!partes){
    // Primeira execução com índice: se já houver clientes gravados, monta o índice a partir deles (uma vez só).
    const snap = await db.collection("hub_clientes").get();
    snap.docs.forEach(d => { const c = d.data(); idx.set(d.id, `${c.pipe || ""}|${c.vend || ""}|`); });
    if(snap.size) log(`Índice criado a partir de ${snap.size} clientes já gravados.`);
  }
  const novoIdx = new Map(); const ops = []; const precisaLer = [];
  const cont = { novos: 0, atualizados: 0, iguais: 0, removidos: 0, mantidosFora: 0, ativo: 0, risco: 0, inativo: 0 };
  for(const c of clientes){
    const id = docIdCod(c.cod);
    const pipe = classificar(c.dtUltFat, c.dtInat, hj);
    cont[pipe]++;
    const qlik = {}; CAMPOS_QLIK.forEach(k => { qlik[k] = c[k] ?? null; });
    qlik.dtFatBase = c.dtUltFat || null;
    qlik.pipe = pipe;
    if(pedidos){
      qlik.pedMes = Math.round(pedidos.mes.get(c.cod) || 0); qlik.pedMesAnt = Math.round(pedidos.ant.get(c.cod) || 0);
      if(pedidos.tri) qlik.ticket = Math.round((pedidos.tri.get(c.cod) || 0) / 3); // média mensal dos 3 meses fechados
    }
    const h = hash(JSON.stringify(qlik));
    const entrada = `${pipe}|${c.vendId}|${h}`;
    novoIdx.set(id, entrada);
    const ant = idx.get(id);
    if(ant === undefined){
      ops.push([db.doc("hub_clientes/" + id), {
        ticket: 0, ...qlik, tel: c.tel, whatsapp: c.tel || "", vend: c.vendId, vendManual: false, origem: "qlik",
        stage: "carteira", dtEtapa: hjIso, valor: 0, prox: null, horaProx: null,
        ofensor: null, ofDet: null, crm: [], linhas: [], acao: null, valorProposta: null,
        dt1Contato: null, dtUltContato: null, decisor: "", semWpp: false,
        hist: [{ d: hjIso, t: "Entrou na carteira pela sincronização do Qlik (" + PIPE_LABEL[pipe] + ")" }],
        qlikEm: agora
      }, false]);
      cont.novos++; continue;
    }
    if(ant === entrada){ cont.iguais++; continue; }
    const [pAnt, vAnt] = ant.split("|");
    const upd = { ...qlik, qlikEm: agora };
    if(pAnt !== pipe || vAnt !== c.vendId) precisaLer.push({ id, upd, pAnt, pipe, vendMudou: vAnt !== c.vendId, vendId: c.vendId });
    else ops.push([db.doc("hub_clientes/" + id), upd, true]);
    cont.atualizados++;
  }
  // Mudou de carteira ou de vendedor: lê só esses clientes para registrar no histórico e respeitar trocas feitas pela gestão.
  if(precisaLer.length){
    const lidos = await lerVarios(db, precisaLer.map(x => x.id));
    precisaLer.forEach(x => {
      const ex = lidos.get(x.id) || {};
      if(x.vendMudou && !ex.vendManual) x.upd.vend = x.vendId;
      if(x.pAnt && x.pAnt !== x.pipe) x.upd.hist = [{ d: hjIso, t: `Carteira mudou: ${PIPE_LABEL[x.pAnt] || x.pAnt} → ${PIPE_LABEL[x.pipe]}` }].concat(ex.hist || []).slice(0, 8);
      ops.push([db.doc("hub_clientes/" + x.id), x.upd, true]);
    });
  }
  // Clientes que saíram do organograma: some quem ninguém trabalhou; quem tem CRM ou etapa fica, marcado no índice.
  const sairam = [...idx.keys()].filter(id => !novoIdx.has(id));
  const novos = sairam.filter(id => !String(idx.get(id)).startsWith("fora|"));
  sairam.filter(id => String(idx.get(id)).startsWith("fora|")).forEach(id => { novoIdx.set(id, idx.get(id)); cont.mantidosFora++; });
  if(novos.length){
    const lidos = await lerVarios(db, novos);
    novos.forEach(id => {
      const ex = lidos.get(id);
      if(ex && trabalhado(ex)){ novoIdx.set(id, "fora|" + (ex.vend || "") + "|"); cont.mantidosFora++; }
      else if(ex){ ops.push([db.doc("hub_clientes/" + id), null, "delete"]); cont.removidos++; }
    });
  }
  if(!dry){
    for(let i = 0; i < ops.length; i += 400){
      const b = db.batch();
      ops.slice(i, i + 400).forEach(([ref, data, modo]) => modo === "delete" ? b.delete(ref) : modo ? b.set(ref, data, { merge: true }) : b.set(ref, data));
      await b.commit();
    }
    await gravarIndice(db, novoIdx, partes);
  }
  log(`Clientes: ${clientes.length} lidos · ${cont.novos} novos · ${cont.atualizados} atualizados · ${cont.iguais} sem mudança · ${cont.removidos} removidos (saíram do organograma)${cont.mantidosFora ? ` · ${cont.mantidosFora} fora do organograma mantidos por já terem CRM ou etapa` : ""}.`);
  log(`Carteira: ${cont.ativo} ativos · ${cont.risco} inativariam no mês · ${cont.inativo} inativos. Gravações no banco: ${ops.length}.`);
  return cont;
}

module.exports = { mapaDePessoas, mapClientes, syncClientes, syncPessoas, docIdCod, classificar, isoLocal, hoje, hash };
