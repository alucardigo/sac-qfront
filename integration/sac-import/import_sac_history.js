/**
 * Importa o HISTÓRICO da caixa sac@bellube.com.br (M365, via IMAP) como conversas no QFront/Chatwoot.
 * Pré-requisito: IMAP habilitado no M365 para a caixa (Set-CASMailbox ... -ImapEnabled $true).
 * REGRA: a senha/app-password NÃO é preenchida pelo Claude — VOCÊ coloca IMAP_PASS no .env e roda.
 *
 * Uso (no homolog):  cd ~/sac-import && nano .env  (preencher IMAP_PASS)  &&  node import_sac_history.js
 * Cada e-mail vira 1 conversa (incoming) na caixa "SAC — Histórico (importado)" (inbox 9), marcada como RESOLVIDA.
 * Deduplica por Message-ID (state em ./imported.json) — pode rodar de novo sem duplicar.
 */
const fs = require('fs');
const axios = require('axios');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
require('dotenv').config();

const E = process.env;
const QF = { base: E.QFRONT_BASE, inbox: parseInt(E.QFRONT_INBOX_ID || '9'),
  h: { 'access-token': E.QFRONT_ACCESS_TOKEN, client: E.QFRONT_CLIENT, uid: E.QFRONT_UID, 'token-type': 'Bearer', 'Content-Type': 'application/json' } };
const FOLDERS = (E.IMAP_FOLDERS || 'INBOX').split(',').map(s => s.trim());
const STATE = './imported.json';
let done = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(done));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const qf = async (m, p, b) => (await axios({ method: m, url: QF.base + p, data: b, headers: QF.h })).data;

async function ensureContact(name, email) {
  if (email) { const s = await qf('GET', `/contacts/search?q=${encodeURIComponent(email)}`); const c = (s.payload || []).find(x => (x.email || '').toLowerCase() === email.toLowerCase()); if (c) return c.id; }
  const r = await qf('POST', '/contacts', { name: name || email || 'Remetente desconhecido', email: email || undefined, identifier: 'mail-' + (email || Math.random().toString(36).slice(2)) });
  return r.payload.contact.id;
}
async function importMsg(parsed, folder) {
  const mid = parsed.messageId || (parsed.subject + '|' + (parsed.date && parsed.date.toISOString()));
  if (done[mid]) return false;
  const from = parsed.from && parsed.from.value && parsed.from.value[0] || {};
  const contactId = await ensureContact(from.name, (from.address || '').toLowerCase());
  const conv = await qf('POST', '/conversations', { inbox_id: QF.inbox, contact_id: contactId, source_id: 'mailhist-' + Buffer.from(mid).toString('base64').slice(0, 40) });
  const dt = parsed.date ? parsed.date.toLocaleString('pt-BR') : '';
  const body = (parsed.text || (parsed.html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+\n/g, '\n').trim().slice(0, 8000);
  const content = `**${parsed.subject || '(sem assunto)'}**\n_De: ${from.name || ''} <${from.address || ''}> · ${dt} · pasta ${folder}_\n\n${body}`;
  await qf('POST', `/conversations/${conv.id}/messages`, { content, message_type: 'incoming' });
  try { await qf('POST', `/conversations/${conv.id}/toggle_status`, { status: 'resolved' }); } catch (e) {}
  done[mid] = conv.id; save();
  log('OK', folder, '|', (from.address || ''), '|', (parsed.subject || '').slice(0, 50));
  return true;
}
(async () => {
  if (!E.IMAP_PASS) { console.error('ERRO: preencha IMAP_PASS no .env (sua app-password do sac@). O Claude não preenche senha.'); process.exit(1); }
  const client = new ImapFlow({ host: E.IMAP_HOST || 'outlook.office365.com', port: parseInt(E.IMAP_PORT || '993'), secure: true, auth: { user: E.IMAP_USER, pass: E.IMAP_PASS }, logger: false });
  await client.connect(); log('IMAP conectado:', E.IMAP_USER);
  let n = 0, skip = 0;
  for (const folder of FOLDERS) {
    let lock;
    try { lock = await client.getMailboxLock(folder); } catch (e) { log('pasta não encontrada:', folder); continue; }
    try { for await (const msg of client.fetch('1:*', { source: true })) { const parsed = await simpleParser(msg.source); if (await importMsg(parsed, folder)) n++; else skip++; } }
    finally { lock.release(); }
  }
  await client.logout();
  log(`CONCLUÍDO. Importados=${n} | já existentes=${skip} | total marcado=${Object.keys(done).length}`);
})().catch(e => { console.error('FALHA:', e.message); process.exit(1); });
