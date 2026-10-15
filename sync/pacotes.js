"use strict";
// Pacotes da carteira (economia de leituras do Firebase).
// Uma vez por dia o robô lê todos os clientes e grava cópias agrupadas por vendedor em poucos documentos
// (hub_sync/pc_<vendedor>_<n>), mais os pacotes da análise comercial (hub_sync/an_<vendedor>_<n>).
// A página baixa só os pacotes de quem ela pode ver, guarda no aparelho e, depois, busca apenas os
// clientes com "upd" mais novo que a montagem (o que o robô ou a equipe mudou ao longo do dia).
const { isoLocal, hoje } = require("./hub");

const LIMITE = 600 * 1024; // bem abaixo do limite de 1 MB por documento do Firestore
// O conteúdo vai como texto (JSON) num único campo: o Firestore indexa cada campo de um mapa, e um pacote com
// centenas de clientes passaria do limite de entradas de índice por documento.
const slug = v => String(v || "sem-vendedor").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60) || "sem-vendedor";
const ms = v => v && typeof v.toMillis === "function" ? v.toMillis() : v;

// Converte datas do Firestore em número (milissegundos) para caber num pacote comum.
function plano(o){
  const out = {};
  Object.entries(o).forEach(([k, v]) => { out[k] = ms(v); });
  return out;
}
// Divide uma lista em partes que respeitam o tamanho máximo de documento.
function partir(itens, tamanho = it => JSON.stringify(it).length){
  const partes = []; let atual = [], soma = 0;
  for(const it of itens){
    const t = tamanho(it) + 1;
    if(atual.length && soma + t > LIMITE){ partes.push(atual); atual = []; soma = 0; }
    atual.push(it); soma += t;
  }
  if(atual.length) partes.push(atual);
  return partes;
}

// clientesDocs: [{ id, data }] · analises: Map(id do documento -> análise completa) ou null
function montar(clientesDocs, analises){
  const porVend = new Map(), anPorVend = new Map();
  for(const d of clientesDocs){
    const o = plano(d.data); o._id = d.id;
    const an = analises ? analises.get(d.id) : null;
    const leg = an || o.analise || null;
    o.analise = leg ? { pot: leg.pot || null, dia: leg.dia || null } : null; // só o resumo; o resto vai no pacote de análise
    const v = slug(o.vend);
    (porVend.get(v) || porVend.set(v, []).get(v)).push(o);
    if(an) (anPorVend.get(v) || anPorVend.set(v, []).get(v)).push([d.id, an]);
  }
  const docs = []; const indice = {}; const anIndice = {};
  for(const [v, lista] of porVend){
    partir(lista).forEach((parte, i) => { const id = `pc_${v}_${i}`; docs.push([id, { vend: v, i, n: parte.length, dados: JSON.stringify(parte) }]); (indice[v] = indice[v] || []).push(id); });
  }
  for(const [v, lista] of anPorVend){
    partir(lista, it => JSON.stringify(it[1]).length + 20).forEach((parte, i) => { const id = `an_${v}_${i}`; docs.push([id, { vend: v, i, n: parte.length, dados: JSON.stringify(Object.fromEntries(parte)) }]); (anIndice[v] = anIndice[v] || []).push(id); });
  }
  return { docs, indice, anIndice };
}

async function montarPacotes(db, { dry, log = console.log, analises = null, forcar = false } = {}){
  const dia = isoLocal(hoje());
  const ref = db.doc("hub_sync/pacotes");
  const atual = await ref.get(); const ant = atual.exists ? atual.data() : {};
  if(!forcar && !analises && ant.dia === dia) return null;
  // Marca d'água: tudo gravado depois deste instante (com folga para diferença de relógio) a página busca separado.
  const builtAt = Date.now() - 3 * 60 * 1000;
  const snap = await db.collection("hub_clientes").get();
  const { docs, indice, anIndice } = montar(snap.docs.map(d => ({ id: d.id, data: d.data() })), analises);
  const usaAnAntigo = !analises && ant.anIndice;
  const novos = new Set(docs.map(d => d[0]));
  const antigos = [].concat(...Object.values(ant.indice || {}), ...(usaAnAntigo ? [] : Object.values(ant.anIndice || {})));
  const apagar = antigos.filter(id => !novos.has(id));
  const tamanho = docs.reduce((a, d) => a + JSON.stringify(d[1]).length, 0);
  log(`Pacotes da carteira: ${snap.size} clientes em ${Object.values(indice).flat().length} pacotes` +
    (analises ? ` + ${Object.values(anIndice).flat().length} pacotes de análise` : "") + ` (${(tamanho / 1048576).toFixed(1)} MB no total).`);
  if(dry) return { docs: docs.length };
  for(let i = 0; i < docs.length; i += 8){ // lote de até ~5 MB (o Firestore aceita 10 MB por envio)
    const b = db.batch();
    docs.slice(i, i + 8).forEach(([id, data]) => b.set(db.doc("hub_sync/" + id), data));
    await b.commit();
  }
  if(apagar.length){ const b = db.batch(); apagar.forEach(id => b.delete(db.doc("hub_sync/" + id))); await b.commit(); }
  await ref.set({ dia, builtAt, em: new Date().toISOString(), total: snap.size, indice,
    anIndice: usaAnAntigo ? ant.anIndice : anIndice, anDia: usaAnAntigo ? (ant.anDia || null) : (analises ? dia : null), removidos: {} });
  return { docs: docs.length, apagados: apagar.length };
}

module.exports = { montar, montarPacotes, partir, slug };
