# Guia do Desenvolvedor — SAC Bel Lube / QFront

Documento técnico para quem vai **manter, alterar ou dar suporte** às integrações do SAC. Assume Node.js 18+, familiaridade com REST e acesso administrativo ao QFront e ao tenant Microsoft 365.

---

## 1. Visão geral

O núcleo é a **ponte de e-mail** (`integration/email-bridge/email-bridge.js`): um processo Node que faz *polling* na caixa `sac@bellube.com.br` via **Microsoft Graph** e espelha cada e-mail como uma **conversa no QFront**, roteando por área, gerando protocolo, extraindo campos e (opcionalmente) devolvendo as respostas dos agentes ao cliente como e-mail enviado pela própria `sac@`.

Existem duas pontes secundárias:
- `integration/neppo-bridge/` — espelha WhatsApp (Neppo) → QFront (Fase 1: inbound).
- `integration/sac-import/` — importação pontual de histórico.

Todas seguem o mesmo padrão: config por `.env`, `axios` para as APIs, arquivo de estado JSON local para deduplicação/idempotência.

---

## 2. Fluxo da ponte de e-mail

```
loop() a cada POLL_MS:
  pollInbound()
    └─ Graph GET Inbox (25 mais recentes, desc) → ordena asc
       para cada e-mail novo (receivedDateTime > lastReceived, dedupe por st.seen):
         toQFront():
           ├─ tem "SAC-00XXXX" no assunto e a conversa existe?  →  THREADING: anexa na mesma conversa,
           │     reabre se resolvida, enriquece campos personalizados
           └─ senão  →  NOVA conversa:
                 cria contato + conversa (content_type incoming_email)
                 classifica motivo (etiquetas) → define time → atribui time
                 gera protocolo SAC-00{id} → grava em custom_attributes
                 extrai CNPJ/NF/Pedido/Cód Parceiro → grava campos
                 aplica etiquetas
                 envia auto-resposta (auto-ack) com o protocolo
  pollOutbound()  (se OUTBOUND_ENABLED)
    └─ para cada sessão conhecida: lê mensagens outgoing dos agentes ainda não enviadas
       → envia como e-mail pela sac@ (assinatura com nome do atendente + setor + protocolo)
       → respeita OUTBOUND_WHITELIST
```

**Ponto-chave de design:** o roteamento e o protocolo são feitos **na hora, pela ponte** (não pelas automações assíncronas do QFront), porque o build do QFront não filtra automação por etiqueta/atributo de forma confiável (ver §8). Isso torna o comportamento determinístico.

---

## 3. Autenticação

### 3.1 Microsoft Graph (app-only)
Fluxo `client_credentials` (sem usuário). Requer um **App Registration** no Entra ID com **Application permissions**: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send` + **admin consent**. Preencha `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`. O token é cacheado e renovado 60s antes de expirar (`graphToken()`).

> Por que Graph e não IMAP/SMTP? O M365 **bloqueia basic-auth** (IMAP/SMTP com senha) — a senha de app da `sac@` não autentica. Graph usa OAuth2 moderno e não é bloqueado.

### 3.2 QFront / Chatwoot (devise-token-auth)
As chamadas usam 3 headers: `access-token`, `client`, `uid` (+ `token-type: Bearer`). Base: `/api/v1/accounts/<account_id>`.

**Como obter os tokens** (não há "gerar token" na UI para todos os casos): logue como um usuário **administrador** no painel do QFront e, no console do navegador, leia o cookie `cw_d_session_info` — ele contém `access-token`, `client` e `uid`. Esse mesmo trio autentica a API REST e é o que o SPA usa internamente.

> ⚠️ Os tokens dão poder de admin sobre a conta. Trate como segredo. Se vazarem, um novo login do usuário rotaciona o `access-token`.

---

## 4. Variáveis de ambiente (`email-bridge/.env`)

| Variável | Descrição |
|----------|-----------|
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | App Registration (Graph app-only) |
| `MS_MAILBOX` | Caixa monitorada (`sac@bellube.com.br`) |
| `GRAPH_FOLDERS` | Pastas para o modo `import` (ex.: `Inbox,Archive,SentItems`) |
| `QFRONT_BASE` | `https://<instancia>/api/v1/accounts/<id>` |
| `QFRONT_ACCESS_TOKEN` / `QFRONT_CLIENT` / `QFRONT_UID` | Tokens devise (cookie `cw_d_session_info`) |
| `QFRONT_INBOX_ID` | Caixa (inbox) do canal `sac@` — inbound + outbound |
| `QFRONT_HIST_INBOX_ID` | Caixa de histórico importado (modo `import`) |
| `TRIAGE_TEAM_ID` | Time default quando não há motivo claro (1 = Triagem/Gestão) |
| `AUTO_ACK` | `true` = envia confirmação automática com protocolo |
| `POLL_MS` | Intervalo de polling (padrão 20000) |
| `OUTBOUND_ENABLED` | `true` = habilita envio das respostas dos agentes ao cliente |
| `OUTBOUND_WHITELIST` | e-mails liberados p/ envio; vazio = nenhum; `*` = todos |

> Comece com `OUTBOUND_ENABLED=false` e, ao ligar, use uma `OUTBOUND_WHITELIST` restrita (só seu e-mail) para validar antes de liberar `*`.

---

## 5. Walkthrough do código (`email-bridge.js`)

| Função | Responsabilidade |
|--------|------------------|
| `graphToken()` / `graph()` | OAuth2 app-only + wrapper de chamadas ao Graph |
| `qf()` | wrapper das chamadas REST ao QFront (headers devise) |
| `ensureContact()` | acha (por e-mail) ou cria o contato no QFront |
| `classifyLabels()` | classifica **motivo** por palavra-chave do assunto+corpo → lista de etiquetas + etiqueta de origem (`aberto-cliente`/`aberto-colaborador`) |
| `teamForLabels()` / `TEAM_BY_LABEL` | mapeia a 1ª etiqueta com destino → **time** (área). Sem motivo → `TRIAGE_TEAM_ID` |
| `maybeAck()` | auto-resposta com protocolo. Guardas anti-loop: nunca para `no-reply`/`sac@`; rate-limit 1×/4h por endereço |
| `graphAttachments()` | baixa anexos reais (ignora ícones inline < 5KB e arquivos > 25MB) |
| `buildEmailEnvelope()` | monta `content_attributes.email` p/ o QFront **renderizar como e-mail** (não como chat) |
| `qfPostMessage()` | posta a mensagem como `incoming_email`; multipart quando há anexos |
| `extractFields()` | regex de **CNPJ, NF, Pedido/NUNOTA, Cód Parceiro** no texto |
| `applyExtractedFields()` | preenche só os campos personalizados **vazios** (não sobrescreve o que o agente digitou) |
| `subjectWithProtocolo()` | monta o assunto com `[SAC-00XXXX]` **no início**, sem duplicar `Re:`/prefixos |
| `findExistingConv()` | acha a conversa pelo `SAC-00XXXX` do assunto → **threading** (mantém histórico) |
| `toQFront()` | orquestra tudo: threading vs nova conversa |
| `pollInbound()` / `pollOutbound()` | os dois lados do loop |

### Estado (`email-state.json`, **não versionado**)
```jsonc
{
  "lastReceived": "2026-…Z",     // marca d'água do último e-mail processado
  "seen":     { "<graphMsgId>": <convId> },   // dedupe de e-mails já importados
  "sessions": { "c<convId>": { email, subject, graphId, protocolo, team } },
  "sentOut":  { "<qfMsgId>": true },           // idempotência do outbound
  "ackedAddr":{ "<email>": <timestampMs> }     // rate-limit do auto-ack
}
```
> Apagar o `email-state.json` faz a ponte reprocessar (pode duplicar). Não delete em produção sem entender o efeito.

---

## 6. Roteamento por área (o que cai em cada time)

A classificação é por palavra-chave (`classifyLabels`) e o destino por `TEAM_BY_LABEL`. Resumo (ver a tabela completa em `CONFIGURACAO_QFRONT.md`):

| Palavras-chave (exemplo) | Etiqueta | Time |
|--------------------------|----------|------|
| boleto + vencido/atualizar | `fin-atualizacao-boleto` | Financeiro (2) |
| nota fiscal / danfe / xml | `fin-nota-fiscal` | Faturamento (3) |
| cadastro / alterar dados | `fin-cadastro` | Cadastro (5) |
| avaria / devolução / granel / cancelar NF | `log-*` | Logística (4) |
| brinde / patrocínio | `mkt-*` | Marketing (6) |
| férias / folga / atestado / ausência | `rh-*` | RH (7) |
| cotação / desconto | `comercial-cotacao` / `os-desconto` | Comercial (8) |
| (nada reconhecido) | — | Triagem/Gestão (1) |

Para adicionar um roteamento: acrescente a regra em `classifyLabels()` **e** o mapeamento em `TEAM_BY_LABEL`. Garanta que a etiqueta exista no QFront (senão o POST de labels falha silenciosamente e só o time é aplicado).

---

## 7. Modelo de atribuição (importante para suporte)

O SAC opera em **fila de time, sem rodízio entre agentes**:
- A ponte atribui a conversa ao **time** correto (distribuição automática por área).
- **NÃO** há atribuição automática a um agente específico. O ticket fica na fila do time e qualquer agente (online **ou offline**) assume.
- Isso é garantido por **duas** configurações no QFront, ambas **desligadas**:
  - `enable_auto_assignment = false` em todas as **caixas** (evita rodízio na entrada);
  - `allow_auto_assign = false` em todos os **times** (evita alternar entre os agentes do time).
- A conta de sistema/bridge (`bellubeadm`) **não** deve ser membro de time/caixa nem aparecer *online*, senão entra no rodízio (ver runbook, incidente "tickets sumindo no robô").

---

## 8. Gotchas / lições aprendidas

1. **IMAP/SMTP basic-auth bloqueado no M365** → usar **Graph app-only**. Não perca tempo com senha de app.
2. **Graph rejeita `$filter` + `$orderby`** no mesmo campo de data → busca-se os 25 mais recentes por `receivedDateTime desc` e filtra-se por data + `st.seen` no código.
3. **`conversation display_id` vs `id`**: as rotas REST de conversa do Chatwoot usam o **display_id** (o número que aparece na URL e vira o protocolo `SAC-00XXXX`).
4. **Filtro de "atribuído a X" via API**: `GET /conversations?assignee_type=me` para conta admin devolve conversas demais (inclui não-atribuídas). Para achar as de um agente use o **filtro**: `POST /conversations/filter` com `{"payload":[{"attribute_key":"assignee_id","filter_operator":"equal_to","values":[<id>]}]}`.
5. **Desatribuir (voltar à fila do time)**: `POST /conversations/{id}/assignments` com body **literal** `{"assignee_id":0}` (`find_by(id:0)=nil` → desatribui). Cuidado: montar esse body em PowerShell com `$null` **remove a chave** (vira no-op) — mande a string crua.
6. **Renderizar como e-mail (não chat)**: a mensagem precisa de `content_type: 'incoming_email'` + `content_attributes.email` (ver `buildEmailEnvelope`), senão o QFront mostra como mensagem de chat sem cabeçalho.
7. **Automação por etiqueta/atributo não é confiável** neste build (aceita o POST mas não filtra; a última regra vence). Por isso o roteamento é feito na ponte, não em automação.
8. **Outbound morria em conversa inexistente**: um `GET /conversations/{id}` que dá 404 (sessão órfã) precisa de `try/catch` por sessão, senão aborta todo o envio. Já tratado (linha ~279).

---

## 9. Como rodar localmente

```bash
cd integration/email-bridge
cp .env.example .env       # preencha os valores
npm install
node email-bridge.js       # loop contínuo (Ctrl+C para sair)
node email-bridge.js import  # importa histórico (GRAPH_FOLDERS) p/ a caixa de histórico
```
Logs vão para stdout com timestamp ISO. Em produção, ver `OPERACOES_RUNBOOK.md`.

---

## 10. Licença / uso

Código de uso interno da **Bel Lube / Bel Distribuidor de Lubrificantes**. Publicado para fins de continuidade e portabilidade do conhecimento. Não contém segredos nem dados de clientes. Reuso externo por conta e risco do interessado.
