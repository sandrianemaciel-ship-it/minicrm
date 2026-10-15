"use strict";
// Testes das contas de metas, potencial x deficitário, mix sugerido e itens sugeridos.
const assert = require("assert");
const A = require("./analise");
const { mapaDePessoas } = require("./hub");

assert.strictEqual(A.diasUteisRestantes(new Date(2026, 9, 14)), 13, "14/10/2026 (quarta) até 31/10: 13 dias úteis");
assert.strictEqual(A.diasUteisRestantes(new Date(2026, 9, 31)), 0, "sábado, último dia");
const ap = mapaDePessoas([{ id: "stefany", nome: "Stefany da Rosa Brandão Saldanha" }]);
const { porPessoa, sem } = A.metasPorPessoa([
  { time: "Líder de Vendas Sandriane", rep: "STEFANY DA ROSA BRANDAO SALDANHA", meta: 650000, vendido: 153361.56, vendOrtho: 20000, pedidos: 10 },
  { time: "Outro", rep: "FULANO", meta: 1000, vendido: 0, vendOrtho: 0, pedidos: 0 }], ap);
assert.ok(porPessoa.stefany); assert.deepStrictEqual(sem, ["FULANO"]);
const c = A.calcMeta(porPessoa.stefany, 13);
assert.strictEqual(c.falta, 496638.44); assert.strictEqual(c.porDia, 38202.96);
assert.strictEqual(c.metaOrtho, 65000); assert.strictEqual(c.faltaOrtho, 45000); assert.strictEqual(c.porDiaOrtho, 3461.54);
assert.strictEqual(A.calcMeta({ meta: 100, vendido: 150, vendOrtho: 50 }, 5).porDia, 0, "meta batida: nada por dia");
assert.strictEqual(A.classificaYoy(100, 0), "Não comprou"); assert.strictEqual(A.classificaYoy(100, 150), "Potencial"); assert.strictEqual(A.classificaYoy(100, 60), "Deficitário");

const mix = A.mixSugerido([
  { item: "A", v25: 1000, v26: 200, q25: 10, q26: 2, pu: 100, qu: 2 },
  { item: "B", v25: 500, v26: 0, q25: 5, q26: 0, pu: 95, qu: 5 },
  { item: "C", v25: 100, v26: 300, q25: 1, q26: 3, pu: 100, qu: 1 }]);
assert.deepStrictEqual(mix.map(m => m.item), ["A", "B"]); assert.strictEqual(mix[1].st, "Não comprou"); assert.strictEqual(mix[0].qSug, 3);

// 8 clientes compram X e Y; o cliente "z" compra só X -> sugerir Y.
const itens = [];
for(let i = 1; i <= 8; i++){ itens.push({ cod: "c" + i, item: "X", qt: 1, pu: 10 }, { cod: "c" + i, item: "Y", qt: 1, pu: 20 + i }); }
itens.push({ cod: "z", item: "X", qt: 1, pu: 10 });
const cr = A.montarCruzadas(itens, () => "FARMA")("z");
assert.strictEqual(cr[0].item, "Y"); assert.strictEqual(cr[0].base, "X"); assert.ok(cr[0].conf >= 0.8); assert.strictEqual(cr[0].pu, 24.5);
assert.strictEqual(A.codNorm("0001073887"), "1073887");
console.log("Testes OK: metas (falta ÷ dias úteis, Ortho 10%), potencial x deficitário, mix sugerido e itens sugeridos.");
