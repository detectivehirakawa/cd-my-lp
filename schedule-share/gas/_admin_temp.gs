// _admin_temp.gs — 初期セットアップ用の一時ファイル。
// スクリプトプロパティ設定が終わったら削除してデプロイし直すこと。

var ADMIN_TEMP_KEY = 'acb45163bcb585066ebc3493b4e3f807';

function adminSetProp_(body) {
  if (body.adminKey !== ADMIN_TEMP_KEY) return json_({ ok: false, error: 'unauthorized' });
  if (!body.name || typeof body.value !== 'string') return json_({ ok: false, error: 'name/value が必要です' });
  PropertiesService.getScriptProperties().setProperty(body.name, body.value);
  return json_({ ok: true, name: body.name });
}

function adminGetProps_(body) {
  if (body.adminKey !== ADMIN_TEMP_KEY) return json_({ ok: false, error: 'unauthorized' });
  var props = PropertiesService.getScriptProperties().getProperties();
  var masked = {};
  Object.keys(props).forEach(function (k) {
    masked[k] = (k.indexOf('TOKEN') >= 0) ? props[k].slice(0, 6) + '...' : props[k];
  });
  return json_({ ok: true, props: masked });
}
