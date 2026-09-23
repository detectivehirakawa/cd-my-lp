// コード.gs — doGet/doPostの入口・ルーティング

var SHARED_KEY = 'schedshare';
var VERSION = '2026-09-23a';

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
    'schedule.set': scheduleSetIdempotent_,
    'line.linkStart': lineLinkStart_,
    'line.linkStatus': lineLinkStatus_,
    'notice.list': noticeList_,
    'notice.post': noticePostIdempotent_,
    'notice.pin': noticeTogglePin_,
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

function scheduleSetIdempotent_(body) {
  var submitId = String(body.submitId || '');
  if (submitId) {
    var cache = CacheService.getScriptCache();
    var cacheKey = 'sched:' + submitId;
    if (cache.get(cacheKey)) return json_({ ok: true, dedup: true });
    cache.put(cacheKey, '1', 21600);
  }
  return scheduleSet_(body);
}

function noticePostIdempotent_(body) {
  var submitId = String(body.submitId || '');
  if (submitId) {
    var cache = CacheService.getScriptCache();
    var cacheKey = 'notice:' + submitId;
    if (cache.get(cacheKey)) return json_({ ok: true, dedup: true });
    cache.put(cacheKey, '1', 21600);
  }
  return noticePost_(body);
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
