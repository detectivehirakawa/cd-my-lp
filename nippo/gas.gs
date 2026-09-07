/**
 * 調査日報 → LINEグループ 自動送信（Google Apps Script）
 *
 * 役割
 *  1. 日報ページ（index.html）から POST された本文を、公式LINE（Messaging API）で
 *     指定の LINE グループへ push する。
 *  2. LINE の Webhook を受け取り、公式LINEが招待されたグループの groupId を自動で記憶する。
 *  3. 送信した日報を Google スプレッドシートに1行ずつ記録する（初回に自動作成）。
 *  4. グループに貼られた Googleマップのリンクを「名称＋所在地」に変換して返信する。
 *
 * 必要な設定（プロジェクトの設定 → スクリプト プロパティ）
 *  CHANNEL_ACCESS_TOKEN : LINE Developers の Messaging API チャネルの「チャネルアクセストークン（長期）」
 *  ※ GROUP_ID と SHEET_ID は自動で保存されるので手で入れなくてよい。
 *
 * デプロイ: 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *          実行するユーザー「自分」 / アクセスできるユーザー「全員」
 *          発行された URL（…/exec）を LINE の Webhook URL と index.html の AUTO_SEND_URL に設定する。
 */

const SHARED_KEY = 'nippo';      // index.html の AUTO_SEND_KEY と一致させる
const SHEET_NAME = '調査日報ログ';

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  if (Array.isArray(body.events)) return handleLineWebhook_(body);
  return handleReport_(body);
}

function doGet() {
  const p = PropertiesService.getScriptProperties();
  return json_({
    ok: true,
    tokenSet: !!p.getProperty('CHANNEL_ACCESS_TOKEN'),
    groupSet: !!p.getProperty('GROUP_ID'),
    sheetUrl: p.getProperty('SHEET_ID') ? 'https://docs.google.com/spreadsheets/d/' + p.getProperty('SHEET_ID') : null
  });
}

/* ---------- LINE Webhook: グループIDの記憶 ＋ マップリンク変換 ---------- */
function handleLineWebhook_(body) {
  const p = PropertiesService.getScriptProperties();
  body.events.forEach(function (ev) {
    const src = ev.source || {};
    const text = (ev.type === 'message' && ev.message && ev.message.type === 'text')
      ? String(ev.message.text || '').trim() : '';

    // 1) 送信先グループを記憶する
    if (src.type === 'group' && src.groupId) {
      if (ev.type === 'join') {
        p.setProperty('GROUP_ID', src.groupId);
        reply_(ev.replyToken, 'このグループに調査日報を自動送信します。\n'
          + 'Googleマップのリンクを貼ると、名称と所在地に変換して返信します。');
        return;
      }
      if (text === '日報送信先') {
        p.setProperty('GROUP_ID', src.groupId);
        reply_(ev.replyToken, 'このグループを調査日報の送信先に設定しました。');
        return;
      }
    }

    // 2) Googleマップのリンク → 「名称／所在地：〜」に変換して返信
    //    グループ・トークルーム・1:1 のいずれでも動く
    if (!text) return;
    const urls = findMapUrls_(text);
    if (!urls.length) return;
    const blocks = [];
    urls.forEach(function (u) {
      const b = mapLinkReply_(u);
      if (b) blocks.push(b);
    });
    if (blocks.length) reply_(ev.replyToken, blocks.join('\n\n'));
  });
  return json_({ ok: true });
}

/* ================= Googleマップのリンク → 名称＋所在地 =================
 * 仕組み（実測にもとづく）
 *  - maps.app.goo.gl / goo.gl/maps は 302 を返し、Location ヘッダに長いURLが入る。
 *    ページ本文（HTML）には名称も住所も入っていないので、必ずヘッダだけを見る。
 *  - 長いURLの形は主に次の3種類。
 *      a) /maps/place/<名称>/@<中心緯度>,<中心経度>,<倍率>/data=…!3d<緯度>!4d<経度>…
 *      b) maps.google.com?q=<〒＋住所＋名称>&ftid=…      （スマホの「リンクをコピー」）
 *      c) /maps/search/<緯度>,+<経度>                     （地点だけの共有。名称なし）
 *  - 住所は Apps Script の Maps サービス（APIキー不要・ジオコーディング 1,000回/日）で引く。
 */

/** 本文から Googleマップのリンクを抜き出す（最大3件） */
function findMapUrls_(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'　]+/g) || [];
  const out = [];
  found.forEach(function (raw) {
    const u = raw.replace(/[。、．，）)\]】」』>]+$/, '');
    if (!/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.google\.[a-z.]+|(?:www\.)?google\.[a-z.]+\/maps)/i.test(u)) return;
    if (out.indexOf(u) < 0) out.push(u);
  });
  return out.slice(0, 3);
}

/** 1本のリンクを「名称＋所在地」テキストにする。変換できないときは '' */
function mapLinkReply_(url, skipCache) {
  const cache = CacheService.getScriptCache();
  const key = 'map:' + Utilities.base64EncodeWebSafe(url).slice(0, 240);
  if (!skipCache) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const info = parseMapUrl_(expandUrl_(url));
  let name = info.name;
  if (name && isAddressLike_(name)) name = '';           // 住所そのものが名称欄に入っている場合
  if (!name && info.qtext) name = nameFromQText_(info.qtext);
  const addr = lookupAddress_(info);
  if (!name && !addr) return '';

  const lines = [];
  if (name) lines.push(name);
  lines.push('所在地：' + (addr || '取得できませんでした'));
  const out = lines.join('\n');
  if (addr) cache.put(key, out, 21600);                  // 成功時のみ6時間キャッシュ
  return out;
}

/** 短縮URLを展開する（Location ヘッダを最大6回たどる。本文は読まない） */
function expandUrl_(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    let res;
    try {
      res = UrlFetchApp.fetch(cur, {
        followRedirects: false,
        muteHttpExceptions: true,
        headers: { 'Accept-Language': 'ja' }
      });
    } catch (err) {
      return cur;
    }
    const code = res.getResponseCode();
    if (code < 300 || code >= 400) return cur;
    const h = res.getAllHeaders();
    let loc = h['Location'] || h['location'];
    if (!loc) return cur;
    if (Array.isArray(loc)) loc = loc[loc.length - 1];
    loc = String(loc);
    if (!/^https?:\/\//i.test(loc)) return cur;
    cur = loc;
  }
  return cur;
}

/** 長いURLから名称・座標・q文字列を取り出す */
function parseMapUrl_(url) {
  const info = { name: '', lat: null, lng: null, qtext: '', url: url };

  const mPlace = url.match(/\/maps\/place\/([^\/@?]+)/);
  if (mPlace) info.name = decodeParam_(mPlace[1]);

  // !3d/!4d は施設そのものの座標。@ は地図の中心なので次善。
  let m = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (!m) m = url.match(/[@\/](-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/);
  if (m) { info.lat = parseFloat(m[1]); info.lng = parseFloat(m[2]); }

  const mq = url.match(/[?&]q=([^&]+)/);
  if (mq) {
    const q = decodeParam_(mq[1]);
    const c = q.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
    if (c) {
      if (info.lat === null) { info.lat = parseFloat(c[1]); info.lng = parseFloat(c[2]); }
    } else {
      info.qtext = q;
    }
  }
  return info;
}

/** 住所を引く：①名称＋座標で正引き ②座標から逆引き ③文字列で検索 */
function lookupAddress_(info) {
  if (info.name && !isAddressLike_(info.name) && info.lat !== null) {
    const d = 0.03;   // 約3km四方に絞る（同名の施設を拾わないため）
    try {
      const r = Maps.newGeocoder().setLanguage('ja').setRegion('jp')
        .setBounds(info.lat - d, info.lng - d, info.lat + d, info.lng + d)
        .geocode(info.name);
      const hit = nearestResult_(r, info.lat, info.lng, 1500);
      if (hit) return cleanAddress_(hit.formatted_address);
    } catch (err) { /* 次の方法へ */ }
  }
  if (info.lat !== null) {
    try {
      const r = Maps.newGeocoder().setLanguage('ja').reverseGeocode(info.lat, info.lng);
      const hit = precise_(r);
      if (hit) return cleanAddress_(hit.formatted_address);
    } catch (err) { /* 次の方法へ */ }
  }
  const text = info.qtext || info.name;
  if (text) {
    try {
      const r = Maps.newGeocoder().setLanguage('ja').setRegion('jp').geocode(text);
      if (r && r.status === 'OK' && r.results && r.results.length) {
        return cleanAddress_(r.results[0].formatted_address);
      }
    } catch (err) { /* あきらめる */ }
  }
  return '';
}

/** 正引き結果のうち、指定座標に最も近く maxMeters 以内のもの */
function nearestResult_(r, lat, lng, maxMeters) {
  if (!r || r.status !== 'OK' || !r.results || !r.results.length) return null;
  let best = null, bestD = Infinity;
  r.results.forEach(function (res) {
    const loc = res.geometry && res.geometry.location;
    if (!loc) return;
    const d = distanceM_(lat, lng, loc.lat, loc.lng);
    if (d < bestD) { bestD = d; best = res; }
  });
  return bestD <= maxMeters ? best : null;
}

/** 逆引き結果から番地レベルのものを選ぶ（Plus Code は避ける） */
function precise_(r) {
  if (!r || r.status !== 'OK' || !r.results || !r.results.length) return null;
  const rank = ['premise', 'subpremise', 'street_address', 'establishment', 'point_of_interest'];
  for (let i = 0; i < rank.length; i++) {
    for (let j = 0; j < r.results.length; j++) {
      const t = r.results[j].types || [];
      if (t.indexOf(rank[i]) >= 0) return r.results[j];
    }
  }
  for (let j = 0; j < r.results.length; j++) {
    const t = r.results[j].types || [];
    if (t.indexOf('plus_code') < 0) return r.results[j];
  }
  return r.results[0];
}

function distanceM_(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 「日本、〒123-4567 東京都…」→「東京都…」 */
function cleanAddress_(a) {
  return String(a || '')
    .replace(/^日本[、,]\s*/, '')
    .replace(/^Japan,\s*/i, '')
    .replace(/^〒?\s*\d{3}-\d{4}\s*/, '')
    .trim();
}

/** URLパラメータを読める文字列に（+ を空白に、%xx を復号、異体字を正規化） */
function decodeParam_(s) {
  let out = String(s).replace(/\+/g, ' ');
  try { out = decodeURIComponent(out); } catch (err) { /* 壊れた%は原文のまま */ }
  try { out = out.normalize('NFC'); } catch (err) { /* 旧ランタイム対策 */ }
  return out.trim();
}

/** 施設名ではなく住所・座標・Plus Code に見えるか */
function isAddressLike_(s) {
  if (!s) return false;
  return /^〒?\s*\d{3}-?\d{4}/.test(s)                       // 郵便番号
    || /^(北海道|東京都|京都府|大阪府|.{2,3}県)/.test(s)      // 先頭が都道府県
    || /^[23456789CFGHJMPQRVWX]{4,}\+[23456789CFGHJMPQRVWX]{2,}/.test(s)  // Plus Code
    || /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(s);                 // 座標
}

/** 「〒240-0013 神奈川県… 701号室 ほぐし屋」の末尾から施設名を拾う */
function nameFromQText_(q) {
  const parts = String(q).replace(/^〒?\s*\d{3}-\d{4}\s*/, '').split(/[\s　]+/).filter(String);
  if (parts.length < 2) return '';
  const last = parts[parts.length - 1];
  // 末尾が住所の続き（番地・部屋番号・階）なら施設名とはみなさない
  if (/[0-9０-９]|号室|丁目|番地|階$|[FＦ]$/.test(last)) return '';
  return last;
}

/* ---------- 日報の受信 → LINE push + シート記録 ---------- */
function handleReport_(body) {
  if (body.key !== SHARED_KEY) return json_({ ok: false, error: '認証キーが一致しません' });
  const text = String(body.text || '').trim();
  if (!text) return json_({ ok: false, error: '本文が空です' });

  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('CHANNEL_ACCESS_TOKEN');
  const groupId = p.getProperty('GROUP_ID');
  if (!token) return json_({ ok: false, error: 'GAS に CHANNEL_ACCESS_TOKEN が設定されていません' });
  if (!groupId) return json_({ ok: false, error: '送信先グループが未設定です。公式LINEをグループに招待してください' });

  const header = body.sender ? '【' + body.sender + 'さんの日報】\n' : '';
  const messages = chunk_(header + text, 4900).slice(0, 5).map(function (t) { return { type: 'text', text: t }; });

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: groupId, messages: messages }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    return json_({ ok: false, error: 'LINE API エラー ' + code + ': ' + res.getContentText().slice(0, 200) });
  }

  try { logToSheet_(body, text); } catch (err) { /* ログ失敗は送信成功を妨げない */ }
  return json_({ ok: true });
}

function logToSheet_(body, text) {
  const p = PropertiesService.getScriptProperties();
  let ss;
  const id = p.getProperty('SHEET_ID');
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    p.setProperty('SHEET_ID', ss.getId());
    const sh = ss.getActiveSheet();
    sh.setName(SHEET_NAME);
    sh.appendRow(['送信日時', '調査日', '案件名', '送信者', '調査時間', '経費合計', '本文']);
    sh.setFrozenRows(1);
  }
  const sh = ss.getSheetByName(SHEET_NAME) || ss.getActiveSheet();
  sh.appendRow([new Date(), body.date || '', body.caseName || '', body.sender || '', body.hours || '', body.total || '', text]);
}

/* ---------- helpers ---------- */
function reply_(replyToken, text) {
  const token = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
  if (!token || !replyToken) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

function chunk_(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** エディタから手動実行してマップ変換だけ確認する用（LINEには送らない） */
function testMapLink() {
  const urls = [
    'https://maps.app.goo.gl/8FSsA4JwvbVSGZDy5',   // /maps/place/ 形式
    'https://maps.app.goo.gl/YJBqUGtbumCmt9aa7',   // ?q=住所＋名称 形式
    'https://maps.app.goo.gl/ofsuiRozC84e4xjv5'    // 座標だけの形式
  ];
  urls.forEach(function (u) {
    Logger.log(u + '\n→ ' + expandUrl_(u).slice(0, 160) + '\n=== 返信内容 ===\n' + mapLinkReply_(u, true) + '\n');
  });
}

/** エディタから手動実行して疎通確認する用（グループにテスト文が届く） */
function testSend() {
  const r = handleReport_({ key: SHARED_KEY, text: 'テスト送信（調査日報システム）', sender: 'テスト', date: '', caseName: 'テスト' });
  Logger.log(r.getContent());
}
