/**
 * Neppo ⇄ QFront (Chatwoot) WhatsApp bridge — POLLING.
 * Fase 1: espelha mensagens DO CLIENTE (WhatsApp via Neppo) -> conversas no QFront.
 * Fase 2 (OUTBOUND_ENABLED): resposta do agente no QFront -> WhatsApp via Neppo, com TRAVA por lista branca (OUTBOUND_WHITELIST).
 *   - OUTBOUND_WHITELIST vazia => NÃO envia a ninguém (seguro). '*' => envia a todos. Senão, só aos telefones listados.
 *   - NEPPO_GROUP_FILTER (id ou nome do grupo) escopa o que é tratado; vazio => todos os grupos.
 */
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const C = {
  neppoAuth: 'https://api-auth.neppo.com.br/oauth2/token',
  neppoApi: process.env.NEPPO_API_BASE || 'https://api.neppo.com.br',
  key: process.env.NEPPO_CONSUMER_KEY, secret: process.env.NEPPO_CONSUMER_SECRET,
  nuser: process.env.NEPPO_USER, npass: process.env.NEPPO_PASS,
  channel: process.env.NEPPO_CHANNEL || 'WHATSAPP',
  groupFilter: list(process.env.NEPPO_GROUP_FILTER),         // ids ou nomes de grupo a tratar (vazio=todos)
  neppoUserId: parseInt(process.env.NEPPO_USER_ID || '0'),
  qfBase: process.env.QFRONT_BASE, qfAccess: process.env.QFRONT_ACCESS_TOKEN, qfClient: process.env.QFRONT_CLIENT, qfUid: process.env.QFRONT_UID,
  qfInbox: parseInt(process.env.QFRONT_INBOX_ID || '2'),
  triageTeam: parseInt(process.env.TRIAGE_TEAM_ID || '1'),    // SAC: time p/ triagem automatica instantanea (1 = triagem/gestao)
  pollMs: parseInt(process.env.POLL_MS || '15000'),
  outbound: (process.env.OUTBOUND_ENABLED || 'false') === 'true',
  whitelist: list(process.env.OUTBOUND_WHITELIST),           // telefones permitidos p/ envio (vazio=nenhum; '*'=todos)
  seed: parseInt(process.env.SEED_BACKLOG || '0'),
};
const STATE = './state.json';
let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : { lastMsgId: null, sessions: {}, sentOut: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString(), ...a);

let tok = null, exp = 0;
async function neppoToken() {
  if (tok && Date.now() < exp - 60000) return tok;
  const basic = Buffer.from(`${C.key}:${C.secret}`).toString('base64');
  const r = await axios.post(C.neppoAuth, `grant_type=password&username=${encodeURIComponent(C.nuser)}&password=${encodeURIComponent(C.npass)}`,
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  tok = r.data.access_token; exp = Date.now() + (r.data.expires_in || 3600) * 1000; log('Neppo token OK'); return tok;
}
const neppo = async (path, body, _retry) => {
  const t = await neppoToken();
  try { return (await axios.post(C.neppoApi + path, body, { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } })).data; }
  catch (e) { if (e.response && e.response.status === 401 && !_retry) { log('Neppo 401 -> re-mintando token'); tok = null; exp = 0; return neppo(path, body, true); } throw e; }
};
const qf = async (m, p, b) => (await axios({ method: m, url: C.qfBase + p, data: b, headers: { 'access-token': C.qfAccess, client: C.qfClient, uid: C.qfUid, 'token-type': 'Bearer', 'Content-Type': 'application/json' } })).data;

const isCustomer = m => m && m.sendBy === 'user' && /^whatsapp_/i.test(m.fromUser || '') && m.message;
const phoneOf = m => String((m.session && m.session.user && m.session.user.phone) || (m.fromUser || '').replace(/^whatsapp_/i, '')).replace(/\D/g, '');
const nameOf = m => (m.session && m.session.user && (m.session.user.name || m.session.user.displayName)) || phoneOf(m);
const groupOf = m => (m.session && m.session.groupConf) || {};
const inScope = m => { if (!C.groupFilter.length) return true; const g = groupOf(m); return C.groupFilter.includes(String(g.id)) || C.groupFilter.includes(g.name); };
const allowOut = phone => C.whitelist.includes('*') || C.whitelist.includes(phone);
const getConv = phone => { const v = state.sessions[phone]; return v && (typeof v === 'object' ? v.conv : v); };

// classifica motivo (label) por palavra-chave da mensagem; origem WhatsApp = sempre aberto-cliente
function classifyLabels(text) {
  const t = (text || '').toLowerCase();
  const has = (...ws) => ws.some(w => t.includes(w));
  const out = ['aberto-cliente'];
  if (has('boleto') && has('atualiz', 'vencid', 'vencimento')) out.push('fin-atualizacao-boleto');
  else if (has('boleto', 'segunda via', '2 via', '2a via', 'reemiss')) out.push('fin-reemissao-boleto-nf');
  if (has('nota fiscal', 'nf-e', 'nfe', 'danfe', 'xml da nota')) out.push('fin-nota-fiscal');
  if (has('cadastro', 'dados cadastrais', 'atualizar dados', 'alterar dados')) out.push('fin-cadastro');
  if (has('suspender', 'suspensao') && has('cobranca', 'cobrança')) out.push('fin-suspender-cobranca');
  if (has('cotacao', 'cotação', 'orcamento', 'orçamento', 'tabela de preco', 'tabela de preço')) out.push('comercial-cotacao');
  if (has('avaria', 'avariado', 'danificad', 'quebrad', 'vazou', 'vazamento', 'violad')) out.push('log-avaria');
  if (has('cancelar', 'cancelamento') && has('nota', ' nf', 'pedido')) out.push('log-cancelamento-nf');
  if (has('devolucao', 'devolução', 'devolver', 'devolvid')) out.push('log-devolucao');
  if (has('granel')) out.push('log-manutencao-granel');
  if (has('brinde')) out.push('mkt-brinde');
  if (has('patrocinio', 'patrocínio', 'verba de marketing')) out.push('mkt-investimento');
  if (has('desconto')) out.push('os-desconto');
  if (has('inflamavel', 'inflamáveis', 'inflamaveis')) out.push('area-inflaveis');
  if (has('motoroil', 'motor oil', 'oleo de motor', 'óleo de motor')) out.push('area-motoroil');
  return [...new Set(out)];
}
// SAC: ao abrir o ticket -> triagem instantanea (time) + protocolo unico + classificacao de motivo (label) + nota privada
async function sacEnrich(convId, text) {
  const protocolo = 'SAC-' + String(convId).padStart(6, '0');
  try { await qf('POST', `/conversations/${convId}/assignments`, { team_id: C.triageTeam }); } catch (e) { log('WARN assign', convId, e.response ? e.response.status : e.message); }
  try { await qf('POST', `/conversations/${convId}/custom_attributes`, { custom_attributes: { protocolo_sac: protocolo } }); } catch (e) { log('WARN protocolo', convId, e.response ? e.response.status : e.message); }
  const labels = classifyLabels(text);
  if (labels.length) { try { await qf('POST', `/conversations/${convId}/labels`, { labels }); } catch (e) { log('WARN labels', convId, e.response ? e.response.status : e.message); } }
  try { await qf('POST', `/conversations/${convId}/messages`, { content: `🔖 Protocolo ${protocolo} (WhatsApp). Triagem: triagem/gestao.`, private: true }); } catch (e) {}
  log('SAC ticket', convId, protocolo, '|', labels.join(','));
  return protocolo;
}
async function qfEnsureConversation(phone, name, g, firstMsg) {
  if (getConv(phone)) return getConv(phone);
  let contact;
  const s = await qf('GET', `/contacts/search?q=${encodeURIComponent(phone)}`);
  contact = (s.payload || []).find(c => (c.phone_number || '').includes(phone) || c.identifier === 'wa-' + phone);
  if (!contact) contact = (await qf('POST', '/contacts', { name, identifier: 'wa-' + phone, phone_number: '+' + phone })).payload.contact;
  const conv = await qf('POST', '/conversations', { inbox_id: C.qfInbox, contact_id: contact.id, source_id: 'wa-' + phone + '-' + Date.now() });
  const protocolo = await sacEnrich(conv.id, firstMsg);
  state.sessions[phone] = { conv: conv.id, gcId: g.id || null, gcName: g.name || null, protocolo }; save();
  log('QFront conversa criada', conv.id, 'p/', phone, name, '| grupo', g.name); return conv.id;
}
async function mirror(m) {
  const phone = phoneOf(m); if (!phone) return;
  const conv = await qfEnsureConversation(phone, nameOf(m), groupOf(m), m.message);
  await qf('POST', `/conversations/${conv}/messages`, { content: m.message, message_type: 'incoming' });
  log('IN  WA->QFront', phone, '|', (groupOf(m).name || '-'), '|', JSON.stringify(m.message).slice(0, 45));
}
async function pollInbound() {
  const res = await neppo('/chatapi/1.0/api/messages', { conditions: [], direction: 'DESC', page: 0, sort: true, sortColumn: 'id', size: 30 });
  const items = (res.results || res.content || []).slice().sort((a, b) => a.id - b.id);
  if (!items.length) return;
  const maxId = items[items.length - 1].id;
  if (state.lastMsgId == null) {
    const cust = items.filter(m => isCustomer(m) && inScope(m));
    for (const m of cust.slice(-C.seed)) await mirror(m);
    state.lastMsgId = maxId; save(); log('Primado lastMsgId=' + maxId); return;
  }
  for (const m of items) { if (m.id <= state.lastMsgId) continue; if (isCustomer(m) && inScope(m)) await mirror(m); }
  state.lastMsgId = Math.max(state.lastMsgId, maxId); save();
}
async function pollOutbound() {
  if (!C.outbound) return;
  for (const [phone, v] of Object.entries(state.sessions)) {
    const conv = typeof v === 'object' ? v.conv : v; const g = (typeof v === 'object') ? v : {};
    const msgs = (await qf('GET', `/conversations/${conv}/messages`)).payload || [];
    for (const m of msgs) {
      if (m.message_type !== 1 || m.private || state.sentOut[m.id] || !m.content) continue;
      if (!allowOut(phone)) { state.sentOut[m.id] = true; save(); log('OUT BLOQUEADO (fora da whitelist)', phone); continue; }
      await neppo('/chatapi/1.0/api/direct-message/save', { phoneNumber: phone, channel: C.channel, message: m.content, groupName: g.gcName || undefined, groupConfId: g.gcId || undefined, userId: C.neppoUserId, status: 'PROCESSANDO', createdBy: 'qfront-bridge' });
      state.sentOut[m.id] = true; save(); log('OUT QFront->WA', phone, '|', JSON.stringify(m.content).slice(0, 45));
    }
  }
}
async function loop() {
  try { await pollInbound(); await pollOutbound(); }
  catch (e) { log('ERRO', e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message); }
  setTimeout(loop, C.pollMs);
}
log(`Bridge on. outbound=${C.outbound} whitelist=[${C.whitelist.join(',')}] groupFilter=[${C.groupFilter.join(',')}] poll=${C.pollMs}ms inbox=${C.qfInbox}`);
loop();
