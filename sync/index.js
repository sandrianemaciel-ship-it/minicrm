"use strict";
// Robô de sincronização Qlik Sense -> Firestore do Hub Comercial Dellamed.
//   node sync/index.js              lê o Qlik e grava no Firestore (o GitHub Actions roda assim, de hora em hora)
//   node sync/index.js --dry-run    só lê e mostra o que faria, sem gravar nada
//   node sync/index.js --reconhecer lista as pastas, objetos e campos do app do Qlik (para achar o Object ID)
process.env.TZ = process.env.TZ || "America/Sao_Paulo";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { fetchTable, fetchPedidos, discoverApp, discoverTestes, discoverTestes2, discoverTestes3 } = require("./qlik");
const { mapaDePessoas, mapClientes, syncClientes, syncPessoas, isoLocal, hoje } = require("./hub");
const R = require("./risco");
const A = require("./analise");
const P = require("./pacotes");
const ORGANOGRAMA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "organograma.json"), "utf8")).pessoas;

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const RECONHECER = args.has("--reconhecer");
const log = (...a) => console.log(new Date().toLocaleString("pt-BR"), "-", ...a);

function config(){
  const e = {};
  Object.entries(process.env).forEach(([k, v]) => { e[k] = typeof v === "string" ? v.trim() : v; });
  const need = k => { if(!e[k]) throw new Error(`Faltou ${k}. No GitHub: Settings › Secrets and variables › Actions. Na sua máquina: arquivo .env.`); return e[k]; };
  const host = need("QLIK_HOST").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const authMode = (e.QLIK_AUTH || "jwt").toLowerCase();
  const qlik = {
    host, appId: need("QLIK_APP_ID"),
    objectId: e.QLIK_OBJECT_ID || null,
    fields: e.QLIK_FIELDS ? e.QLIK_FIELDS.split("|").map(s => s.trim()).filter(Boolean) : null,
    authMode,
    virtualProxy: e.QLIK_VIRTUAL_PROXY || "",
    // A chave de API do Qlik (Qlik Cloud) ou o token JWT (Qlik Sense Enterprise) vai no cabeçalho Authorization: Bearer.
    jwt: authMode === "jwt" ? (e.QLIK_API_KEY || need("QLIK_JWT")) : null,
    certRoot: e.QLIK_CERT_ROOT, certClient: e.QLIK_CERT_CLIENT, certKey: e.QLIK_CERT_KEY,
    enginePort: Number(e.QLIK_ENGINE_PORT || 4747),
    userDirectory: e.QLIK_USER_DIRECTORY || "INTERNAL", userId: e.QLIK_USER_ID || "sa_api",
    rejectUnauthorized: e.QLIK_REJECT_UNAUTHORIZED !== "false",
    identity: "hub-comercial-sync"
  };
  if(!qlik.objectId && !qlik.fields && !RECONHECER) throw new Error("Defina QLIK_OBJECT_ID (ID da tabela de clientes) ou QLIK_FIELDS.");
  const mapFile = path.resolve(e.COLUMN_MAP_FILE || "config/column-map.json");
  const columnMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
  return { qlik, columnMap, pedidosAppId: e.QLIK_PEDIDOS_APP_ID || null, serviceAccount: e.FIREBASE_SERVICE_ACCOUNT || "config/firebase-service-account.json" };
}

let CRED = null;
function firestore(cfg){
  // No GitHub Actions a chave vem inteira no segredo FIREBASE_SERVICE_ACCOUNT_JSON;
  // na sua máquina, do arquivo apontado em FIREBASE_SERVICE_ACCOUNT.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || fs.readFileSync(path.resolve(cfg.serviceAccount), "utf8");
  CRED = admin.credential.cert(JSON.parse(raw));
  admin.initializeApp({ credential: CRED });
  return admin.firestore();
}
// Pipeline de Retenção: outro projeto Firebase. O robô do Hub só LÊ de lá (papel "Cloud Datastore Viewer"
// dado à conta de serviço do Hub no projeto da Pipeline). Nada é gravado na Pipeline.
async function lerPipelineSeLiberada(){
  const projeto = (process.env.PIPELINE_PROJECT || "pipeline-dellamed").trim();
  const meses = (process.env.PIPELINE_MESES || "2026-09,2026-10").split(",").map(x => x.trim()).filter(Boolean);
  if(!CRED || !meses.length || projeto === "nenhum") return null;
  try{
    const app = admin.initializeApp({ credential: CRED, projectId: projeto }, "pipeline");
    const fpipe = admin.firestore(app);
    const dados = await R.lerPipeline(fpipe, meses, log);
    log(`Pipeline de Retenção lida (somente leitura): ${Object.entries(dados).map(([mk, m]) => `${R.mkLabel(mk)} ${m.leads.length} clientes${m.fechado ? " · fechado" : ""}`).join(" · ") || "nenhum mês"}.`);
    return { fpipe, dados };
  }catch(e){
    const semPermissao = /PERMISSION_DENIED|permission|7 /i.test(e.message || "");
    log(semPermissao ? "Pipeline de Retenção: leitura ainda não liberada para o robô do Hub (falta o papel Cloud Datastore Viewer no projeto da Pipeline). Seguindo sem ela. Detalhe: " + e.message : "Pipeline de Retenção não lida: " + e.message);
    return null;
  }
}

async function lerPedidos(cfg){
  if(!cfg.pedidosAppId) return null;
  const hj = hoje();
  const iniMes = new Date(hj.getFullYear(), hj.getMonth(), 1);
  const iniAnt = new Date(hj.getFullYear(), hj.getMonth() - 1, 1);
  const fimAnt = new Date(hj.getFullYear(), hj.getMonth(), 0);
  const q = { ...cfg.qlik, appId: cfg.pedidosAppId, objectId: null };
  const soma = lista => { const m = new Map(); lista.forEach(p => m.set(p.cod, (m.get(p.cod) || 0) + p.valor)); return m; };
  const agrupa = lista => { const m = new Map(); lista.forEach(p => { if(!m.has(p.cod)) m.set(p.cod, []); m.get(p.cod).push(p); }); return m; };
  const listaMes = await fetchPedidos(q, isoLocal(iniMes), isoLocal(hj), log);
  const mes = soma(listaMes);
  const ant = soma(await fetchPedidos(q, isoLocal(iniAnt), isoLocal(fimAnt), log));
  // Ticket médio: valor dos pedidos dos 3 meses fechados ÷ 3 ("Valor Total de Pedidos (- Canc)": cancelamentos já descontados).
  const iniTri = new Date(hj.getFullYear(), hj.getMonth() - 3, 1);
  const tri = soma(await fetchPedidos(q, isoLocal(iniTri), isoLocal(fimAnt), log));
  return { mes, ant, tri, mesLista: agrupa(listaMes) };
}

async function main(){
  const cfg = config();
  if(RECONHECER){ await discoverTestes3(cfg.qlik, log); return; }
  log(DRY ? "Simulação: nada será gravado." : "Sincronização iniciada.");
  const db = DRY && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !fs.existsSync(path.resolve(cfg.serviceAccount)) ? null : firestore(cfg);
  try{
    const tabela = await fetchTable(cfg.qlik, log);
    // Organograma = arquivo config/organograma.json + quem a gestão cadastrou ou ajustou pela página.
    // O arquivo do organograma completa o que estiver no banco (apelidos e "campo"), sem desfazer o que a gestão ajustou na página.
    const porId = new Map(ORGANOGRAMA.map(p => [p.id, p]));
    const pessoasHub = (db ? (await db.collection("hub_pessoas").get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.origem !== "qlik") : [])
      .map(p => { const o = porId.get(p.id); return o ? { ...p, campo: p.campo || o.campo, alias: [...new Set([].concat(p.alias || [], o.alias || []))] } : p; });
    const ids = new Set(pessoasHub.map(p => p.id));
    const equipe = pessoasHub.concat(ORGANOGRAMA.filter(p => !ids.has(p.id)));
    const apelidos = mapaDePessoas(equipe);
    const { clientes, porPessoa, unmapped, ignorados, foraDoOrganograma, foraNomes } = mapClientes(tabela, cfg.columnMap, apelidos);
    log(`Organograma: ${equipe.length} pessoas · ${clientes.length} clientes nas carteiras delas · ${foraDoOrganograma} clientes de fora ficaram fora do Hub.`);
    log("Clientes por pessoa: " + equipe.map(p => `${p.nome} ${porPessoa.get(p.id) || 0}`).join(" · "));
    const semCarteira = equipe.filter(p => p.papel !== "gestor" && p.papel !== "sdr" && !porPessoa.get(p.id));
    if(semCarteira.length) log("Sem nenhum cliente no Qlik (confira se o nome bate com o Qlik e use \"alias\" no organograma): " + semCarteira.map(p => p.nome).join(", "));
    if(foraNomes && foraNomes.size) log("Vendedores internos do Qlik fora do organograma (nome · clientes): " + [...foraNomes].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([n, q]) => `${n} ${q}`).join(" · "));
    if(unmapped.length) log("Colunas do Qlik sem correspondência (ignoradas): " + unmapped.join(" | "));
    if(ignorados) log(`${ignorados} linhas sem Cód Cliente foram ignoradas.`);
    if(!clientes.length) throw new Error("Nenhum cliente das pessoas do organograma. Confira o QLIK_OBJECT_ID, as colunas Vendedor Interno / Representante e os nomes em config/organograma.json.");
    log("Exemplo de cliente lido: " + JSON.stringify(clientes[0]));
    let pedidos = null;
    try{ pedidos = await lerPedidos(cfg); }catch(e){ log("Pedidos do Qlik não lidos (os filtros usarão a data do último faturamento): " + e.message); }
    if(!db){ log(`Simulação sem Firebase: ${clientes.length} clientes seriam enviados.`); return; }
    await syncPessoas(db, ORGANOGRAMA, { dry: DRY, log });
    const mk = isoLocal(hoje()).slice(0, 7);
    const pipe = await lerPipelineSeLiberada();
    // 1) Fecha o mês anterior (clientes que inativavam nele), antes de recalcular a carteira.
    try{ await R.fecharMes(db, R.mesAnterior(mk), { dry: DRY, log, pedidosAnt: pedidos && pedidos.ant }); }catch(e){ log("Fechamento do mês anterior não concluído: " + e.message); }
    // 2) Base fixa do mês (dia 1). No mês em que a Pipeline de Retenção ainda é usada, inclui os clientes que ela tem no mês.
    const extra = pipe && pipe.dados[mk] ? new Set(pipe.dados[mk].leads.map(l => String(l.cod || "").trim())) : null;
    const { set: base } = await R.garantirBase(db, mk, clientes, { dry: DRY, log, extraCods: extra, fonteExtra: "pipeline" });
    const cont = await syncClientes(db, clientes, { dry: DRY, log, pedidos, base, mk });
    // 3) Copia para o Hub o que a equipe preencheu na Pipeline de Retenção.
    if(pipe){ try{ await R.importarPipeline(db, pipe.fpipe, pipe.dados, { dry: DRY, log, mkAtual: mk, clientes }); }catch(e){ log("Cópia da Pipeline de Retenção não concluída: " + e.message); } }
    // 4) Metas do mês por pessoa (toda execução) e análise por cliente: potencial/deficitário e mix (uma vez por dia).
    try{ await A.gravarMetas(db, cfg.qlik, apelidos, { dry: DRY, log }); }catch(e){ log("Metas do Qlik não lidas: " + e.message); }
    let an = null;
    try{ an = await A.analisarClientes(db, cfg.qlik, clientes, { dry: DRY, log, forcar: args.has("--analisar") }); }catch(e){ log("Análise de clientes não concluída: " + e.message); }
    // 5) Pacotes da carteira para a página (uma vez por dia, junto com a análise).
    try{ await P.montarPacotes(db, { dry: DRY, log, analises: an && an.porId, forcar: args.has("--pacotes") }); }catch(e){ log("Pacotes da carteira não montados: " + e.message); }
    if(!DRY) await db.doc("hub_sync/status").set({ ultimaSync: new Date().toISOString(), clientes: clientes.length, novos: cont.novos, atualizados: cont.atualizados, erro: null, mes: isoLocal(hoje()).slice(0, 7) }, { merge: true });
    log("Sincronização concluída.");
  }catch(err){
    log("ERRO: " + err.message);
    if(db && !DRY) await db.doc("hub_sync/status").set({ erro: err.message, erroEm: new Date().toISOString() }, { merge: true });
    process.exitCode = 1;
  }
}
main();
