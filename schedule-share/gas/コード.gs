// コード.gs — doGet/doPostの入口・ルーティング

var SHARED_KEY = 'schedshare';
var VERSION = '2026-09-24a';

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}

  if (Array.isArray(body.events)) return handleLineWebhook_(body);

  if (body.key !== SHARED_KEY) return json_({ ok: false, error: 'キー不一致' });
  if (!throttleOk_()) return json_({ ok: false, error: '混み合っています。少し待ってください' });

  var routes = {
    'session.start': sessionStart_,
    'session.pickName': sessionPickName_,
    'calendar.get': calendarGet_,
    'schedule.set': idempotent_('sched', scheduleSet_),
    'line.linkStart': lineLinkStart_,
    'line.linkStatus': lineLinkStatus_,
    'case.list': caseList_,
    'case.create': idempotent_('case', caseCreate_),
    'case.claim': caseClaim_,
    'case.get': caseGet_,
    'case.message.post': idempotent_('cmsg', caseMessagePost_),
    'case.updateStatus': caseUpdateStatus_,
    'case.expenseSubmitted': caseMarkExpenseSubmitted_,
    'feed.recent': feedRecent_,
    'member.requestCode': memberRequestCode_,
    'member.verify': memberVerify_,
    'member.completeRegistration': memberCompleteRegistration_,
    'member.getProfile': memberGetProfile_,
    'member.updateProfile': memberUpdateProfile_,
    'member.avatarChoices': avatarChoices_,
    'member.listPublic': memberListPublic_,
    'friend.request': friendRequest_,
    'friend.respond': friendRespond_,
    'friend.list': friendList_,
    'dm.conversations': dmConversations_,
    'dm.thread': dmThread_,
    'dm.send': idempotent_('dm', dmSend_),
    'circle.list': circleList_,
    'circle.create': idempotent_('circle', circleCreate_),
    'circle.join': circleJoin_,
    'circle.get': circleGet_,
    'circle.post': idempotent_('cpost', circlePost_),
    'admin.setProp': adminSetProp_,
    'admin.getProps': adminGetProps_,
  };
  var fn = routes[body.mode];
  if (!fn) return json_({ ok: false, error: 'modeが不正です' });
  try {
    return fn(body);
  } catch (err) {
    console.log(err + '/' + (err && err.stack));
    return json_({ ok: false, error: '処理できませんでした' });
  }
}

function doGet(e) {
  var q = (e && e.parameter) || {};
  if (q.ping) return json_({ ok: true, version: VERSION });
  if (q.selftest && q.key === SHARED_KEY) return json_(selfTest_());
  return json_({ ok: false, error: 'GET用の公開エンドポイントはありません' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function throttleOk_() {
  var key = 'throttle:' + Math.floor(Date.now() / 1000);
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 5);
  return n <= 10; // 1秒あたり10リクエストまで
}

// submitIdがあれば21600秒だけ結果をキャッシュし、二重送信を無害化する
function idempotent_(prefix, fn) {
  return function (body) {
    var submitId = String(body.submitId || '');
    if (!submitId) return fn(body);
    var cache = CacheService.getScriptCache();
    var cacheKey = prefix + ':' + submitId;
    if (cache.get(cacheKey)) return json_({ ok: true, dedup: true });
    cache.put(cacheKey, '1', 21600);
    return fn(body);
  };
}

function selfTest_() {
  try {
    var ss = masterSpreadsheet_();
    ensureAllSheets_();
    return { ok: true, spreadsheetName: ss.getName(), companies: readRows_('COMPANY').length, users: readRows_('USER').length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
