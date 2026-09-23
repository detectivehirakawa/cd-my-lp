// スケジュール.gs — カレンダー取得・更新・リマインド

function calendarGet_(body) {
  var month = String(body.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return json_({ ok: false, error: 'monthは YYYY-MM 形式で指定してください' });

  var companies = readRows_('COMPANY').filter(function (c) { return c['状態'] !== '停止'; });
  var users = readRows_('USER').filter(function (u) { return u['状態'] !== '退職'; });
  var schedules = readRows_('SCHEDULE').filter(function (s) { return dateKey_(s['日付']).slice(0, 7) === month; });

  var byUser = {};
  schedules.forEach(function (s) {
    var dk = dateKey_(s['日付']);
    var uid = s['調査員ID'];
    byUser[uid] = byUser[uid] || {};
    byUser[uid][dk] = {
      status: s['状態'], memo: s['メモ'] || '',
      updatedBy: s['更新者調査員ID'] || '', updatedAt: s['更新日時'] ? String(s['更新日時']) : '',
    };
  });

  var result = companies.map(function (c) {
    return {
      companyId: c['会社ID'],
      companyName: c['会社名'],
      investigators: users.filter(function (u) { return u['会社ID'] === c['会社ID']; }).map(function (u) {
        return {
          investigatorId: u['調査員ID'], name: u['氏名'],
          lineLinked: !!u['LINEユーザーID'], days: byUser[u['調査員ID']] || {},
        };
      }),
    };
  });
  return json_({ ok: true, month: month, companies: result });
}

function scheduleSet_(body) {
  var auth = verifyCompanyCode_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '会社コードが確認できません' });

  var targetId = String(body.targetInvestigatorId || body.investigatorId);
  var date = String(body.date || '');
  var status = String(body.status || '');
  var memo = String(body.memo || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json_({ ok: false, error: 'dateは YYYY-MM-DD 形式で指定してください' });
  if (['空き', '確定', '不可', ''].indexOf(status) === -1) return json_({ ok: false, error: 'statusが不正です' });

  var targetUser = readRows_('USER').filter(function (u) { return u['調査員ID'] === targetId; })[0];
  if (!targetUser) return json_({ ok: false, error: '対象の調査員が見つかりません' });

  var rows = readRows_('SCHEDULE');
  var existing = rows.filter(function (r) {
    return r['調査員ID'] === targetId && dateKey_(r['日付']) === date;
  })[0];

  var before = existing ? { status: existing['状態'], memo: existing['メモ'] } : null;
  var now = new Date();
  if (existing) {
    updateRow_('SCHEDULE', existing._row, { '状態': status, 'メモ': memo, '更新者調査員ID': body.investigatorId, '更新日時': now });
  } else {
    appendRow_('SCHEDULE', { '日付': date, '調査員ID': targetId, '状態': status, 'メモ': memo, '更新者調査員ID': body.investigatorId, '更新日時': now });
  }
  logHistory_(body.investigatorId, 'schedule.set', targetId, before, { status: status, memo: memo });

  if (status === '確定' && body.investigatorId !== targetId && targetUser['LINEユーザーID']) {
    notifyConfirm_(targetUser, date, memo, auth.user['氏名'], auth.company['会社名']);
  }
  return json_({ ok: true, date: date, status: status, memo: memo });
}

function dailyReminder_() {
  var users = readRows_('USER').filter(function (u) { return u['状態'] !== '退職' && u['LINEユーザーID']; });
  var schedules = readRows_('SCHEDULE');
  var today = new Date();
  var dates = [0, 1, 2].map(function (d) {
    var dt = new Date(today.getTime() + d * 86400000);
    return Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy-MM-dd');
  });
  var todayKey = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM-dd');
  var sentLog = readRows_('NOTIFYLOG');

  users.forEach(function (u) {
    var already = sentLog.some(function (l) {
      return l['宛先調査員ID'] === u['調査員ID'] && l['種別'] === 'リマインド' &&
        Utilities.formatDate(new Date(l['送信日時']), 'Asia/Tokyo', 'yyyy-MM-dd') === todayKey;
    });
    if (already) return;

    var missing = dates.filter(function (d) {
      return !schedules.some(function (s) { return s['調査員ID'] === u['調査員ID'] && dateKey_(s['日付']) === d; });
    });
    if (missing.length === 0) return;

    var text = '直近3日間で未入力の予定があります。空き状況の入力をお願いします。\n' + missing.join(' / ');
    var res = push_(u['LINEユーザーID'], text);
    appendRow_('NOTIFYLOG', {
      '送信日時': new Date(), '宛先調査員ID': u['調査員ID'], '種別': 'リマインド',
      '本文': text, '関連日付': missing.join(','), 'LINE応答コード': res.code,
    });
  });
}

function setupDailyTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReminder_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyReminder_').timeBased().everyDays(1).atHour(9).create();
}
