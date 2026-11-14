// 対象者.gs — 案件に紐づく対象者カルテ（複数人登録可）と車両情報

var SUBJECT_FIELDS_ = [
  '氏名','生年月日','年齢','婚姻期間','居住状況','続柄',
  '自宅住所','家族構成','自宅駐車場','別居先住所',
  '勤務先名称','勤務先業種','役職','勤務先住所','勤務先駐車場','通勤手段',
  '自転車情報','バイク情報','普段の移動手段','実家住所',
  '身長','体型','髪型','メガネ','マスク','帽子','喫煙','指輪','携帯色','その他情報',
];

function caseAccessible_(caseId, myAgency) {
  var c = readRows_('CASE').filter(function (r) { return r['案件ID'] === String(caseId); })[0];
  if (!c) return null;
  if (c['会社ID_A'] !== myAgency && c['会社ID_B'] !== myAgency) return null;
  return c;
}

function subjectToJson_(s) {
  var out = { id: s['対象者ID'], caseId: s['案件ID'], order: s['順番'] };
  SUBJECT_FIELDS_.forEach(function (f) { out[f] = s[f] || ''; });
  out.vehicles = readRows_('VEHICLE').filter(function (v) { return v['対象者ID'] === s['対象者ID']; }).map(function (v) {
    return { id: v['車両ID'], maker: v['メーカー'] || '', model: v['車種'] || '', color: v['色'] || '', plate: v['ナンバー'] || '' };
  });
  return out;
}

function subjectList_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });
  var c = caseAccessible_(body.caseId, auth.user['会社ID']);
  if (!c) return json_({ ok: false, error: 'この案件を見る権限がありません' });

  var list = readRows_('SUBJECT').filter(function (s) { return s['案件ID'] === String(body.caseId); }).map(subjectToJson_);
  list.sort(function (a, b) { return Number(a.order || 0) - Number(b.order || 0); });
  return json_({ ok: true, subjects: list });
}

function subjectGet_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var s = readRows_('SUBJECT').filter(function (r) { return r['対象者ID'] === String(body.subjectId); })[0];
  if (!s) return json_({ ok: false, error: '対象者が見つかりません' });
  var c = caseAccessible_(s['案件ID'], auth.user['会社ID']);
  if (!c) return json_({ ok: false, error: 'この対象者を見る権限がありません' });

  return json_(Object.assign({ ok: true }, subjectToJson_(s)));
}

function subjectSave_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var subjectId = String(body.subjectId || '');
  var patch = {};
  SUBJECT_FIELDS_.forEach(function (f) {
    if (body[f] !== undefined) patch[f] = String(body[f]).slice(0, 500);
  });
  if (!patch['氏名']) return json_({ ok: false, error: '対象者の氏名を入力してください' });

  if (subjectId) {
    var rows = readRows_('SUBJECT');
    var s = rows.filter(function (r) { return r['対象者ID'] === subjectId; })[0];
    if (!s) return json_({ ok: false, error: '対象者が見つかりません' });
    var c = caseAccessible_(s['案件ID'], auth.user['会社ID']);
    if (!c) return json_({ ok: false, error: 'この対象者を編集する権限がありません' });
    patch['更新日時'] = new Date();
    updateRow_('SUBJECT', s._row, patch);
    return json_({ ok: true, id: subjectId });
  }

  var caseId = String(body.caseId || '');
  var c2 = caseAccessible_(caseId, auth.user['会社ID']);
  if (!c2) return json_({ ok: false, error: 'この案件に対象者を追加する権限がありません' });

  var existing = readRows_('SUBJECT').filter(function (r) { return r['案件ID'] === caseId; });
  var order = existing.length + 1;
  var ids = readRows_('SUBJECT').map(function (r) { return r['対象者ID']; });
  var newId = nextId_('T', 5, ids);
  var now = new Date();
  patch['対象者ID'] = newId; patch['案件ID'] = caseId; patch['順番'] = order;
  patch['登録者会員ID'] = body.investigatorId; patch['登録日時'] = now; patch['更新日時'] = now;
  appendRow_('SUBJECT', patch);
  return json_({ ok: true, id: newId });
}

function vehicleAdd_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var subjectId = String(body.subjectId || '');
  var s = readRows_('SUBJECT').filter(function (r) { return r['対象者ID'] === subjectId; })[0];
  if (!s) return json_({ ok: false, error: '対象者が見つかりません' });
  var c = caseAccessible_(s['案件ID'], auth.user['会社ID']);
  if (!c) return json_({ ok: false, error: '権限がありません' });

  var maker = String(body.maker || '').trim();
  var model = String(body.model || '').trim();
  if (!maker && !model) return json_({ ok: false, error: 'メーカーか車種を入力してください' });

  var ids = readRows_('VEHICLE').map(function (v) { return v['車両ID']; });
  var newId = nextId_('V', 5, ids);
  appendRow_('VEHICLE', {
    '車両ID': newId, '対象者ID': subjectId, 'メーカー': maker, '車種': model,
    '色': String(body.color || '').trim(), 'ナンバー': String(body.plate || '').trim(), '登録日時': new Date(),
  });
  return json_({ ok: true, id: newId });
}

function vehicleRemove_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var rows = readRows_('VEHICLE');
  var v = rows.filter(function (r) { return r['車両ID'] === String(body.vehicleId); })[0];
  if (!v) return json_({ ok: false, error: '車両情報が見つかりません' });
  var s = readRows_('SUBJECT').filter(function (r) { return r['対象者ID'] === v['対象者ID']; })[0];
  if (s) {
    var c = caseAccessible_(s['案件ID'], auth.user['会社ID']);
    if (!c) return json_({ ok: false, error: '権限がありません' });
  }

  var sh = ensureSheet_('VEHICLE');
  sh.deleteRow(v._row);
  invalidateRows_('VEHICLE');
  return json_({ ok: true });
}
