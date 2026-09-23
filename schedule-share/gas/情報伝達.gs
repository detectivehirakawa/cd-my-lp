// 情報伝達.gs — 案件(あんけん)ごとの情報共有：案件一覧・作成・早い者勝ち受任・スレッド・お知らせフィード

function myCompanyId_(investigatorId) {
  var user = readRows_('USER').filter(function (u) { return u['調査員ID'] === investigatorId; })[0];
  return user ? user['会社ID'] : null;
}

function visibleCases_(myCompanyId) {
  return readRows_('CASE').filter(function (c) {
    return c['会社ID_A'] === myCompanyId || c['会社ID_B'] === myCompanyId;
  });
}

// 案件の相手会社ID（自社が作成者ではない側）を返す
function partnerCompanyIdOf_(c, myCompanyId) {
  return c['会社ID_A'] === myCompanyId ? c['会社ID_B'] : c['会社ID_A'];
}

function caseList_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var companyMap = {};
  readRows_('COMPANY').forEach(function (c) { companyMap[c['会社ID']] = c; });
  var userMap = {};
  readRows_('USER').forEach(function (u) { userMap[u['調査員ID']] = u; });
  var msgs = readRows_('CASEMSG');
  var lastMsgByCase = {};
  msgs.forEach(function (m) {
    var cur = lastMsgByCase[m['案件ID']];
    if (!cur || new Date(m['投稿日時']) > new Date(cur['投稿日時'])) lastMsgByCase[m['案件ID']] = m;
  });

  var list = visibleCases_(myCompanyId).map(function (c) {
    var partnerId = partnerCompanyIdOf_(c, myCompanyId);
    var last = lastMsgByCase[c['案件ID']];
    var assignee = userMap[c['担当者調査員ID']];
    var creatorCompanyId = (userMap[c['作成者調査員ID']] || {})['会社ID'];
    var claimable = c['状態'] === '募集中' && !c['担当者調査員ID'] && myCompanyId !== creatorCompanyId;
    return {
      id: c['案件ID'],
      title: c['案件名'],
      status: c['状態'],
      partnerCompanyName: (companyMap[partnerId] || {})['会社名'] || partnerId,
      assigneeName: assignee ? assignee['氏名'] : '',
      expenseStatus: c['経費提出状態'] || '',
      memo: c['備考'] || '',
      createdAt: c['作成日時'] ? String(c['作成日時']) : '',
      lastMessageAt: last ? String(last['投稿日時']) : (c['作成日時'] ? String(c['作成日時']) : ''),
      lastMessagePreview: last ? String(last['本文']).slice(0, 40) : '',
      claimable: claimable,
    };
  });

  list.sort(function (a, b) {
    // 募集中(受任待ち)を最優先、それ以外は最新メッセージ順
    if ((a.status === '募集中') !== (b.status === '募集中')) return a.status === '募集中' ? -1 : 1;
    return new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
  });
  return json_({ ok: true, cases: list });
}

function caseCreate_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });

  var title = String(body.title || '').trim();
  var partnerCompanyId = String(body.partnerCompanyId || '');
  var memo = String(body.memo || '').trim();
  if (!title) return json_({ ok: false, error: '案件名を入力してください' });
  if (title.length > 80) return json_({ ok: false, error: '案件名は80文字以内にしてください' });

  var partner = readRows_('COMPANY').filter(function (c) { return c['会社ID'] === partnerCompanyId; })[0];
  if (!partner) return json_({ ok: false, error: '相手会社が見つかりません' });

  var ids = readRows_('CASE').map(function (c) { return c['案件ID']; });
  var newId = nextId_('J', 4, ids);
  var now = new Date();
  appendRow_('CASE', {
    '案件ID': newId, '案件名': title, '会社ID_A': auth.user['会社ID'], '会社ID_B': partnerCompanyId,
    '状態': '募集中', '担当者調査員ID': '', '経費提出状態': '',
    '作成者調査員ID': body.investigatorId, '作成日時': now, '備考': memo,
  });
  logHistory_(body.investigatorId, 'case.create', newId, null, { title: title, partnerCompanyId: partnerCompanyId });

  return json_({ ok: true, id: newId });
}

// 早い者勝ちの受任。LockServiceで同時クリックの競合を防ぐ。
function caseClaim_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return json_({ ok: false, error: '混み合っています。もう一度お試しください' });
  }
  try {
    var rows = readRows_('CASE');
    var c = rows.filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
    if (!c) return json_({ ok: false, error: '案件が見つかりません' });

    var userMap = {};
    readRows_('USER').forEach(function (u) { userMap[u['調査員ID']] = u; });
    var creatorCompanyId = (userMap[c['作成者調査員ID']] || {})['会社ID'];
    if (c['会社ID_A'] !== myCompanyId && c['会社ID_B'] !== myCompanyId) return json_({ ok: false, error: 'この案件を受任する権限がありません' });
    if (myCompanyId === creatorCompanyId) return json_({ ok: false, error: '依頼した側では受任できません' });
    if (c['状態'] !== '募集中' || c['担当者調査員ID']) return json_({ ok: false, error: 'すでに他の方が受任しています' });

    updateRow_('CASE', c._row, { '担当者調査員ID': body.investigatorId, '状態': '進行中' });
    logHistory_(body.investigatorId, 'case.claim', c['案件ID'], { status: '募集中' }, { status: '進行中', assignee: body.investigatorId });
    return json_({ ok: true, status: '進行中' });
  } finally {
    lock.releaseLock();
  }
}

function caseGet_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var c = readRows_('CASE').filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myCompanyId && c['会社ID_B'] !== myCompanyId) return json_({ ok: false, error: 'この案件を見る権限がありません' });

  var companyMap = {};
  readRows_('COMPANY').forEach(function (co) { companyMap[co['会社ID']] = co; });
  var userMap = {};
  readRows_('USER').forEach(function (u) { userMap[u['調査員ID']] = u; });

  var messages = readRows_('CASEMSG').filter(function (m) { return m['案件ID'] === c['案件ID']; }).map(function (m) {
    var poster = userMap[m['投稿者調査員ID']] || {};
    var posterCompany = companyMap[poster['会社ID']] || {};
    return {
      id: m['メッセージID'], body: m['本文'],
      posterName: poster['氏名'] || '', posterCompanyName: posterCompany['会社名'] || '',
      postedAt: m['投稿日時'] ? String(m['投稿日時']) : '',
      mine: m['投稿者調査員ID'] === body.investigatorId,
    };
  });
  messages.sort(function (a, b) { return new Date(a.postedAt) - new Date(b.postedAt); });

  var partnerId = partnerCompanyIdOf_(c, myCompanyId);
  var creatorCompanyId = (userMap[c['作成者調査員ID']] || {})['会社ID'];
  var assignee = userMap[c['担当者調査員ID']];
  var claimable = c['状態'] === '募集中' && !c['担当者調査員ID'] && myCompanyId !== creatorCompanyId;

  return json_({
    ok: true,
    id: c['案件ID'], title: c['案件名'], status: c['状態'], memo: c['備考'] || '',
    partnerCompanyName: (companyMap[partnerId] || {})['会社名'] || partnerId,
    assigneeName: assignee ? assignee['氏名'] : '',
    expenseStatus: c['経費提出状態'] || '',
    claimable: claimable,
    isCreatorSide: myCompanyId === creatorCompanyId,
    messages: messages,
  });
}

function caseMessagePost_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var c = readRows_('CASE').filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myCompanyId && c['会社ID_B'] !== myCompanyId) return json_({ ok: false, error: 'この案件に投稿する権限がありません' });

  var text = String(body.body || '').trim();
  if (!text) return json_({ ok: false, error: '本文を入力してください' });
  if (text.length > 2000) return json_({ ok: false, error: '本文は2000文字以内にしてください' });

  var ids = readRows_('CASEMSG').map(function (m) { return m['メッセージID']; });
  var newId = nextId_('M', 5, ids);
  appendRow_('CASEMSG', { 'メッセージID': newId, '案件ID': c['案件ID'], '投稿者調査員ID': body.investigatorId, '本文': text, '投稿日時': new Date() });
  logHistory_(body.investigatorId, 'case.message.post', newId, null, { caseId: c['案件ID'] });

  return json_({ ok: true, id: newId });
}

function caseUpdateStatus_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var rows = readRows_('CASE');
  var c = rows.filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myCompanyId && c['会社ID_B'] !== myCompanyId) return json_({ ok: false, error: 'この案件を操作する権限がありません' });

  var status = String(body.status || '');
  if (['進行中', '完了', '保留'].indexOf(status) === -1) return json_({ ok: false, error: 'statusが不正です' });

  var patch = { '状態': status };
  if (status === '完了' && !c['経費提出状態']) patch['経費提出状態'] = '未提出';
  updateRow_('CASE', c._row, patch);
  logHistory_(body.investigatorId, 'case.updateStatus', c['案件ID'], { status: c['状態'] }, { status: status });
  return json_({ ok: true, status: status });
}

function caseMarkExpenseSubmitted_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var rows = readRows_('CASE');
  var c = rows.filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myCompanyId && c['会社ID_B'] !== myCompanyId) return json_({ ok: false, error: 'この案件を操作する権限がありません' });

  updateRow_('CASE', c._row, { '経費提出状態': '提出済み' });
  logHistory_(body.investigatorId, 'case.expenseSubmitted', c['案件ID'], { expenseStatus: c['経費提出状態'] }, { expenseStatus: '提出済み' });
  return json_({ ok: true });
}

function feedRecent_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });
  var myCompanyId = auth.user['会社ID'];

  var myCases = {};
  visibleCases_(myCompanyId).forEach(function (c) { myCases[c['案件ID']] = c; });

  var companyMap = {};
  readRows_('COMPANY').forEach(function (c) { companyMap[c['会社ID']] = c; });
  var userMap = {};
  readRows_('USER').forEach(function (u) { userMap[u['調査員ID']] = u; });

  var list = readRows_('CASEMSG').filter(function (m) { return myCases[m['案件ID']]; }).map(function (m) {
    var poster = userMap[m['投稿者調査員ID']] || {};
    var posterCompany = companyMap[poster['会社ID']] || {};
    var c = myCases[m['案件ID']];
    return {
      id: m['メッセージID'], caseId: m['案件ID'], caseTitle: c['案件名'],
      body: m['本文'], posterName: poster['氏名'] || '', posterCompanyName: posterCompany['会社名'] || '',
      postedAt: m['投稿日時'] ? String(m['投稿日時']) : '',
    };
  });
  list.sort(function (a, b) { return new Date(b.postedAt) - new Date(a.postedAt); });
  return json_({ ok: true, feed: list.slice(0, 50) });
}
