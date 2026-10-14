"use strict";
// Teste da lógica de "inativam no mês" (base fixa, fechamento e cópia da Pipeline) com um banco em memória.
const assert = require("assert");
const R = require("./risco");
const { syncClientes, isoLocal, hoje, pedidoInfo } = require("./hub");

function memDB(){
  const store = new Map();
  const merge = (a, b) => { const o = { ...(a || {}) }; Object.entries(b).forEach(([k, v]) => { o[k] = (v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) ? merge(o[k], v) : v; }); return o; };
  const snap = (p) => ({ id: p.split("/").pop(), exists: store.has(p), data: () => JSON.parse(JSON.stringify(store.get(p) || {})) });
  const doc = p => ({ path: p, get: async () => snap(p), set: async (d, o) => { store.set(p, o && o.merge ? merge(store.get(p), d) : JSON.parse(JSON.stringify(d))); }, delete: async () => store.delete(p) });
  const col = (name, filt) => ({ where: (f, op, v) => col(name, [f, v]), get: async () => ({ size: 0, docs: [...store.keys()].filter(k => k.startsWith(name + "/") && k.split("/").length === name.split("/").length + 1 && (!filt || (store.get(k) || {})[filt[0]] === filt[1])).map(snap) }) });
  const db = { store, doc, collection: col, getAll: async (...refs) => refs.map(r => snap(r.path)),
    batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), delete: r => ops.push(() => r.delete()), commit: async () => { for(const f of ops) await f(); } }; } };
  return db;
}
const log = () => {};
const hj = hoje(); const mk = isoLocal(hj).slice(0, 7);
const dia = n => `${mk}-${String(n).padStart(2, "0")}`;

(async () => {
  assert.deepStrictEqual(pedidoInfo([{ pedido: "2", valor: 10, data: dia(5) }, { pedido: "1", valor: 5, data: dia(3) }, { pedido: "3", valor: 0, data: dia(1) }]), { pedidos: ["1", "2"], valor: 15, dtPrimeiro: dia(3) });
  assert.deepStrictEqual(R.resultadoDoMes({ stage: "contato", pedidoId: { valor: 1 } }, 0), { r: "ganho", a: true });
  assert.deepStrictEqual(R.resultadoDoMes({ stage: "proposta" }, 0), { r: "perdido", a: true });
  assert.deepStrictEqual(R.resultadoDoMes({ stage: "perdido" }, 500), { r: "perdido", a: false });

  const db = memDB();
  const cli = (cod, g, o) => Object.assign({ cod, codGrupo: g, vendId: "ana", cli: "C" + cod, dtUltFat: "2026-01-01", dtInat: dia(20) }, o);
  // 3 clientes inativam no mês (2 do mesmo grupo), 1 ativo; a Pipeline traz mais 1 que já comprou e saiu do mês.
  const clientes = [cli("1", "G1"), cli("2", "G1"), cli("3", "G3"), cli("4", "G4", { dtUltFat: dia(1), dtInat: "2099-01-01" }), cli("5", "G5", { dtUltFat: dia(2), dtInat: "2099-02-01" })];
  const { set, base } = await R.garantirBase(db, mk, clientes, { log, extraCods: new Set(["5", "999"]), fonteExtra: "pipeline" });
  assert.deepStrictEqual([...set].sort(), ["1", "2", "3", "5"]);
  assert.strictEqual(base.grupos, 3, "conta grupos, não clientes");
  // A base não muda depois de criada.
  const b2 = await R.garantirBase(db, mk, clientes.concat(cli("6", "G6")), { log });
  assert.strictEqual(b2.set.size, 4);

  // Sincronização: o cliente 5 comprou (data de inativação mudou), mas continua em "inativam no mês" até o fechamento.
  const pedidos = { mes: new Map([["5", 900]]), ant: new Map(), tri: new Map(), mesLista: new Map([["5", [{ pedido: "P9", valor: 900, data: dia(2) }]]]) };
  await syncClientes(db, clientes, { log, pedidos, base: set, mk });
  const c5 = db.store.get("hub_clientes/5");
  assert.strictEqual(c5.pipe, "risco"); assert.strictEqual(c5.mesRisco, mk); assert.strictEqual(c5.pedidoId.valor, 900); assert.strictEqual(c5.codGrupo, "G5");
  assert.strictEqual(db.store.get("hub_clientes/4").pipe, "ativo");

  // Cópia da Pipeline (mês aberto): cliente 1 em Proposta lá fica em leitura no Hub com os dados de lá.
  const dados = { [mk]: { fechado: false, leads: [{ cod: "1", stage: "proposta", ofensor: null, contatoDecisor: "Maria", whatsapp: "51999", dtUltimoContato: dia(5), dtProximoContato: dia(25), horaProximoContato: "10:00", valorProposta: 3000, linhasPositivadas: ["Ortho"], notes: "Mandei proposta", hist: [{ d: dia(5) + "T10:00:00Z", t: 'Movido de "Inativam no mês" para "Proposta enviada"' }], vendedor: "ANA" }] } };
  const fpipe = { doc: () => ({ get: async () => ({ exists: false }) }) };
  await R.importarPipeline(db, fpipe, dados, { log, mkAtual: mk, clientes });
  let c1 = db.store.get("hub_clientes/1");
  assert.strictEqual(c1.travaPipeline, mk); assert.strictEqual(c1.stage, "proposta"); assert.strictEqual(c1.valorProposta, 3000); assert.strictEqual(c1.decisor, "Maria");
  assert.strictEqual(c1.crm.filter(x => x.origem === "pipeline:" + mk).length, 2);
  await R.importarPipeline(db, fpipe, dados, { log, mkAtual: mk, clientes }); // sem mudança: não duplica
  assert.strictEqual(db.store.get("hub_clientes/1").crm.length, 2);

  // Vendedor marca o cliente 2 como perdido no Hub.
  db.store.set("hub_clientes/2", { ...db.store.get("hub_clientes/2"), stage: "perdido", ofensor: "Preço" });

  // Fechamento do mês: 1 (Proposta, sem pedido) -> perdido automático; 2 -> perdido do vendedor;
  // 3 -> perdido automático; 5 (pedido identificado) -> ganho automático.
  const cont = await R.fecharMes(db, mk, { log, pedidosAnt: new Map() });
  assert.deepStrictEqual(cont, { ganho: 1, perdido: 3, ganhoAuto: 1, perdidoAuto: 2 });
  const bf = db.store.get("hub_bases/" + mk);
  assert.strictEqual(bf.fechado, true);
  assert.strictEqual(bf.itens.find(i => i.c === "5").r, "ganho");
  c1 = db.store.get("hub_clientes/1");
  assert.strictEqual(c1.stage, "carteira"); assert.strictEqual(c1.travaPipeline, null);
  assert.strictEqual(c1.fechamentos[0].resultado, "perdido"); assert.strictEqual(c1.fechamentos[0].auto, true); assert.strictEqual(c1.fechamentos[0].etapa, "Proposta enviada");
  assert.ok(/Fechamento de/.test(c1.crm[0].t));
  assert.strictEqual(await R.fecharMes(db, mk, { log }), null, "não fecha duas vezes");
  console.log("Testes OK: base fixa por grupo, pedido identificado, cópia da Pipeline e fechamento do mês.");
})().catch(e => { console.error(e); process.exit(1); });
