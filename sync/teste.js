"use strict";
// Teste sem Qlik e sem Firebase: npm test
process.env.TZ = "America/Sao_Paulo";
const assert = require("assert");
const { mapClientes, syncClientes, syncPessoas, classificar, isoLocal, hoje } = require("./hub");

// Banco falso em memória, com a mesma interface que o robô usa (contando leituras e gravações).
function fakeDb(){
  const docs = new Map(); const uso = { leituras: 0, gravacoes: 0 };
  const snap = (path) => { const v = docs.get(path); return { id: path.split("/")[1], exists: v !== undefined, ref: { path }, data: () => JSON.parse(JSON.stringify(v || {})) }; };
  const aplicar = (path, d, o) => { uso.gravacoes++; docs.set(path, o && o.merge ? { ...(docs.get(path) || {}), ...d } : d); };
  return { docs, uso,
    collection: name => ({ get: async () => { const ks = [...docs.keys()].filter(k => k.startsWith(name + "/")); uso.leituras += ks.length; return { size: ks.length, docs: ks.map(snap) }; } }),
    doc: path => ({ path, get: async () => { uso.leituras++; return snap(path); }, set: async (d, o) => aplicar(path, d, o) }),
    getAll: async (...refs) => { uso.leituras += refs.length; return refs.map(r => snap(r.path)); },
    batch: () => { const ops = []; return { set: (ref, d, o) => ops.push(() => aplicar(ref.path, d, o)), delete: ref => ops.push(() => { uso.gravacoes++; docs.delete(ref.path); }), commit: async () => ops.forEach(f => f()) }; }
  };
}
const t = (txt, num) => ({ text: txt, num: num ?? null });
const hj = hoje(); const d = n => { const x = new Date(hj); x.setDate(x.getDate() - n); return isoLocal(x); };
const fimMes = isoLocal(new Date(hj.getFullYear(), hj.getMonth() + 1, 0));

(async () => {
  // Regra da carteira
  assert.strictEqual(classificar(d(10), d(-200)), "ativo");
  assert.strictEqual(classificar(d(95), d(-30 * 6)), "inativo");
  assert.strictEqual(classificar(d(60), fimMes), "risco");
  // Tabela como o Qlik devolve
  const tabela = {
    headers: ["Cód Cliente", "Razão Social", "UF", "Cidade", "Segmento", "Data Último Faturamento", "Data Inativação", "Inadimplente", "Valor Vencido", "Vendedor Interno (VE)", "Coluna Extra"],
    rows: [
      [t("1001"), t("FARMACIA TESTE"), t("RS"), t("CANOAS"), t("FARMA INDEPENDENTE"), t(d(10).split("-").reverse().join("/")), t(null), t("Não"), t("0", 0), t("KELLY VIEIRA DOS SANTOS"), t("x")],
      [t("1002"), t("ORTOPEDIA TESTE"), t("SC"), t("JOINVILLE"), t("LOJISTA ON"), t(d(120).split("-").reverse().join("/")), t(null), t("Sim"), t("887", 887), t("KELLY VIEIRA DOS SANTOS"), t("x")]
    ]
  };
  const apelidos = new Map([["kelly vieira dos santos", "kelly-vieira-dos-santos"]]);
  const m = mapClientes(tabela, {}, apelidos);
  assert.strictEqual(m.clientes[0].vendId, "kelly-vieira-dos-santos");
  assert.strictEqual(m.clientes.length, 2);
  assert.deepStrictEqual(m.unmapped, ["Coluna Extra"]);
  assert.strictEqual(m.clientes[1].inad, 887);
  assert.strictEqual(m.porPessoa.get("kelly-vieira-dos-santos"), 2);
  // Carteira = vendedor interno (VE). Representante (Z1) do organograma NÃO puxa o cliente.
  const tab2 = { headers: ["Cód Cliente", "Vendedor Interno (VE)", "Representante (Z1)"], rows: [[t("9"), t("FULANO"), t(null)], [t("10"), t("FULANO"), t("KELLY VIEIRA DOS SANTOS")], [t("11"), t("Kelly Vieira dos Santos"), t(null)]] };
  const m2 = mapClientes(tab2, {}, apelidos);
  assert.deepStrictEqual(m2.clientes.map(c => c.cod), ["11"]);
  assert.strictEqual(m2.foraDoOrganograma, 2);
  // Tabela com "Cód Tipo Representante": só a linha VE define a carteira
  const tab3 = { headers: ["Cód Cliente", "Cód Tipo Representante", "Representante"], rows: [[t("20"), t("Z1"), t("KELLY VIEIRA DOS SANTOS")], [t("21"), t("VE"), t("KELLY VIEIRA DOS SANTOS")], [t("21"), t("Z1"), t("FULANO")], [t("22"), t("VE"), t("FULANO")]] };
  const m3 = mapClientes(tab3, {}, apelidos);
  assert.deepStrictEqual(m3.clientes.map(c => c.cod), ["21"]);
  const db = fakeDb(); const log = () => {};
  await syncPessoas(db, [{ id: "kelly-vieira-dos-santos", nome: "Kelly Vieira dos Santos", papel: "sdr", acesso: "propria" }], { log });
  assert.strictEqual(db.docs.get("hub_pessoas/kelly-vieira-dos-santos").origem, "organograma");
  let c = await syncClientes(db, m.clientes, { log });
  assert.strictEqual(c.novos, 2);
  // O vendedor trabalha o cliente; a próxima sincronização não pode apagar isso
  const ref = "hub_clientes/1001";
  db.docs.set(ref, { ...db.docs.get(ref), stage: "proposta", crm: [{ d: "2026-10-01", t: "Liguei" }] });
  // Sem nada mudar no Qlik: o robô lê só o índice e não grava nenhum cliente
  const antes = { ...db.uso };
  c = await syncClientes(db, m.clientes, { log });
  assert.strictEqual(c.iguais, 2);
  assert.ok(db.uso.leituras - antes.leituras <= 3, "leu clientes sem precisar");
  const doc = db.docs.get(ref);
  assert.strictEqual(doc.stage, "proposta");
  assert.strictEqual(doc.crm.length, 1);
  assert.strictEqual(db.docs.get("hub_clientes/1002").pipe, "inativo");
  // Troca de vendedor feita pela gestão não é desfeita quando o Qlik muda
  db.docs.set(ref, { ...db.docs.get(ref), vend: "outro", vendManual: true });
  m.clientes[0].vendId = "nicole-azevedo";
  await syncClientes(db, m.clientes, { log });
  assert.strictEqual(db.docs.get(ref).vend, "outro");
  // Cliente que saiu do organograma: some se ninguém trabalhou, fica se já tem CRM
  c = await syncClientes(db, [], { log });
  assert.ok(db.docs.has("hub_clientes/1001"));
  assert.ok(!db.docs.has("hub_clientes/1002"));
  assert.strictEqual(c.removidos, 1);
  assert.strictEqual(c.mantidosFora, 1);
  console.log("Testes OK: regra da carteira, vendedor interno (VE), economia de leituras e preservação do que o vendedor preencheu.");
})().catch(e => { console.error(e); process.exit(1); });
