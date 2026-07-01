# Configuração do QFront — Referência

Mapa da configuração da conta QFront do SAC (account id 2). Use como referência ao dar suporte ou reconstruir o ambiente. IDs podem variar se a conta for recriada.

---

## 1. Times (filas por área)

| ID | Time | Área |
|----|------|------|
| 1 | Triagem / Gestão | default (motivo não reconhecido) |
| 2 | Financeiro | boleto (atualização/reemissão), suspender cobrança |
| 3 | Faturamento | nota fiscal / DANFE / XML |
| 4 | Logística | avaria, devolução, cancelamento NF, granel, EDI |
| 5 | Cadastro | atualização de dados cadastrais |
| 6 | Marketing | brinde, patrocínio/investimento |
| 7 | RH (interno) | atestado/ausência, folga/férias, alteração PREV |
| 8 | Comercial / Vendas | cotação, desconto |

**Todos os times com `allow_auto_assign = false`** (sem rodízio entre agentes — ver runbook §5.2).

---

## 2. Caixas de entrada (inboxes)

| Canal | Tipo | Observação |
|-------|------|------------|
| SAC — E-mail (`sac@`) | Channel::Api | inbound + outbound da ponte de e-mail |
| SAC Bel Lube (WhatsApp) | Channel::Whatsapp | ponte Neppo |
| SAC — Histórico (importado) | Channel::Api | destino do modo `import` |
| SAC Gmail / Canal de Teste / SAC teste | Email / Api | auxiliares |

**Todas as caixas com `enable_auto_assignment = false`** (sem rodízio na entrada). A conta de sistema `bellubeadm` **não** deve ser membro de nenhuma caixa.

---

## 3. Etiquetas (motivos + origem + sub-área)

**Motivos:**
`fin-atualizacao-boleto` · `fin-reemissao-boleto-nf` · `fin-suspender-cobranca` · `fin-nota-fiscal` · `fin-cadastro` · `log-avaria` · `log-cancelamento-nf` · `log-devolucao` · `log-edi-ocorrencia` · `log-manutencao-granel` · `mkt-brinde` · `mkt-investimento` · `rh-folga-ferias` · `rh-consulta-ausencia` · `comercial-cotacao` · `os-desconto`

**Origem:** `aberto-cliente` · `aberto-colaborador` · `aberto-vendedor` · `aberto-diretoria`

**Sub-área:** `area-site` · `area-motoroil` · `area-inflaveis`

> A ponte adiciona automaticamente a etiqueta de origem (`aberto-colaborador` se o remetente é `@bellube.com.br`, senão `aberto-cliente`) + as etiquetas de motivo detectadas.

---

## 4. Campos personalizados (custom attributes)

**Conversa:** `protocolo_sac` · `cnpj` · `nota_fiscal` · `pedido_nunota` · `cod_parceiro` · Empresa/CODEMP · Aberto por · Vendedor/REV · Transportadora · Motivo da devolução

**Contato:** Cód Parceiro · CNPJ · E-mail XML · E-mail boleto · Vendedor · Segmento · Região · Opt-in WhatsApp

> A ponte preenche automaticamente `protocolo_sac`, `cnpj`, `nota_fiscal`, `pedido_nunota`, `cod_parceiro` a partir do texto do e-mail (só preenche campos vazios; não sobrescreve o que o agente digitou). Os demais são preenchidos manualmente pelo agente ou na Fase 2 (integração Sankhya).

---

## 5. Tabela de roteamento (palavra-chave → etiqueta → time)

| Gatilho (assunto+corpo, minúsculas) | Etiqueta | Time |
|-------------------------------------|----------|------|
| `boleto` + (`atualiz`/`vencid`/`vencimento`) | `fin-atualizacao-boleto` | 2 Financeiro |
| `boleto`/`segunda via`/`2 via`/`reemiss` | `fin-reemissao-boleto-nf` | 2 Financeiro |
| `suspender`/`suspensao` + `cobranca` | `fin-suspender-cobranca` | 2 Financeiro |
| `nota fiscal`/`nfe`/`danfe`/`xml da nota` | `fin-nota-fiscal` | 3 Faturamento |
| `cadastro`/`atualizar dados`/`alterar dados` | `fin-cadastro` | 5 Cadastro |
| `avaria`/`danificad`/`quebrad`/`vazou`/`violad` | `log-avaria` | 4 Logística |
| `cancelar`/`cancelamento` + (`nota`/`nf`/`pedido`) | `log-cancelamento-nf` | 4 Logística |
| `devolucao`/`devolver`/`devolvid` | `log-devolucao` | 4 Logística |
| `arquivo edi`/`edi bancario`/`retorno edi` | `log-edi-ocorrencia` | 4 Logística |
| `granel` | `log-manutencao-granel` | 4 Logística |
| `brinde` | `mkt-brinde` | 6 Marketing |
| `patrocinio`/`verba de marketing`/`investimento de marketing` | `mkt-investimento` | 6 Marketing |
| `ferias`/`folga` | `rh-folga-ferias` | 7 RH |
| `atestado`/`ausencia` | `rh-consulta-ausencia` | 7 RH |
| `cotacao`/`orcamento`/`tabela de preco` | `comercial-cotacao` | 8 Comercial |
| `desconto` | `os-desconto` | 8 Comercial |
| (nenhum reconhecido) | — | 1 Triagem |

Ordem de prioridade = ordem em que a etiqueta aparece na lista (`teamForLabels` pega a 1ª com destino). Fonte de verdade: `classifyLabels()` + `TEAM_BY_LABEL` em `email-bridge.js`.

---

## 6. Automação nativa do QFront

Apenas uma automação nativa é usada de forma confiável: **atribuir novas conversas ao time Triagem** (evento `conversation_created`). O roteamento fino por motivo é feito pela **ponte** (o build não filtra automação por etiqueta/atributo — ver Guia do Dev §8), não por automação nativa.

---

## 7. Respostas prontas (canned)

Configuradas no QFront e versionadas em texto em `config/canned_responses.md`. Incluem: saudação, assinatura Bel Lube, script de cadastro/senha do site, rastreio de NF, 2ª via de boleto, encerramento + pesquisa.
