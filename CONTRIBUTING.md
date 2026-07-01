# Guia de Contribuição / Manutenção

## Pré-requisitos
- Node.js 18+
- Acesso admin ao QFront (para tokens devise) e ao tenant M365 (App Registration)
- Nunca commitar `.env`, `*state*.json`, `*.log`, CSVs ou qualquer dado de cliente

## Rodando localmente
```bash
cd integration/email-bridge
cp .env.example .env    # preencha (ver docs/GUIA_DESENVOLVEDOR.md §3-4)
npm install
node --check email-bridge.js   # valida sintaxe
node email-bridge.js           # loop contínuo
```

## Padrões de código
- JS single-file por ponte, sem framework; `axios` + `dotenv` apenas.
- Toda config vem de `process.env` — **zero segredo hardcoded**.
- Idempotência via arquivo de estado JSON (dedupe por id de mensagem).
- Tratar erro por item (try/catch por conversa/e-mail) para um item ruim não derrubar o ciclo.
- Log com timestamp ISO e prefixo de evento (`IN`, `ROTA`, `ACK`, `OUT`, `WARN`, `ERRO`).

## Fluxo de deploy
Ver `docs/OPERACOES_RUNBOOK.md §3`. Resumo: `node --check` → copiar p/ servidor → `node --check` no servidor → `systemctl restart` → conferir log → teste ponta-a-ponta.

## Antes de abrir PR / commitar
1. `node --check` em todos os arquivos alterados.
2. Rodar um teste ponta-a-ponta (runbook §6).
3. Conferir que nenhum segredo/PII entrou no diff:
   ```bash
   git diff --cached | grep -iE 'secret|token|senha|password|@bellube\.com\.br|[0-9]{2}\.[0-9]{3}\.[0-9]{3}/[0-9]{4}'
   ```
   (o único `@bellube.com.br` aceitável é `sac@bellube.com.br`, que é público)

## Segurança
- Repositório **público**: assuma que tudo aqui é visível ao mundo.
- Rotacionar segredos periodicamente (runbook §7).
- Dados de clientes (conversas, contatos, prints) **nunca** entram no Git — ficam no ambiente interno.
