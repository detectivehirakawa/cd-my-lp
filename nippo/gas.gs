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
const VERSION = '2026-09-08c';   // 「デプロイした版が反映されているか」を外から確かめるための目印

/* ---- AI応答（Claude API）の設定 ----
 * スクリプトプロパティ ANTHROPIC_API_KEY が必要（console.anthropic.com で発行）。
 * 未設定なら AI応答だけが無効になり、日報送信と地図変換はそのまま動く。
 */
const AI_MODEL = 'claude-sonnet-5';   // 入力$2/出力$10 per 1Mトークン。claude-opus-5 に変えるとより高性能（$5/$25）
const AI_EFFORT = 'medium';      // LINEは待たされるので chat 向けに抑えている（high にすると熟考するが遅い）
const AI_MAX_TOKENS = 8000;      // 思考トークンも含む上限。見える返信の長さは指示文で抑える
const AI_DAILY_LIMIT = 50;       // 1日の呼び出し上限（暴走と課金事故の防止）
const AI_HISTORY_TURNS = 6;      // グループごとに覚えておく往復数（発言6件＝3往復）
const AI_TRIGGER_WORDS = ['探偵AI', '探偵ai'];   // メンションが取れない端末向けの予備トリガー

// グループに招待されたときのあいさつ文
const GREETING = 'こんにちは、探偵AIが調査のサポートをいたします、よろしくお願いいたします';

// 調査日報を送ってよいグループ名。これ以外のグループは送信先にしない。
// 比較時に 【】・空白・全角半角の違いは無視するので「【ラクーン　経費報告】」でも一致する。
const ALLOWED_GROUP_NAME = 'ラクーン　経費報告';

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  if (Array.isArray(body.events)) return handleLineWebhook_(body);
  return handleReport_(body);
}

function doGet(e) {
  const p = PropertiesService.getScriptProperties();
  const q = (e && e.parameter) || {};

  // 動作確認用: <exec URL>?key=nippo&maptest=<GoogleマップのURL>
  // LINEを経由せずに、リンクの展開結果と返信文だけを確認できる。
  if (q.maptest) {
    if (q.key !== SHARED_KEY) return json_({ ok: false, error: '認証キーが一致しません' });
    const expanded = expandUrl_(q.maptest);
    const info = parseMapUrl_(expanded);
    return json_({
      ok: true,
      version: VERSION,
      expanded: expanded,
      parsed: { name: info.name, lat: info.lat, lng: info.lng, qtext: info.qtext },
      reply: mapLinkReply_(q.maptest, true)
    });
  }

  // 動作確認用: <exec URL>?key=nippo&aitest=<質問>
  // LINEを経由せずにAIの返答だけを確認できる（1回分の呼び出しを消費する）
  if (q.aitest) {
    if (q.key !== SHARED_KEY) return json_({ ok: false, error: '認証キーが一致しません' });
    if (!p.getProperty('ANTHROPIC_API_KEY')) return json_({ ok: false, error: 'ANTHROPIC_API_KEY が未設定です' });
    if (!bumpAiCount_()) return json_({ ok: false, error: '本日の上限に達しました' });
    const t0 = Date.now();
    const answer = askClaude_(String(q.aitest), []);
    return json_({
      ok: !!answer, version: VERSION, model: AI_MODEL, effort: AI_EFFORT,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      answer: answer
    });
  }

  // 動作確認用: <exec URL>?key=nippo&groupinfo=1
  // 現在の送信先グループの名前をLINEに問い合わせる（グループ名で制限をかけるための下調べ）
  if (q.groupinfo) {
    if (q.key !== SHARED_KEY) return json_({ ok: false, error: '認証キーが一致しません' });
    const gid = p.getProperty('GROUP_ID');
    const token = p.getProperty('CHANNEL_ACCESS_TOKEN');
    if (!gid || !token) return json_({ ok: false, error: 'GROUP_ID か トークンが未設定です' });
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/group/' + encodeURIComponent(gid) + '/summary', {
      method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    return json_({
      ok: true, version: VERSION, groupId: gid,
      httpCode: res.getResponseCode(),
      body: res.getContentText().slice(0, 500)
    });
  }

  const gid = p.getProperty('GROUP_ID');
  const dest = gid ? destinationOk_(gid) : { ok: false, name: null };
  return json_({
    ok: true,
    version: VERSION,
    mapReply: true,                 // 地図変換つきのコードが反映されていれば true
    tokenSet: !!p.getProperty('CHANNEL_ACCESS_TOKEN'),
    groupSet: !!gid,
    groupName: dest.name,           // 現在の送信先グループの名前
    allowedGroupName: ALLOWED_GROUP_NAME,
    canSend: dest.ok,               // 日報を送れる状態か（送信先の名前が一致しているか）
    aiKeySet: !!p.getProperty('ANTHROPIC_API_KEY'),
    aiModel: AI_MODEL,
    aiCallsToday: aiCountToday_(),
    aiDailyLimit: AI_DAILY_LIMIT,
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
      // 招待されたとき。あいさつを返し、グループ名が一致すれば日報の送信先にする。
      if (ev.type === 'join') {
        const set = setDestinationIfAllowed_(src.groupId);
        reply_(ev.replyToken, GREETING + (set.ok ? '\n（このグループを調査日報の送信先に設定しました）' : ''));
        return;
      }
      if (text === '日報送信先') {
        const set = setDestinationIfAllowed_(src.groupId);
        reply_(ev.replyToken, set.ok
          ? 'このグループを調査日報の送信先に設定しました。'
          : '日報の送信先にできるのは「' + ALLOWED_GROUP_NAME + '」のグループだけです。\n'
            + 'このグループ名: ' + (set.name || '（取得できませんでした）'));
        return;
      }
    }

    // 2) 地図の共有 → 「名称／所在地：〜」に変換して返信
    //    グループの誰の投稿でも反応する（送信者による絞り込みはしない）。
    //    トークルーム・1:1 でも同じように動く。
    if (ev.type !== 'message' || !ev.message) return;

    // 2-a) LINEの「位置情報」メッセージ（URLではなくピンで共有された場合）
    if (ev.message.type === 'location') {
      const block = locationReply_(ev.message);
      if (block) reply_(ev.replyToken, block);
      return;
    }

    // 2-b) 本文に貼られた Googleマップのリンク
    if (ev.message.type !== 'text' || !text) return;
    const urls = findMapUrls_(text);
    if (urls.length) {
      const blocks = [];
      urls.forEach(function (u) {
        const b = mapLinkReply_(u);
        if (b) blocks.push(b);
      });
      if (blocks.length) {
        reply_(ev.replyToken, blocks.join('\n\n'));
        return;
      }
    }

    // 3) 公式アカウントが名指しされたらAIが答える
    //    グループ/トークルーム: メンション（または「探偵AI」で始まる発言）のとき
    //    1:1トーク: すべての発言
    const oneToOne = src.type === 'user';
    if (!oneToOne && !addressedToBot_(ev.message)) return;
    aiReply_(ev, text, src);
  });
  return json_({ ok: true });
}

/* ================= AI応答（Claude API） =================
 * 名指しされたときだけ Claude に投げて、その答えを返信する。
 * 呼び出しは UrlFetchApp からの直接HTTP（GASには Anthropic SDK が入れられない）。
 */

/** この発言は公式アカウント宛てか（メンション、または予備トリガー） */
function addressedToBot_(msg) {
  const mentionees = (msg.mention && msg.mention.mentionees) || [];
  const selfId = botUserId_();
  for (let i = 0; i < mentionees.length; i++) {
    const m = mentionees[i];
    if (m.isSelf === true) return true;                       // 公式アカウント自身へのメンション
    if (selfId && m.type === 'user' && m.userId === selfId) return true;
    // type === 'all'（@all）は名指しとみなさない
  }
  const head = String(msg.text || '').replace(/^[\s　]+/, '');
  return AI_TRIGGER_WORDS.some(function (w) { return head.indexOf(w) === 0; });
}

/** 公式アカウント自身の userId（1日キャッシュ） */
function botUserId_() {
  const p = PropertiesService.getScriptProperties();
  const saved = p.getProperty('BOT_USER_ID');
  if (saved) return saved;
  const token = p.getProperty('CHANNEL_ACCESS_TOKEN');
  if (!token) return '';
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return '';
    const id = JSON.parse(res.getContentText()).userId || '';
    if (id) p.setProperty('BOT_USER_ID', id);
    return id;
  } catch (err) {
    return '';
  }
}

/** AIに答えさせて返信する */
function aiReply_(ev, text, src) {
  const cache = CacheService.getScriptCache();
  const msgId = (ev.message && ev.message.id) || '';

  // LINEは応答が遅いと同じイベントを再送してくるので、二重返信を防ぐ
  if (msgId) {
    if (cache.get('ai:done:' + msgId)) return;
    cache.put('ai:done:' + msgId, '1', 300);
  }

  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('ANTHROPIC_API_KEY')) {
    reply_(ev.replyToken, 'AI応答はまだ設定されていません。'
      + '（管理者向け: GASのスクリプトプロパティに ANTHROPIC_API_KEY を追加してください）');
    return;
  }
  if (!bumpAiCount_()) {
    reply_(ev.replyToken, '本日のAI応答の上限（' + AI_DAILY_LIMIT + '回）に達しました。日をまたぐと再開します。');
    return;
  }

  // メンション部分（@探偵AI など）は質問文から外す
  const question = stripMentions_(ev.message).trim() || text;
  const convKey = 'ai:hist:' + (src.groupId || src.roomId || src.userId || 'unknown');
  const history = readHistory_(cache, convKey);

  const answer = askClaude_(question, history);
  if (!answer) {
    reply_(ev.replyToken, 'うまく応答できませんでした。少し時間をおいてもう一度お試しください。');
    return;
  }
  reply_(ev.replyToken, answer.slice(0, 4900));
  writeHistory_(cache, convKey, history.concat([
    { role: 'user', content: question },
    { role: 'assistant', content: answer }
  ]));
}

/** Claude に問い合わせて本文を返す。失敗したら '' */
function askClaude_(question, history) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const messages = history.concat([{ role: 'user', content: question }]);
  const payload = {
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    system: AI_SYSTEM_PROMPT_(),
    output_config: { effort: AI_EFFORT },
    messages: messages
  };
  const headers = {
    'x-api-key': key,
    'anthropic-version': '2023-06-01'
  };
  // 安全側の判断で断られたときに代替モデルでやり直す指定。
  // 受け付けるモデルが限られている（Opus 5 / Fable 系）ので、それ以外では付けない。
  if (/^claude-(opus-5|fable-5)/.test(AI_MODEL)) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let res;
  try {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    return '';
  }
  if (res.getResponseCode() !== 200) {
    console.log('Claude API エラー ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    return '';
  }

  let body;
  try { body = JSON.parse(res.getContentText()); } catch (err) { return ''; }

  // content を読む前に stop_reason を見る（安全側の判断で断られた場合がある）
  if (body.stop_reason === 'refusal') {
    return 'この内容にはお答えできませんでした。別の聞き方でお試しください。';
  }
  const text = (body.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n')
    .trim();
  if (!text) return '';
  return body.stop_reason === 'max_tokens' ? text + '\n（長くなったため省略しました）' : text;
}

/** AIへの指示文 */
function AI_SYSTEM_PROMPT_() {
  return [
    'あなたは探偵事務所（合同会社EXE RESEARCH／ラクーン探偵社）の調査員を支援するアシスタントで、',
    'LINEグループから呼ばれて答えます。名前は「探偵AI」です。',
    '',
    '答え方',
    '- 日本語の敬体で、結論から先に書く。目安は200〜400字。長い前置きや復唱はしない。',
    '- LINEでは装飾が効かないので、Markdownの見出しや太字（#、**）は使わない。箇条書きは「・」で最小限。',
    '- Latency-sensitive; begin your visible answer immediately.',
    '- 事実が確認できないことは推測で埋めず、「確認が必要」と伝えて確認方法を示す。',
    '- 相手は現場の調査員。実務で使える具体的な手順や判断材料を出す。',
    '',
    '扱う内容',
    '- 調査日報の書き方、経費（ガソリン代・高速代・電車代）の計算、時間の締め方の相談。',
    '- 尾行・張り込み・車両移動などの一般的な段取り、装備、天候や交通の判断。',
    '- 報告書の表現、依頼者への説明の言い回し。',
    '- 探偵業法や個人情報の取り扱いなど、一般的な注意点（法律の最終判断は弁護士の確認が必要と伝える）。',
    '',
    '守ること',
    '- 違法・不正な手段（無断のGPS取り付け、住居侵入、なりすまし、通信やアカウントへの不正アクセス、',
    '  戸籍や住民票の不正取得、盗聴など）の具体的な手順は案内しない。',
    '  代わりに合法的な代替手段や、必要な手続き・許可の取り方を示す。',
    '- 依頼者や対象者の個人情報を、聞かれていないのに書き出したり推測したりしない。',
    '',
    '社内の道具',
    '- 調査日報フォーム: https://lp.exeresearch.jp/nippo/ （入力すると日報の文面ができ、',
    '  「LINEグループに送信」で「ラクーン　経費報告」のグループに投稿される）',
    '- このグループにGoogleマップのリンクや位置情報を貼ると、名称と所在地に変換して返す。'
  ].join('\n');
}

/** メンション（@探偵AI など）を本文から取り除く */
function stripMentions_(msg) {
  let text = String((msg && msg.text) || '');
  const mentionees = (msg && msg.mention && msg.mention.mentionees) || [];
  // 後ろから消さないと index がずれる
  mentionees.slice().sort(function (a, b) { return (b.index || 0) - (a.index || 0); })
    .forEach(function (m) {
      if (typeof m.index !== 'number' || typeof m.length !== 'number') return;
      text = text.slice(0, m.index) + text.slice(m.index + m.length);
    });
  AI_TRIGGER_WORDS.forEach(function (w) {
    text = text.replace(new RegExp('^[\\s　]*' + w + '[\\s　、,:：]*'), '');
  });
  return text;
}

function readHistory_(cache, key) {
  try {
    const raw = cache.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(-AI_HISTORY_TURNS) : [];
  } catch (err) {
    return [];
  }
}

function writeHistory_(cache, key, arr) {
  try { cache.put(key, JSON.stringify(arr.slice(-AI_HISTORY_TURNS)), 1800); } catch (err) { /* 履歴は無くても動く */ }
}

/** 1日の呼び出し回数を数える。上限内なら true */
function bumpAiCount_() {
  const p = PropertiesService.getScriptProperties();
  const key = 'AI_COUNT_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const n = Number(p.getProperty(key) || '0') + 1;
  if (n > AI_DAILY_LIMIT) return false;
  p.setProperty(key, String(n));
  return true;
}

function aiCountToday_() {
  const key = 'AI_COUNT_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  return Number(PropertiesService.getScriptProperties().getProperty(key) || '0');
}

/* ================= 送信先グループの制限 =================
 * 日報は「ALLOWED_GROUP_NAME」のグループにだけ送る。
 * グループ名は LINE の `GET /v2/bot/group/{groupId}/summary` で取得する（実測で200が返る）。
 * 名前を確認できたときだけ送信先として登録するので、保存済みの送信先は必ず確認済み。
 */

/** 比較用にグループ名をそろえる（【】・空白・全角半角の違いを無視する） */
function normName_(s) {
  let t = String(s || '');
  try { t = t.normalize('NFKC'); } catch (err) { /* 旧ランタイム対策 */ }
  return t.replace(/[【】\[\]\s　]/g, '').toLowerCase();
}

/** グループ名をLINEに問い合わせる。取得できないときは null */
function fetchGroupName_(groupId) {
  const token = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
  if (!token || !groupId) return null;
  try {
    const res = UrlFetchApp.fetch(
      'https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/summary',
      { method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText()).groupName || null;
  } catch (err) {
    return null;
  }
}

/** グループ名が一致すれば送信先として保存する。{ok, name} を返す */
function setDestinationIfAllowed_(groupId) {
  const name = fetchGroupName_(groupId);
  // 名前を確認できないときは送信先を変えない（誤ったグループに日報が流れるのを防ぐ）
  if (name === null || normName_(name) !== normName_(ALLOWED_GROUP_NAME)) {
    return { ok: false, name: name };
  }
  const p = PropertiesService.getScriptProperties();
  p.setProperty('GROUP_ID', groupId);
  p.setProperty('GROUP_NAME', name);
  return { ok: true, name: name };
}

/** 送信直前の確認。名前が引けなければ登録時に確認済みの名前を信用して通す */
function destinationOk_(groupId) {
  const saved = PropertiesService.getScriptProperties().getProperty('GROUP_NAME');
  const name = fetchGroupName_(groupId);
  if (name === null) {
    return { ok: !!saved && normName_(saved) === normName_(ALLOWED_GROUP_NAME), name: saved, checked: false };
  }
  return { ok: normName_(name) === normName_(ALLOWED_GROUP_NAME), name: name, checked: true };
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
  const out = formatPlace_(name, addr);
  if (out && addr) cache.put(key, out, 21600);           // 成功時のみ6時間キャッシュ
  return out;
}

/**
 * LINEの「位置情報」メッセージ → 名称＋所在地。
 * ピンで共有された場合はURLが無いので、メッセージに入っている title / address / 緯度経度を使う。
 * title・address は付かないことがある（地図を長押しした素のピンなど）。
 */
function locationReply_(msg) {
  let name = String(msg.title || '').trim();
  if (isAddressLike_(name) || /^(現在地|位置情報|マイロケーション|my location|location)$/i.test(name)) name = '';
  let addr = cleanAddress_(msg.address || '');
  const lat = typeof msg.latitude === 'number' ? msg.latitude : null;
  const lng = typeof msg.longitude === 'number' ? msg.longitude : null;
  if (!addr && lat !== null && lng !== null) {
    addr = lookupAddress_({ name: name, lat: lat, lng: lng, qtext: '' });
  }
  return formatPlace_(name, addr);
}

/** 「名称＼n所在地：〜」の形に整える。どちらも無ければ '' で無反応にする */
function formatPlace_(name, addr) {
  if (!name && !addr) return '';
  const lines = [];
  if (name) lines.push(name);
  lines.push('所在地：' + (addr || '取得できませんでした'));
  return lines.join('\n');
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
  if (!groupId) {
    return json_({ ok: false, error: '送信先グループが未設定です。公式LINEを「'
      + ALLOWED_GROUP_NAME + '」のグループに招待してください' });
  }

  // 日報は ALLOWED_GROUP_NAME のグループにだけ送る
  const dest = destinationOk_(groupId);
  if (!dest.ok) {
    return json_({ ok: false, error: '送信先が「' + ALLOWED_GROUP_NAME + '」ではないため送信しませんでした'
      + '（現在の送信先: ' + (dest.name || '不明') + '）。'
      + '公式LINEを「' + ALLOWED_GROUP_NAME + '」に招待するか、そのグループで「日報送信先」と送ってください' });
  }

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
