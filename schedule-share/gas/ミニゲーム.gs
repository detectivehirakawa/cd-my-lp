// ミニゲーム.gs — 10種のミニゲームの自己ベストスコア保存・ランキング取得
// dir: 'asc'=数値が小さいほど良い(タイム・手数系) / 'desc'=数値が大きいほど良い(得点系)
var GAME_DIRECTIONS_ = {
  reaction: 'asc', whackamole: 'desc', schulte: 'asc', memory: 'asc', tapchallenge: 'desc',
  snake: 'desc', simon: 'desc', catchgame: 'desc', slidepuzzle: 'asc', tailing: 'desc',
};

function gameScoreSubmit_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var gameId = String(body.gameId || '');
  var dir = GAME_DIRECTIONS_[gameId];
  if (!dir) return json_({ ok: false, error: 'gameIdが不正です' });
  var score = Number(body.score);
  if (!isFinite(score) || score < 0) return json_({ ok: false, error: 'scoreが不正です' });

  var rows = readRows_('GAMESCORE');
  var mine = rows.filter(function (r) { return r['ゲームID'] === gameId && r['会員ID'] === body.investigatorId; })[0];
  var prevBest = mine ? Number(mine['ベストスコア']) : null;
  var isNewBest = prevBest === null || (dir === 'asc' ? score < prevBest : score > prevBest);

  if (isNewBest) {
    if (mine) updateRow_('GAMESCORE', mine._row, { 'ベストスコア': score, '更新日時': new Date() });
    else appendRow_('GAMESCORE', { 'ゲームID': gameId, '会員ID': body.investigatorId, 'ベストスコア': score, '更新日時': new Date() });
  }
  return json_({ ok: true, best: isNewBest ? score : prevBest, isNewBest: isNewBest });
}

function gameRankingGet_(body) {
  var auth = verifyMemberForWork_(body.companyCode, body.investigatorId);
  if (!auth) return json_({ ok: false, error: '本人確認できませんでした' });

  var gameId = String(body.gameId || '');
  var dir = GAME_DIRECTIONS_[gameId];
  if (!dir) return json_({ ok: false, error: 'gameIdが不正です' });

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });

  var list = readRows_('GAMESCORE').filter(function (r) { return r['ゲームID'] === gameId; }).map(function (r) {
    var m = memberMap[r['会員ID']] || {};
    return {
      name: m['氏名'] || '(名無し)', avatar: m['アバター'] || '🕵️', agencyName: m['事務所名'] || '',
      score: Number(r['ベストスコア']), updatedAt: r['更新日時'] ? String(r['更新日時']) : '',
    };
  });
  list.sort(function (a, b) { return dir === 'asc' ? a.score - b.score : b.score - a.score; });
  return json_({ ok: true, ranking: list.slice(0, 20) });
}
