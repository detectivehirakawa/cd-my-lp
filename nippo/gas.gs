/**
 * 調査日報 → LINEグループ 自動送信（Google Apps Script）
 *
 * 役割
 *  1. 日報ページ（index.html）から POST された本文を、公式LINE（Messaging API）で
 *     指定の LINE グループへ push する。
 *  2. LINE の Webhook を受け取り、公式LINEが招待されたグループの groupId を自動で記憶する。
 *  3. 送信した日報を Google スプレッドシートに1行ずつ記録する（初回に自動作成）。
 *
 * 必要な設定（プロジェクトの設定 → スクリプト プロパティ）
 *  CHANNEL_ACCESS_TOKEN : LINE Developers の Messaging API チャネルの「チャネルアクセストークン（長期）」
 *  ※ GROUP_ID と SHEET_ID は自動で保存されるので手で入れなくてよい。
 *
 * デプロイ: 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *          実行するユーザー「自分」 / アクセスできるユーザー「全員」
 *          発行された URL（…/exec）を LINE の Webhook URL と index.html の AUTO_SEND_URL に設定する。
 */

const SHARED_KEY = 'nippo';      // index.html の AUTO_SEND_KEY と一致させる
const SHEET_NAME = '調査日報ログ';

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  if (Array.isArray(body.events)) return handleLineWebhook_(body);
  return handleReport_(body);
}

function doGet() {
  const p = PropertiesService.getScriptProperties();
  return json_({
    ok: true,
    tokenSet: !!p.getProperty('CHANNEL_ACCESS_TOKEN'),
    groupSet: !!p.getProperty('GROUP_ID'),
    sheetUrl: p.getProperty('SHEET_ID') ? 'https://docs.google.com/spreadsheets/d/' + p.getProperty('SHEET_ID') : null
  });
}

/* ---------- LINE Webhook: グループIDを記憶する ---------- */
function handleLineWebhook_(body) {
  const p = PropertiesService.getScriptProperties();
  body.events.forEach(function (ev) {
    const src = ev.source || {};
    if (src.type !== 'group' || !src.groupId) return;
    if (ev.type === 'join') {
      p.setProperty('GROUP_ID', src.groupId);
      reply_(ev.replyToken, 'このグループに調査日報を自動送信します。');
    } else if (ev.type === 'message' && ev.message && ev.message.type === 'text'
               && ev.message.text.trim() === '日報送信先') {
      p.setProperty('GROUP_ID', src.groupId);
      reply_(ev.replyToken, 'このグループを調査日報の送信先に設定しました。');
    }
  });
  return json_({ ok: true });
}

/* ---------- 日報の受信 → LINE push + シート記録 ---------- */
function handleReport_(body) {
  if (body.key !== SHARED_KEY) return json_({ ok: false, error: '認証キーが一致しません' });
  const text = String(body.text || '').trim();
  if (!text) return json_({ ok: false, error: '本文が空です' });

  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('CHANNEL_ACCESS_TOKEN');
  const groupId = p.getProperty('GROUP_ID');
  if (!token) return json_({ ok: false, error: 'GAS に CHANNEL_ACCESS_TOKEN が設定されていません' });
  if (!groupId) return json_({ ok: false, error: '送信先グループが未設定です。公式LINEをグループに招待してください' });

  const header = body.sender ? '【' + body.sender + 'さんの日報】\n' : '';
  const messages = chunk_(header + text, 4900).slice(0, 5).map(function (t) { return { type: 'text', text: t }; });

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: groupId, messages: messages }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    return json_({ ok: false, error: 'LINE API エラー ' + code + ': ' + res.getContentText().slice(0, 200) });
  }

  try { logToSheet_(body, text); } catch (err) { /* ログ失敗は送信成功を妨げない */ }
  return json_({ ok: true });
}

function logToSheet_(body, text) {
  const p = PropertiesService.getScriptProperties();
  let ss;
  const id = p.getProperty('SHEET_ID');
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    p.setProperty('SHEET_ID', ss.getId());
    const sh = ss.getActiveSheet();
    sh.setName(SHEET_NAME);
    sh.appendRow(['送信日時', '調査日', '案件名', '送信者', '調査時間', '経費合計', '本文']);
    sh.setFrozenRows(1);
  }
  const sh = ss.getSheetByName(SHEET_NAME) || ss.getActiveSheet();
  sh.appendRow([new Date(), body.date || '', body.caseName || '', body.sender || '', body.hours || '', body.total || '', text]);
}

/* ---------- helpers ---------- */
function reply_(replyToken, text) {
  const token = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
  if (!token || !replyToken) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

function chunk_(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** エディタから手動実行して疎通確認する用（グループにテスト文が届く） */
function testSend() {
  const r = handleReport_({ key: SHARED_KEY, text: 'テスト送信（調査日報システム）', sender: 'テスト', date: '', caseName: 'テスト' });
  Logger.log(r.getContent());
}
