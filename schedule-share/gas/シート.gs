// シート.gs — マスタスプレッドシートへのDBアクセス層

var SHEETS_ = {
  COMPANY:   { name: '会社マスタ',     header: ['会社ID','会社名','会社コード','区分','状態','担当者名','担当者連絡先','登録日時','備考'] },
  USER:      { name: '調査員マスタ',   header: ['調査員ID','会社ID','氏名','状態','LINEユーザーID','LINE連携日時','登録日時','最終アクセス日時','備考'] },
  SCHEDULE:  { name: 'スケジュール',   header: ['日付','調査員ID','状態','メモ','更新者調査員ID','更新日時'] },
  LINECODE:  { name: 'LINE連携コード', header: ['コード','調査員ID','発行日時','有効期限','使用日時'] },
  NOTIFYLOG: { name: '通知ログ',       header: ['送信日時','宛先調査員ID','種別','本文','関連日付','LINE応答コード'] },
  HISTORY:   { name: '変更履歴',       header: ['日時','操作者調査員ID','操作種別','対象ID','変更前','変更後'] },
  CASE:      { name: '案件',     header: ['案件ID','案件名','会社ID_A','会社ID_B','状態','担当者調査員ID','経費提出状態','作成者調査員ID','作成日時','備考'] },
  CASEMSG:   { name: '案件メッセージ', header: ['メッセージID','案件ID','投稿者調査員ID','本文','投稿日時'] },
  // メール会員登録（たたき台。会社との紐付けは未実装）
  MEMBER:    { name: '会員',     header: ['会員ID','メールアドレス','氏名','アバター','ひとこと','自己紹介','登録日時','最終ログイン日時','事務所名','探偵歴','使用可能機材','届出番号'] },
  MEMBERCODE:{ name: '会員確認コード', header: ['コード','メールアドレス','発行日時','有効期限','使用日時'] },
  DM:        { name: 'DM',       header: ['メッセージID','送信者会員ID','受信者会員ID','本文','送信日時','既読日時'] },
  CIRCLE:    { name: 'サークル', header: ['サークルID','サークル名','説明','作成者会員ID','作成日時'] },
  CIRCLEMEMBER: { name: 'サークル参加', header: ['サークルID','会員ID','参加日時'] },
  CIRCLEPOST: { name: 'サークル投稿', header: ['投稿ID','サークルID','投稿者会員ID','本文','投稿日時'] },
  FRIEND:    { name: '友達',     header: ['申請ID','申請者会員ID','相手会員ID','状態','申請日時','承認日時'] },
  SUBJECT:   { name: '対象者', header: [
    '対象者ID','案件ID','順番','氏名','生年月日','年齢','婚姻期間','居住状況','続柄',
    '自宅住所','家族構成','自宅駐車場','別居先住所',
    '勤務先名称','勤務先業種','役職','勤務先住所','勤務先駐車場','通勤手段',
    '自転車情報','バイク情報','普段の移動手段','実家住所',
    '身長','体型','髪型','メガネ','マスク','帽子','喫煙','指輪','携帯色','その他情報',
    '登録者会員ID','登録日時','更新日時',
  ] },
  VEHICLE:   { name: '車両',     header: ['車両ID','対象者ID','メーカー','車種','色','ナンバー','登録日時'] },
  // 将来拡張用（今回はスキーマのみ作成、UI/APIは未実装）
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
