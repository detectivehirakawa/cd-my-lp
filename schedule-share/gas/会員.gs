// 会員.gs — メールアドレスによる会員登録・ログイン（たたき台。会社との紐付けは未実装）

function isValidEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}

function memberRequestCode_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  if (!isValidEmail_(email)) return json_({ ok: false, error: 'メールアドレスの形式が正しくありません' });

  if (!throttleEmailOk_(email)) return json_({ ok: false, error: '送信回数が多すぎます。しばらくしてからお試しください' });

  var code = String(Math.floor(100000 + Math.random() * 900000));
  var now = new Date();
  var expires = new Date(now.getTime() + 10 * 60 * 1000);
  appendRow_('MEMBERCODE', { 'コード': code, 'メールアドレス': email, '発行日時': now, '有効期限': expires, '使用日時': '' });

  try {
    MailApp.sendEmail({
      to: email,
      subject: '【タンテーTOWN】ログイン確認コード',
      body: 'タンテーTOWNのログイン確認コードです。\n\n' + code + '\n\n' +
        'このコードは10分間有効です。ご自身で操作していない場合はこのメールを無視してください。',
    });
  } catch (e) {
    return json_({ ok: false, error: 'メール送信に失敗しました: ' + e });
  }

  return json_({ ok: true });
}

function throttleEmailOk_(email) {
  var cache = CacheService.getScriptCache();
  var key = 'mailcode:' + email;
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 300); // 5分あたり
  return n <= 5;
}

function memberVerify_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var code = String(body.code || '').trim();
  if (!isValidEmail_(email)) return json_({ ok: false, error: 'メールアドレスの形式が正しくありません' });

  var rows = readRows_('MEMBERCODE');
  var row = rows.filter(function (r) { return r['メールアドレス'] === email && String(r['コード']) === code && !r['使用日時']; })[0];
  if (!row) return json_({ ok: false, error: 'コードが正しくありません' });
  if (new Date(row['有効期限']).getTime() < Date.now()) return json_({ ok: false, error: 'コードの有効期限が切れています。もう一度送信してください' });

  updateRow_('MEMBERCODE', row._row, { '使用日時': new Date() });

  var members = readRows_('MEMBER');
  var member = members.filter(function (m) { return m['メールアドレス'] === email; })[0];
  var now = new Date();
  if (!member) {
    var ids = members.map(function (m) { return m['会員ID']; });
    var newId = nextId_('K', 5, ids);
    appendRow_('MEMBER', { '会員ID': newId, 'メールアドレス': email, '氏名': '', '登録日時': now, '最終ログイン日時': now });
    return json_({ ok: true, memberId: newId, name: '', isNew: true });
  }
  updateRow_('MEMBER', member._row, { '最終ログイン日時': now });
  return json_({ ok: true, memberId: member['会員ID'], name: member['氏名'] || '', isNew: !member['氏名'] });
}

function memberSetName_(body) {
  var memberId = String(body.memberId || '');
  var name = String(body.name || '').trim();
  if (!name) return json_({ ok: false, error: '氏名を入力してください' });
  if (name.length > 40) return json_({ ok: false, error: '氏名は40文字以内にしてください' });

  var rows = readRows_('MEMBER');
  var m = rows.filter(function (r) { return r['会員ID'] === memberId; })[0];
  if (!m) return json_({ ok: false, error: '会員情報が見つかりません' });

  updateRow_('MEMBER', m._row, { '氏名': name });
  return json_({ ok: true, memberId: memberId, name: name });
}
