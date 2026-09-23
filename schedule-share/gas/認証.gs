// 認証.gs — 会社コード認証・氏名選択

function sessionStart_(body) {
  var code = String(body.companyCode || '').trim();
  if (!code) return json_({ ok: false, error: '会社コードを入力してください' });

  var companies = readRows_('COMPANY');
  var company = companies.filter(function (c) {
    return String(c['会社コード']) === code && c['状態'] !== '停止';
  })[0];
  if (!company) return json_({ ok: false, error: 'コードが正しくありません。担当会社にご確認ください' });

  var users = readRows_('USER').filter(function (u) {
    return u['会社ID'] === company['会社ID'] && u['状態'] !== '退職';
  });
  return json_({
    ok: true,
    companyId: company['会社ID'],
    companyName: company['会社名'],
    investigators: users.map(function (u) { return { id: u['調査員ID'], name: u['氏名'] }; }),
  });
}

function sessionPickName_(body) {
  var code = String(body.companyCode || '').trim();
  var companyId = String(body.companyId || '');
  var name = String(body.name || '').trim();
  if (!name) return json_({ ok: false, error: '氏名を入力してください' });

  var companies = readRows_('COMPANY');
  var company = companies.filter(function (c) {
    return c['会社ID'] === companyId && String(c['会社コード']) === code && c['状態'] !== '停止';
  })[0];
  if (!company) return json_({ ok: false, error: '会社コードが確認できません' });

  var users = readRows_('USER');
  var user = users.filter(function (u) {
    return u['会社ID'] === companyId && u['氏名'] === name && u['状態'] !== '退職';
  })[0];

  if (!user) {
    var ids = users.map(function (u) { return u['調査員ID']; });
    var newId = nextId_('U', 4, ids);
    appendRow_('USER', {
      '調査員ID': newId, '会社ID': companyId, '氏名': name, '状態': '在籍',
      'LINEユーザーID': '', 'LINE連携日時': '',
      '登録日時': new Date(), '最終アクセス日時': new Date(), '備考': '',
    });
    user = { '調査員ID': newId, '氏名': name, 'LINEユーザーID': '' };
  }

  return json_({
    ok: true,
    investigatorId: user['調査員ID'],
    name: user['氏名'],
    lineLinked: !!user['LINEユーザーID'],
  });
}

// companyCode と investigatorId の組が正当かをサーバ側で再検証する
function verifyCompanyCode_(companyCode, investigatorId) {
  var users = readRows_('USER');
  var user = users.filter(function (u) { return u['調査員ID'] === investigatorId; })[0];
  if (!user) return null;
  var companies = readRows_('COMPANY');
  var company = companies.filter(function (c) {
    return c['会社ID'] === user['会社ID'] && String(c['会社コード']) === String(companyCode) && c['状態'] !== '停止';
  })[0];
  if (!company) return null;
  return { company: company, user: user };
}
