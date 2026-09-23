// LINE.gs — Messaging API連携（push/reply/Webhook/友だち連携）

function lineToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
  if (!t) throw new Error('CHANNEL_ACCESS_TOKEN が未設定です');
  return t;
}

function push_(to, text) {
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + lineToken_() },
      payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true,
    });
    return { code: res.getResponseCode(), body: res.getContentText() };
  } catch (e) {
    return { code: 0, body: String(e) };
  }
}

function reply_(replyToken, text) {
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + lineToken_() },
      payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true,
    });
    return { code: res.getResponseCode(), body: res.getContentText() };
  } catch (e) {
    return { code: 0, body: String(e) };
  }
}

function notifyConfirm_(targetUser, date, memo, actorName, actorCompanyName) {
  var text = date + ' の予定が「確定」に設定されました（' + actorCompanyName + ' ' + actorName + 'さんの操作）' +
    (memo ? ('\nメモ: ' + memo) : '');
  var res = push_(targetUser['LINEユーザーID'], text);
  appendRow_('NOTIFYLOG', {
    '送信日時': new Date(), '宛先調査員ID': targetUser['調査員ID'], '種別': '確定通知',
    '本文': text, '関連日付': date, 'LINE応答コード': res.code,
  });
}

function handleLineWebhook_(body) {
  (body.events || []).forEach(function (ev) {
    try {
      if (ev.type === 'follow') {
        reply_(ev.replyToken, 'こんにちは。調査員スケジュール共有のLINE連携です。\nWeb画面の「LINE通知を受け取る」ボタンで発行された6桁のコードを、このトークに送ってください。');
      } else if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
        var text = String(ev.message.text || '').trim();
        if (/^\d{6}$/.test(text)) {
          linkByCode_(text, ev.source.userId, ev.replyToken);
        } else {
          reply_(ev.replyToken, '6桁の連携コードを送ってください。Web画面の「LINE通知を受け取る」ボタンから発行できます。');
        }
      }
    } catch (e) {
      console.log('webhook error: ' + e);
    }
  });
  return json_({ ok: true });
}

function linkByCode_(code, lineUserId, replyToken) {
  var codes = readRows_('LINECODE');
  var row = codes.filter(function (c) { return String(c['コード']) === code && !c['使用日時']; })[0];
  if (!row) { reply_(replyToken, 'コードが無効か使用済みです。Web画面でもう一度発行してください。'); return; }
  if (new Date(row['有効期限']).getTime() < Date.now()) {
    reply_(replyToken, 'コードの有効期限が切れています。Web画面でもう一度発行してください。');
    return;
  }

  var users = readRows_('USER');
  var user = users.filter(function (u) { return u['調査員ID'] === row['調査員ID']; })[0];
  if (!user) { reply_(replyToken, '調査員情報が見つかりませんでした。'); return; }

  updateRow_('USER', user._row, { 'LINEユーザーID': lineUserId, 'LINE連携日時': new Date() });
  updateRow_('LINECODE', row._row, { '使用日時': new Date() });

  var companies = readRows_('COMPANY');
  var company = companies.filter(function (c) { return c['会社ID'] === user['会社ID']; })[0];
  reply_(replyToken, (company ? (company['会社名'] + ' ') : '') + user['氏名'] + 'さんとして連携しました。今後、予定の確定時などに通知します。');
}

function lineLinkStart_(body) {
  var investigatorId = String(body.investigatorId || '');
  var user = readRows_('USER').filter(function (u) { return u['調査員ID'] === investigatorId; })[0];
  if (!user) return json_({ ok: false, error: '調査員が見つかりません' });

  var code = String(Math.floor(100000 + Math.random() * 900000));
  var now = new Date();
  var expires = new Date(now.getTime() + 10 * 60 * 1000);
  appendRow_('LINECODE', { 'コード': code, '調査員ID': investigatorId, '発行日時': now, '有効期限': expires, '使用日時': '' });

  var addFriendUrl = PropertiesService.getScriptProperties().getProperty('LINE_ADD_FRIEND_URL') || '';
  return json_({ ok: true, code: code, addFriendUrl: addFriendUrl, expiresAt: expires.toISOString() });
}

function lineLinkStatus_(body) {
  var investigatorId = String(body.investigatorId || '');
  var user = readRows_('USER').filter(function (u) { return u['調査員ID'] === investigatorId; })[0];
  return json_({ ok: true, linked: !!(user && user['LINEユーザーID']) });
}
