# Runbook de Operação — SAC Bel Lube / QFront

Como **operar, monitorar e resolver incidentes** das pontes em produção. Público-alvo: TI / plantão de suporte.

> Convenções: `<APP_SERVER>` = servidor Linux onde a ponte roda; `<USER>` = usuário do serviço. Os valores reais estão no cofre interno da TI (não neste repositório público).

---

## 1. Onde roda

- **Ponte de e-mail** (`sac@`): serviço systemd na `<APP_SERVER>`, rodando `node email-bridge.js` no diretório do usuário, com log em `bridge.log`. Unit de exemplo: `integration/email-bridge/sac-email-bridge.service`.
- Pode rodar como serviço **de sistema** (`/etc/systemd/system`) ou **`--user`** (quando `sudo` não está disponível — usar `loginctl enable-linger <USER>` para persistir após logout).
- **Recebimento nativo** do `sac@` é 100% via Microsoft Graph (polling). Não depende de relay externo.

---

## 2. Comandos do dia a dia

```bash
# status
systemctl status sac-email-bridge          # (ou: systemctl --user status sac-email-bridge)

# logs ao vivo
tail -f ~/email-bridge/bridge.log
journalctl -u sac-email-bridge -f           # se for serviço de sistema

# reiniciar após deploy/alteração
systemctl restart sac-email-bridge          # (ou --user)

# parar / iniciar
systemctl stop sac-email-bridge
systemctl start sac-email-bridge
```

Sinais saudáveis no log: `Graph token OK`, linhas `IN`, `ROTA <conv> <protocolo> team <n>`, `ACK`, e (se outbound ligado) `OUT sac@-> <email>`.

---

## 3. Deploy de uma alteração

1. Editar/validar localmente: `node --check email-bridge.js`.
2. Copiar o arquivo para o servidor (scp/pscp) sobrescrevendo `~/email-bridge/email-bridge.js`.
3. No servidor: `node --check email-bridge.js` (garante sintaxe) e `systemctl restart sac-email-bridge`.
4. Conferir o log: `tail -n 20 ~/email-bridge/bridge.log` — deve reaparecer `Email-bridge on…` + `Graph token OK`.
5. Teste ponta-a-ponta (ver §6).

> Nunca versionar/enviar o `.env` nem `email-state.json`. Eles vivem só no servidor.

---

## 4. Monitoramento

- **Vivo?** `systemctl is-active sac-email-bridge` → `active`.
- **Processando?** o `lastReceived` em `email-state.json` avança com o tempo; novas conversas aparecem no QFront.
- **Erros** no log: linhas `WARN …` (não fatais, seguem) e `ERRO …` (falha no ciclo; o loop continua no próximo `POLL_MS`).
- **Token Graph**: se aparecer 401/`invalid_client`, o `MS_CLIENT_SECRET` expirou → gerar novo secret no Entra e atualizar o `.env`.

---

## 5. Incidentes conhecidos e correção

### 5.1 "Tickets somem / caem no robô (bellubeadm)"
**Causa:** a conta de sistema `bellubeadm` estava como membro de times/caixas e *online* → o rodízio (auto-assignment) atribuía tudo a ela. **Correção:**
- Remover `bellubeadm` de **todos os times** e **todas as caixas**; deixá-la **offline**.
- Garantir `enable_auto_assignment=false` nas caixas e `allow_auto_assign=false` nos times.
- Liberar os presos: `POST /conversations/filter` (assignee_id=2) e desatribuir com `POST /conversations/{id}/assignments` body `{"assignee_id":0}`.
- Admin acessa tudo via API **sem** ser membro — remover não quebra a ponte.

### 5.2 "Rodízio alternando entre agentes do time"
Desligar `allow_auto_assign` no time (`PATCH /teams/{id}` body `{"name":"<nome>","allow_auto_assign":false}`). A distribuição por **área** (feita pela ponte) continua; só o sorteio de agente para.

### 5.3 "Resposta do agente não chega ao cliente"
- `OUTBOUND_ENABLED` está `true`? O e-mail do cliente está na `OUTBOUND_WHITELIST` (ou `*`)?
- Uma sessão órfã (conversa apagada) com 404 já não derruba o envio (tratado). Se persistir, ver `WARN out` no log.

### 5.4 "E-mail entrou como chat, sem cabeçalho de e-mail"
A mensagem foi postada sem `content_type: incoming_email`. Verificar `buildEmailEnvelope`/`qfPostMessage` (não deve ter regressão).

### 5.5 "Duplicou tickets"
Provável `email-state.json` apagado/corrompido → a marca d'água (`lastReceived`) e o `seen` se perderam. Restaurar backup do estado ou aceitar o reprocessamento pontual.

---

## 6. Teste ponta-a-ponta (validação rápida)

1. Enviar um e-mail para `sac@bellube.com.br` com uma palavra-chave de área no assunto/corpo (ex.: "atestado"/"ausência" → RH; "boleto vencido" → Financeiro) e um marcador único.
2. Aguardar ~1 ciclo (`POLL_MS`).
3. No QFront: a conversa deve aparecer na caixa do `sac@`, **atribuída ao time da área**, **sem agente** (fila), com **etiqueta** do motivo, **protocolo** `SAC-00XXXX` no atributo e **campos** (CNPJ/NF/Pedido/Cód Parceiro) preenchidos se estavam no texto.
4. O remetente recebe a **confirmação automática** com o protocolo (se `AUTO_ACK=true`).
5. (Outbound) Responder pela conversa como agente → o cliente recebe um e-mail da `sac@` com assinatura "Atendente responsável: Nome — Setor" e `[SAC-00XXXX]` no assunto.

---

## 7. Rotação de segredos (fazer periodicamente e após qualquer exposição)

- `MS_CLIENT_SECRET` — regenerar no Entra (App Registration → Certificates & secrets) e atualizar o `.env`.
- Tokens QFront (`access-token`/`client`) — um novo login do usuário admin rotaciona; atualizar o `.env`.
- Senha da caixa `sac@` — trocar no M365 (não é usada pela ponte, mas higiene).
- Após rotacionar: `systemctl restart sac-email-bridge` e revalidar (§6).

---

## 8. Contatos e dependências

- **Plataforma:** Megleo (suporte QFront) — instância `chat-…megleo.com.br`.
- **E-mail:** Microsoft 365 (tenant Bel Lube) — App Registration no Entra.
- **WhatsApp:** Neppo (ponte secundária).
- **ERP:** Sankhya (consulta read-only; gravação de parecer é Fase 2).
