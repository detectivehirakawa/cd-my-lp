// シート.gs — マスタスプレッドシートへのDBアクセス層

var SHEETS_ = {
  COMPANY:   { name: '会社マスタ',     header: ['会社ID','会社名','会社コード','区分','状態','担当者名','担当者連絡先','登録日時','備考'] },
  USER:      { name: '調査員マスタ',   header: ['調査員ID','会社ID','氏名','状態','LINEユーザーID','LINE連携日時','登録日時','最終アクセス日時','備考'] },
  SCHEDULE:  { name: 'スケジュール',   header: ['日付','調査員ID','状態','メモ','更新者調査員ID','更新日時'] },
  LINECODE:  { name: 'LINE連携コード', header: ['コード','調査員ID','発行日時','有効期限','使用日時'] },
  NOTIFYLOG: { name: '通知ログ',       header: ['送信日時','宛先調査員ID','種別','本文','関連日付','LINE応答コード'] },
  HISTORY:   { name: '変更履歴',       header: ['日時','操作者調査員ID','操作種別','対象ID','変更前','変更後'] },
  // 将来拡張用（今回はスキーマのみ作成、UI/APIは未実装）
  NOTICE:    { name: 'お知らせ', header: ['お知らせID','対象範囲','タイトル','本文','投稿者調査員ID','投稿日時','固定表示'] },
  REPORT:    { name: '日報',     header: ['日報ID','調査員ID','対象日','案件名','稼働時間','経費合計','経費詳細JSON','報告本文','提出日時'] },
};

function masterSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('MASTER_SHEET_ID');
  if (!id) throw new Error('MASTER_SHEET_ID が未設定です');
  return SpreadsheetApp.openById(id);
}

function ensureSheet_(key) {
  var def = SHEETS_[key];
  var ss = masterSpreadsheet_();
  var sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.header.length).setValues([def.header]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureAllSheets_() {
  Object.keys(SHEETS_).forEach(function (k) { ensureSheet_(k); });
}

function readRows_(key) {
  var sh = ensureSheet_(key);
  var last = sh.getLastRow();
  var def = SHEETS_[key];
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, def.header.length).getValues();
  return values.map(function (row, i) {
    var obj = {};
    def.header.forEach(function (h, idx) { obj[h] = row[idx]; });
    obj._row = i + 2;
    return obj;
  });
}

function appendRow_(key, obj) {
  var sh = ensureSheet_(key);
  var def = SHEETS_[key];
  var row = def.header.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sh.appendRow(row);
  return sh.getLastRow();
}

function updateRow_(key, rowIndex, obj) {
  var sh = ensureSheet_(key);
  var def = SHEETS_[key];
  def.header.forEach(function (h, idx) {
    if (obj[h] !== undefined) sh.getRange(rowIndex, idx + 1).setValue(obj[h]);
  });
}

function nextId_(prefix, digits, existingIds) {
  var max = 0;
  existingIds.forEach(function (id) {
    var m = String(id).match(/^[A-Za-z]+0*(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = max + 1;
  var s = String(n);
  while (s.length < digits) s = '0' + s;
  return prefix + s;
}

function dateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v || '');
}

function logHistory_(actorId, action, targetId, before, after) {
  appendRow_('HISTORY', {
    '日時': new Date(),
    '操作者調査員ID': actorId,
    '操作種別': action,
    '対象ID': targetId,
    '変更前': JSON.stringify(before),
    '変更後': JSON.stringify(after),
  });
}
