// 小説.gs — 会員による小説投稿（連載形式。話ごとにNOVELCHAPTERへ追記）

function novelList_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });

  var chapterCount = {}, latestAt = {};
  readRows_('NOVELCHAPTER').forEach(function (c) {
    chapterCount[c['小説ID']] = (chapterCount[c['小説ID']] || 0) + 1;
    var at = c['投稿日時'] ? String(c['投稿日時']) : '';
    if (at && (!latestAt[c['小説ID']] || new Date(at) > new Date(latestAt[c['小説ID']]))) latestAt[c['小説ID']] = at;
  });

  var list = readRows_('NOVEL').map(function (n) {
    var author = memberMap[n['会員ID']] || {};
    return {
      id: n['小説ID'], title: n['タイトル'], synopsis: n['あらすじ'] || '',
      status: n['状態'] || '連載中', authorName: author['氏名'] || '(名無し)',
      chapterCount: chapterCount[n['小説ID']] || 0,
      updatedAt: latestAt[n['小説ID']] || (n['作成日時'] ? String(n['作成日時']) : ''),
      mine: n['会員ID'] === body.investigatorId,
    };
  });
  list.sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
  return json_({ ok: true, novels: list });
}

function novelCreate_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var title = String(body.title || '').trim();
  var synopsis = String(body.synopsis || '').trim();
  if (!title) return json_({ ok: false, error: 'タイトルを入力してください' });
  if (title.length > 60) return json_({ ok: false, error: 'タイトルは60文字以内にしてください' });
  if (synopsis.length > 500) return json_({ ok: false, error: 'あらすじは500文字以内にしてください' });

  var ids = readRows_('NOVEL').map(function (n) { return n['小説ID']; });
  var newId = nextId_('NV', 4, ids);
  appendRow_('NOVEL', {
    '小説ID': newId, '会員ID': body.investigatorId, 'タイトル': title,
    'あらすじ': synopsis, '状態': '連載中', '作成日時': new Date(),
  });
  return json_({ ok: true, id: newId });
}

function novelGet_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var novelId = String(body.novelId || '');
  var n = readRows_('NOVEL').filter(function (r) { return r['小説ID'] === novelId; })[0];
  if (!n) return json_({ ok: false, error: '小説が見つかりません' });

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });
  var author = memberMap[n['会員ID']] || {};

  var chapters = readRows_('NOVELCHAPTER').filter(function (c) { return c['小説ID'] === novelId; }).map(function (c) {
    return { id: c['話ID'], order: Number(c['話数']), title: c['タイトル'] || '', postedAt: c['投稿日時'] ? String(c['投稿日時']) : '' };
  });
  chapters.sort(function (a, b) { return a.order - b.order; });

  return json_({
    ok: true, id: n['小説ID'], title: n['タイトル'], synopsis: n['あらすじ'] || '', status: n['状態'] || '連載中',
    authorName: author['氏名'] || '(名無し)', mine: n['会員ID'] === body.investigatorId, chapters: chapters,
  });
}

function novelChapterGet_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var chapterId = String(body.chapterId || '');
  var c = readRows_('NOVELCHAPTER').filter(function (r) { return r['話ID'] === chapterId; })[0];
  if (!c) return json_({ ok: false, error: '話が見つかりません' });
  return json_({
    ok: true, id: c['話ID'], novelId: c['小説ID'], order: Number(c['話数']),
    title: c['タイトル'] || '', body: c['本文'] || '', postedAt: c['投稿日時'] ? String(c['投稿日時']) : '',
  });
}

function novelChapterPost_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var novelId = String(body.novelId || '');
  var n = readRows_('NOVEL').filter(function (r) { return r['小説ID'] === novelId; })[0];
  if (!n) return json_({ ok: false, error: '小説が見つかりません' });
  if (n['会員ID'] !== body.investigatorId) return json_({ ok: false, error: 'この小説に投稿できるのは作者のみです' });

  var text = String(body.body || '').trim();
  if (!text) return json_({ ok: false, error: '本文を入力してください' });
  if (text.length > 20000) return json_({ ok: false, error: '本文は20000文字以内にしてください' });
  var title = String(body.title || '').trim();
  if (title.length > 60) return json_({ ok: false, error: 'タイトルは60文字以内にしてください' });

  var existing = readRows_('NOVELCHAPTER').filter(function (r) { return r['小説ID'] === novelId; });
  var order = existing.length + 1;
  var ids = readRows_('NOVELCHAPTER').map(function (r) { return r['話ID']; });
  var newId = nextId_('CH', 5, ids);
  appendRow_('NOVELCHAPTER', {
    '話ID': newId, '小説ID': novelId, '話数': order,
    'タイトル': title || ('第' + order + '話'), '本文': text, '投稿日時': new Date(),
  });
  return json_({ ok: true, id: newId, order: order });
}

function novelUpdateStatus_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var novelId = String(body.novelId || '');
  var n = readRows_('NOVEL').filter(function (r) { return r['小説ID'] === novelId; })[0];
  if (!n) return json_({ ok: false, error: '小説が見つかりません' });
  if (n['会員ID'] !== body.investigatorId) return json_({ ok: false, error: '作者のみ変更できます' });

  var status = String(body.status || '');
  if (['連載中', '完結'].indexOf(status) === -1) return json_({ ok: false, error: 'statusが不正です' });
  updateRow_('NOVEL', n._row, { '状態': status });
  return json_({ ok: true, status: status });
}
