// 情報伝達.gs — お知らせ（全社宛/個別宛）の投稿・取得・固定表示切替

function noticeList_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var userMap = {};
  readRows_('USER').forEach(function (u) { userMap[u['調査員ID']] = u; });
  var companyMap = {};
  readRows_('COMPANY').forEach(function (c) { companyMap[c['会社ID']] = c; });

  var list = readRows_('NOTICE').filter(function (n) {
    var poster = userMap[n['投稿者調査員ID']] || {};
    var posterCompanyId = poster['会社ID'];
    return n['対象範囲'] === '全社' || n['対象範囲'] === myCompanyId || posterCompanyId === myCompanyId;
  }).map(function (n) {
    var poster = userMap[n['投稿者調査員ID']] || {};
    var posterCompany = companyMap[poster['会社ID']] || {};
    var targetName = n['対象範囲'] === '全社' ? '全社' : ((companyMap[n['対象範囲']] || {})['会社名'] || n['対象範囲']);
    return {
      id: n['お知らせID'],
      targetCompanyId: n['対象範囲'],
      targetName: targetName,
      title: n['タイトル'],
      body: n['本文'],
      posterName: poster['氏名'] || '',
      posterCompanyName: posterCompany['会社名'] || '',
      posterInvestigatorId: n['投稿者調査員ID'],
      postedAt: n['投稿日時'] ? String(n['投稿日時']) : '',
      pinned: (n['固定表示'] === true || n['固定表示'] === 'true'),
    };
  });

  list.sort(function (a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.postedAt) - new Date(a.postedAt);
  });

  return json_({ ok: true, notices: list.slice(0, 200) });
}

function noticePost_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });

  var title = String(body.title || '').trim();
  var text = String(body.body || '').trim();
  var targetCompanyId = String(body.targetCompanyId || '全社');
  if (!title || !text) return json_({ ok: false, error: 'タイトルと本文を入力してください' });
  if (title.length > 80) return json_({ ok: false, error: 'タイトルは80文字以内にしてください' });
  if (text.length > 2000) return json_({ ok: false, error: '本文は2000文字以内にしてください' });

  if (targetCompanyId !== '全社') {
    var target = readRows_('COMPANY').filter(function (c) { return c['会社ID'] === targetCompanyId; })[0];
    if (!target) return json_({ ok: false, error: '宛先の会社が見つかりません' });
  }

  var ids = readRows_('NOTICE').map(function (n) { return n['お知らせID']; });
  var newId = nextId_('N', 4, ids);
  var now = new Date();
  appendRow_('NOTICE', {
    'お知らせID': newId, '対象範囲': targetCompanyId, 'タイトル': title, '本文': text,
    '投稿者調査員ID': body.investigatorId, '投稿日時': now, '固定表示': false,
  });
  logHistory_(body.investigatorId, 'notice.post', newId, null, { targetCompanyId: targetCompanyId, title: title });

  return json_({ ok: true, id: newId });
}

function noticeTogglePin_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });

  var rows = readRows_('NOTICE');
  var n = rows.filter(function (r) { return String(r['お知らせID']) === String(body.id); })[0];
  if (!n) return json_({ ok: false, error: 'お知らせが見つかりません' });

  var wasPinned = (n['固定表示'] === true || n['固定表示'] === 'true');
  var pinned = !wasPinned;
  updateRow_('NOTICE', n._row, { '固定表示': pinned });
  logHistory_(body.investigatorId, 'notice.pin', n['お知らせID'], { pinned: wasPinned }, { pinned: pinned });

  return json_({ ok: true, pinned: pinned });
}
