# Hub Comercial Dellamed

Carteira de clientes (ativos, inativos e inativariam no mês), Prospecção, Distribuição de leads, Gestão de contatos e Dashboard, alimentados pelo Qlik Sense.

```
Qlik Sense ──(chave de API)──> robô sync/ (GitHub Actions, de hora em hora) ──> Firebase Firestore (hub_*) <──> página index.html (GitHub Pages)
```

- **Página:** `index.html`, publicada pelo GitHub Pages. Não guarda nenhuma chave do Qlik.
- **Banco:** Firestore de um projeto Firebase só do Hub (separado da Pipeline de Retenção), em coleções que começam com `hub_`.
- **Robô:** pasta `sync/`, executado pelo workflow `.github/workflows/sincronizar-qlik.yml`. A chave do Qlik fica nos segredos do repositório.

## Pastas e arquivos

| Caminho | Para que serve |
| --- | --- |
| `index.html` | A ferramenta inteira (página única). |
| `sync/index.js` | Robô: lê o Qlik, grava no Firestore, registra o status. |
| `sync/hub.js` | Regras da carteira e gravação sem apagar o que o vendedor preencheu. |
| `sync/qlik.js` | Conexão com o Qlik (mesma da Pipeline de Retenção). |
| `sync/logic.js` | TEAM_MAP, leitura de colunas e datas (mesmo da Pipeline de Retenção). |
| `sync/teste.js` | Teste sem Qlik e sem Firebase (`npm test`). |
| `config/organograma.json` | Pessoas, times e acessos. O robô só traz clientes dessas pessoas. |
| `config/column-map.example.json` | Modelo para quando um nome de coluna do Qlik for diferente. |
| `firestore.rules` | Regras do Firestore do projeto do Hub (colar inteiro). |
| `config/firebase-web.json` | Configuração do app web do Firebase (pública). Preencher no passo 2. |
| `.github/workflows/sincronizar-qlik.yml` | Agenda do robô e botão "Run workflow". |
| `.env.example` | Modelo de configuração para rodar o robô na sua máquina. |

## Segredos e variáveis (Settings › Secrets and variables › Actions)

| Nome | Tipo | Valor |
| --- | --- | --- |
| `QLIK_HOST` | Secret | Endereço do Qlik, sem `https://` |
| `QLIK_APP_ID` | Secret | ID do app com a base de clientes |
| `QLIK_OBJECT_ID` | Secret | ID da tabela com todos os clientes |
| `QLIK_API_KEY` | Secret | Chave de API (Qlik Cloud) ou token JWT (Enterprise) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret | Conteúdo inteiro do arquivo JSON da conta de serviço |
| `QLIK_VIRTUAL_PROXY` | Variable | Só Enterprise com JWT: prefixo do virtual proxy |
| `QLIK_PEDIDOS_APP_ID` | Variable | Opcional: app com a pasta Pedidos |
| `RUNNER` | Variable | `self-hosted` se o Qlik só abrir na rede da empresa |

## Colunas da tabela de clientes no Qlik

Obrigatórias: **Cód Cliente**, **Razão Social**, **Data Último Faturamento**, **Data Inativação**, **Vendedor Interno (VE)** ou **Representante (Z1)**.
Recomendadas: CNPJ, UF, Cidade, Segmento, Telefone, Email, Inadimplente, Valor Vencido, Data Cadastro, Status Atual, Key Account (Z3).

## Comandos

- `npm test` — testa as regras sem Qlik e sem Firebase.
- `npm run reconhecer` — lista pastas, objetos e campos do app (ajuda a achar o Object ID).
- `npm run simular` — lê o Qlik e mostra o que gravaria, sem gravar.
- `npm run sync` — sincroniza de verdade.

O passo a passo completo está no documento "Hub Comercial Dellamed: automação com Qlik".
