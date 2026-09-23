// 情報伝達.gs — 案件(あんけん)ごとの情報共有：案件一覧・作成・早い者勝ち受任・スレッド・お知らせフィード
// 会社コード方式は廃止。会員(MEMBER)の事務所名を「会社」としてグルーピングする。

function agencyOf_(memberRow) {
  return (memberRow && memberRow['事務所名']) || '(所属未設定)';
}

function visibleCases_(myAgency) {
  return readRows_('CASE').filter(function (c) {
    return c['会社ID_A'] === myAgency || c['会社ID_B'] === myAgency;
  });
}

// 案件の相手事務所名（自分の事務所ではない側）を返す
function partnerAgencyOf_(c, myAgency) {
  return c['会社ID_A'] === myAgency ? c['会社ID_B'] : c['会社ID_A'];
}

// body.companyCode に会員のメールアドレス、body.investigatorId に会員IDを乗せて呼ぶ（旧フィールド名を流用）
function caseList_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var myAgency = auth.user['会社ID'];

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });
  var msgs = readRows_('CASEMSG');
  var lastMsgByCase = {};
  msgs.forEach(function (m) {
    var cur = lastMsgByCase[m['案件ID']];
    if (!cur || new Date(m['投稿日時']) > new Date(cur['投稿日時'])) lastMsgByCase[m['案件ID']] = m;
  });

  var list = visibleCases_(myAgency).map(function (c) {
    var partnerAgency = partnerAgencyOf_(c, myAgency);
    var last = lastMsgByCase[c['案件ID']];
    var assignee = memberMap[c['担当者調査員ID']];
    var creatorAgency = agencyOf_(memberMap[c['作成者調査員ID']]);
    var claimable = c['状態'] === '募集中' && !c['担当者調査員ID'] && myAgency !== creatorAgency;
    return {
      id: c['案件ID'],
      title: c['案件名'],
      status: c['状態'],
      partnerCompanyName: partnerAgency,
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
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var title = String(body.title || '').trim();
  var partnerAgency = String(body.partnerCompanyId || '').trim();
  var memo = String(body.memo || '').trim();
  var purpose = String(body.purpose || '').trim();
  if (!title) return json_({ ok: false, error: '案件名を入力してください' });
  if (title.length > 80) return json_({ ok: false, error: '案件名は80文字以内にしてください' });
  if (!partnerAgency) return json_({ ok: false, error: '相手の事務所を選んでください' });

  var ids = readRows_('CASE').map(function (c) { return c['案件ID']; });
  var newId = nextId_('J', 4, ids);
  var now = new Date();
  appendRow_('CASE', {
    '案件ID': newId, '案件名': title, '会社ID_A': auth.user['会社ID'], '会社ID_B': partnerAgency,
    '状態': '募集中', '担当者調査員ID': '', '経費提出状態': '',
    '作成者調査員ID': body.investigatorId, '作成日時': now, '備考': memo, '調査目的': purpose,
  });
  logHistory_(body.investigatorId, 'case.create', newId, null, { title: title, partnerAgency: partnerAgency });

  return json_({ ok: true, id: newId });
}

// 早い者勝ちの受任。LockServiceで同時クリックの競合を防ぐ。
function caseClaim_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var myAgency = auth.user['会社ID'];

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

    var memberMap = {};
    readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });
    var creatorAgency = agencyOf_(memberMap[c['作成者調査員ID']]);
    if (c['会社ID_A'] !== myAgency && c['会社ID_B'] !== myAgency) return json_({ ok: false, error: 'この案件を受任する権限がありません' });
    if (myAgency === creatorAgency) return json_({ ok: false, error: '依頼した側では受任できません' });
    if (c['状態'] !== '募集中' || c['担当者調査員ID']) return json_({ ok: false, error: 'すでに他の方が受任しています' });

    updateRow_('CASE', c._row, { '担当者調査員ID': body.investigatorId, '状態': '進行中' });
    logHistory_(body.investigatorId, 'case.claim', c['案件ID'], { status: '募集中' }, { status: '進行中', assignee: body.investigatorId });
    return json_({ ok: true, status: '進行中' });
  } finally {
    lock.releaseLock();
  }
}

function caseGet_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var myAgency = auth.user['会社ID'];

  var c = readRows_('CASE').filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myAgency && c['会社ID_B'] !== myAgency) return json_({ ok: false, error: 'この案件を見る権限がありません' });

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });

  var messages = readRows_('CASEMSG').filter(function (m) { return m['案件ID'] === c['案件ID']; }).map(function (m) {
    var poster = memberMap[m['投稿者調査員ID']] || {};
    return {
      id: m['メッセージID'], body: m['本文'],
      posterName: poster['氏名'] || '', posterCompanyName: agencyOf_(poster),
      postedAt: m['投稿日時'] ? String(m['投稿日時']) : '',
      mine: m['投稿者調査員ID'] === body.investigatorId,
    };
  });
  messages.sort(function (a, b) { return new Date(a.postedAt) - new Date(b.postedAt); });

  var partnerAgency = partnerAgencyOf_(c, myAgency);
  var creatorAgency = agencyOf_(memberMap[c['作成者調査員ID']]);
  var assignee = memberMap[c['担当者調査員ID']];
  var claimable = c['状態'] === '募集中' && !c['担当者調査員ID'] && myAgency !== creatorAgency;

  return json_({
    ok: true,
    id: c['案件ID'], title: c['案件名'], status: c['状態'], memo: c['備考'] || '',
    purpose: c['調査目的'] || '',
    partnerCompanyName: partnerAgency,
    assigneeName: assignee ? assignee['氏名'] : '',
    expenseStatus: c['経費提出状態'] || '',
    claimable: claimable,
    isCreatorSide: myAgency === creatorAgency,
    messages: messages,
  });
}

function caseMessagePost_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var myAgency = auth.user['会社ID'];

  var c = readRows_('CASE').filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myAgency && c['会社ID_B'] !== myAgency) return json_({ ok: false, error: 'この案件に投稿する権限がありません' });

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
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var myAgency = auth.user['会社ID'];

  var rows = readRows_('CASE');
  var c = rows.filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myAgency && c['会社ID_B'] !== myAgency) return json_({ ok: false, error: 'この案件を操作する権限がありません' });

  var status = String(body.status || '');
  if (['進行中', '完了', '保留'].indexOf(status) === -1) return json_({ ok: false, error: 'statusが不正です' });

  var patch = { '状態': status };
  if (status === '完了' && !c['経費提出状態']) patch['経費提出状態'] = '未提出';
  updateRow_('CASE', c._row, patch);
  logHistory_(body.investigatorId, 'case.updateStatus', c['案件ID'], { status: c['状態'] }, { status: status });
  return json_({ ok: true, status: status });
}

function caseMarkExpenseSubmitted_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var myAgency = auth.user['会社ID'];

  var rows = readRows_('CASE');
  var c = rows.filter(function (r) { return r['案件ID'] === String(body.caseId); })[0];
  if (!c) return json_({ ok: false, error: '案件が見つかりません' });
  if (c['会社ID_A'] !== myAgency && c['会社ID_B'] !== myAgency) return json_({ ok: false, error: 'この案件を操作する権限がありません' });

  updateRow_('CASE', c._row, { '経費提出状態': '提出済み' });
  logHistory_(body.investigatorId, 'case.expenseSubmitted', c['案件ID'], { expenseStatus: c['経費提出状態'] }, { expenseStatus: '提出済み' });
  return json_({ ok: true });
}

function feedRecent_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var myAgency = auth.user['会社ID'];

  var myCases = {};
  visibleCases_(myAgency).forEach(function (c) { myCases[c['案件ID']] = c; });

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });

  var list = readRows_('CASEMSG').filter(function (m) { return myCases[m['案件ID']]; }).map(function (m) {
    var poster = memberMap[m['投稿者調査員ID']] || {};
    var c = myCases[m['案件ID']];
    return {
      id: m['メッセージID'], caseId: m['案件ID'], caseTitle: c['案件名'],
      body: m['本文'], posterName: poster['氏名'] || '', posterCompanyName: agencyOf_(poster),
      postedAt: m['投稿日時'] ? String(m['投稿日時']) : '',
    };
  });
  list.sort(function (a, b) { return new Date(b.postedAt) - new Date(a.postedAt); });
  return json_({ ok: true, feed: list.slice(0, 50) });
}
