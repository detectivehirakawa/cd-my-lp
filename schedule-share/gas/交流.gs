// 交流.gs — プロフィール／アバター、探偵同士のDM、サークル機能（たたき台）

var AVATAR_CHOICES_ = ['🕵️','🕵️‍♀️','🥷','🔍','🐱','🐶','🦊','🐻','🦉','🐧','🐢','🦄','🎩','🕶️','👻','🤖','👽','🐸','🐵','🦁','🐯','🐨','🐼','🦝'];

function memberBrief_(m) {
  return {
    memberId: m['会員ID'], name: m['氏名'] || '(名無し)', avatar: m['アバター'] || '🕵️',
    statusMsg: m['ひとこと'] || '', agencyName: m['事務所名'] || '',
  };
}

// ---- プロフィール ----
function memberGetProfile_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var target = String(body.targetMemberId || body.memberId || '');
  var m = readRows_('MEMBER').filter(function (r) { return r['会員ID'] === target; })[0];
  if (!m) return json_({ ok: false, error: '会員が見つかりません' });
  return json_({
    ok: true, memberId: m['会員ID'], name: m['氏名'] || '(名無し)', avatar: m['アバター'] || '🕵️',
    statusMsg: m['ひとこと'] || '', bio: m['自己紹介'] || '', joinedAt: m['登録日時'] ? String(m['登録日時']) : '',
    agencyName: m['事務所名'] || '', experience: m['探偵歴'] || '', equipment: m['使用可能機材'] || '', license: m['届出番号'] || '',
    memberNumber: m['会員番号'] || '',
  });
}

function memberUpdateProfile_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });

  var patch = {};
  if (body.name !== undefined) {
    var name = String(body.name).trim();
    if (!name) return json_({ ok: false, error: '氏名を入力してください' });
    if (name.length > 40) return json_({ ok: false, error: '氏名は40文字以内にしてください' });
    patch['氏名'] = name;
  }
  if (body.avatar !== undefined) {
    if (AVATAR_CHOICES_.indexOf(body.avatar) === -1) return json_({ ok: false, error: 'そのアバターは選べません' });
    patch['アバター'] = body.avatar;
  }
  if (body.statusMsg !== undefined) {
    var sm = String(body.statusMsg).slice(0, 40);
    patch['ひとこと'] = sm;
  }
  if (body.bio !== undefined) {
    var bio = String(body.bio).slice(0, 500);
    patch['自己紹介'] = bio;
  }
  updateRow_('MEMBER', me._row, patch);
  return json_({ ok: true });
}

function avatarChoices_(body) {
  return json_({ ok: true, avatars: AVATAR_CHOICES_ });
}

function memberListPublic_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var list = readRows_('MEMBER').filter(function (m) { return m['会員ID'] !== me['会員ID'] && m['氏名']; }).map(memberBrief_);
  return json_({ ok: true, members: list });
}

// ---- 友達申請 ----
function friendPairOf_(rows, a, b) {
  return rows.filter(function (r) {
    return (r['申請者会員ID'] === a && r['相手会員ID'] === b) || (r['申請者会員ID'] === b && r['相手会員ID'] === a);
  })[0];
}

function friendRequest_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var myId = me['会員ID'];
  var targetId = String(body.targetMemberId || '');
  if (!targetId || targetId === myId) return json_({ ok: false, error: '相手が正しくありません' });

  var target = readRows_('MEMBER').filter(function (m) { return m['会員ID'] === targetId; })[0];
  if (!target) return json_({ ok: false, error: '相手が見つかりません' });

  var rows = readRows_('FRIEND');
  var existing = friendPairOf_(rows, myId, targetId);
  if (existing) {
    if (existing['状態'] === '承認済み') return json_({ ok: true, alreadyFriend: true });
    if (existing['状態'] === '申請中') return json_({ ok: true, alreadyRequested: true });
  }

  var ids = rows.map(function (r) { return r['申請ID']; });
  var newId = nextId_('F', 6, ids);
  appendRow_('FRIEND', { '申請ID': newId, '申請者会員ID': myId, '相手会員ID': targetId, '状態': '申請中', '申請日時': new Date(), '承認日時': '' });
  return json_({ ok: true, id: newId });
}

function friendRespond_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var myId = me['会員ID'];
  var requestId = String(body.requestId || '');
  var accept = !!body.accept;

  var rows = readRows_('FRIEND');
  var req = rows.filter(function (r) { return r['申請ID'] === requestId; })[0];
  if (!req) return json_({ ok: false, error: '申請が見つかりません' });
  if (req['相手会員ID'] !== myId) return json_({ ok: false, error: 'この申請を操作する権限がありません' });
  if (req['状態'] !== '申請中') return json_({ ok: false, error: 'すでに処理済みです' });

  updateRow_('FRIEND', req._row, { '状態': accept ? '承認済み' : '拒否', '承認日時': accept ? new Date() : '' });
  return json_({ ok: true, status: accept ? '承認済み' : '拒否' });
}

function friendList_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var myId = me['会員ID'];

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });

  var rows = readRows_('FRIEND').filter(function (r) { return r['状態'] === '承認済み' && (r['申請者会員ID'] === myId || r['相手会員ID'] === myId); });
  var friends = rows.map(function (r) {
    var friendId = r['申請者会員ID'] === myId ? r['相手会員ID'] : r['申請者会員ID'];
    return memberBrief_(memberMap[friendId] || { '会員ID': friendId });
  });

  var pending = readRows_('FRIEND').filter(function (r) { return r['状態'] === '申請中' && r['相手会員ID'] === myId; }).map(function (r) {
    var requester = memberMap[r['申請者会員ID']] || {};
    var brief = memberBrief_(requester);
    brief.requestId = r['申請ID'];
    return brief;
  });

  var sent = readRows_('FRIEND').filter(function (r) { return r['状態'] === '申請中' && r['申請者会員ID'] === myId; }).map(function (r) {
    return memberBrief_(memberMap[r['相手会員ID']] || { '会員ID': r['相手会員ID'] });
  });

  return json_({ ok: true, friends: friends, pending: pending, sent: sent });
}

// ---- DM(1対1) ----
function dmConversations_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var myId = me['会員ID'];

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });

  var rows = readRows_('DM').filter(function (r) { return r['送信者会員ID'] === myId || r['受信者会員ID'] === myId; });
  var byPartner = {};
  rows.forEach(function (r) {
    var partnerId = r['送信者会員ID'] === myId ? r['受信者会員ID'] : r['送信者会員ID'];
    var cur = byPartner[partnerId];
    if (!cur || new Date(r['送信日時']) > new Date(cur['送信日時'])) byPartner[partnerId] = r;
  });

  var list = Object.keys(byPartner).map(function (partnerId) {
    var last = byPartner[partnerId];
    var partner = memberMap[partnerId] || {};
    var unread = rows.some(function (r) { return r['送信者会員ID'] === partnerId && r['受信者会員ID'] === myId && !r['既読日時']; });
    return {
      partnerId: partnerId, partnerName: partner['氏名'] || '(名無し)', partnerAvatar: partner['アバター'] || '🕵️',
      lastBody: String(last['本文']).slice(0, 30), lastAt: String(last['送信日時']), unread: unread,
    };
  });
  list.sort(function (a, b) { return new Date(b.lastAt) - new Date(a.lastAt); });
  return json_({ ok: true, conversations: list });
}

function dmThread_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var myId = me['会員ID'];
  var partnerId = String(body.partnerId || '');

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });
  var partner = memberMap[partnerId];
  if (!partner) return json_({ ok: false, error: '相手が見つかりません' });

  var rows = readRows_('DM').filter(function (r) {
    return (r['送信者会員ID'] === myId && r['受信者会員ID'] === partnerId) ||
           (r['送信者会員ID'] === partnerId && r['受信者会員ID'] === myId);
  });
  rows.sort(function (a, b) { return new Date(a['送信日時']) - new Date(b['送信日時']); });

  // 相手からの未読を既読にする
  rows.forEach(function (r) {
    if (r['受信者会員ID'] === myId && !r['既読日時']) updateRow_('DM', r._row, { '既読日時': new Date() });
  });

  var messages = rows.map(function (r) {
    return { body: r['本文'], sentAt: String(r['送信日時']), mine: r['送信者会員ID'] === myId };
  });
  return json_({ ok: true, partnerName: partner['氏名'] || '(名無し)', partnerAvatar: partner['アバター'] || '🕵️', messages: messages });
}

function dmSend_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var myId = me['会員ID'];
  var partnerId = String(body.partnerId || '');
  var text = String(body.body || '').trim();
  if (!text) return json_({ ok: false, error: '本文を入力してください' });
  if (text.length > 1000) return json_({ ok: false, error: '本文は1000文字以内にしてください' });

  var partner = readRows_('MEMBER').filter(function (m) { return m['会員ID'] === partnerId; })[0];
  if (!partner) return json_({ ok: false, error: '相手が見つかりません' });

  var ids = readRows_('DM').map(function (m) { return m['メッセージID']; });
  var newId = nextId_('D', 6, ids);
  appendRow_('DM', { 'メッセージID': newId, '送信者会員ID': myId, '受信者会員ID': partnerId, '本文': text, '送信日時': new Date(), '既読日時': '' });
  return json_({ ok: true, id: newId });
}

// ---- サークル ----
function circleList_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var myId = me['会員ID'];

  var joined = {};
  readRows_('CIRCLEMEMBER').forEach(function (r) { if (r['会員ID'] === myId) joined[r['サークルID']] = true; });
  var memberCounts = {};
  readRows_('CIRCLEMEMBER').forEach(function (r) { memberCounts[r['サークルID']] = (memberCounts[r['サークルID']] || 0) + 1; });

  var list = readRows_('CIRCLE').map(function (c) {
    return {
      id: c['サークルID'], name: c['サークル名'], description: c['説明'] || '',
      memberCount: memberCounts[c['サークルID']] || 0, joined: !!joined[c['サークルID']],
      createdAt: c['作成日時'] ? String(c['作成日時']) : '',
    };
  });
  list.sort(function (a, b) { return b.memberCount - a.memberCount; });
  return json_({ ok: true, circles: list });
}

function circleCreate_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });

  var name = String(body.name || '').trim();
  var description = String(body.description || '').trim();
  if (!name) return json_({ ok: false, error: 'サークル名を入力してください' });
  if (name.length > 40) return json_({ ok: false, error: 'サークル名は40文字以内にしてください' });

  var ids = readRows_('CIRCLE').map(function (c) { return c['サークルID']; });
  var newId = nextId_('S', 4, ids);
  appendRow_('CIRCLE', { 'サークルID': newId, 'サークル名': name, '説明': description, '作成者会員ID': me['会員ID'], '作成日時': new Date() });
  appendRow_('CIRCLEMEMBER', { 'サークルID': newId, '会員ID': me['会員ID'], '参加日時': new Date() });
  return json_({ ok: true, id: newId });
}

function circleJoin_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var circleId = String(body.circleId || '');

  var circle = readRows_('CIRCLE').filter(function (c) { return c['サークルID'] === circleId; })[0];
  if (!circle) return json_({ ok: false, error: 'サークルが見つかりません' });

  var already = readRows_('CIRCLEMEMBER').some(function (r) { return r['サークルID'] === circleId && r['会員ID'] === me['会員ID']; });
  if (already) return json_({ ok: true, alreadyJoined: true });

  appendRow_('CIRCLEMEMBER', { 'サークルID': circleId, '会員ID': me['会員ID'], '参加日時': new Date() });
  return json_({ ok: true });
}

function circleGet_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var circleId = String(body.circleId || '');
  var circle = readRows_('CIRCLE').filter(function (c) { return c['サークルID'] === circleId; })[0];
  if (!circle) return json_({ ok: false, error: 'サークルが見つかりません' });

  var memberMap = {};
  readRows_('MEMBER').forEach(function (m) { memberMap[m['会員ID']] = m; });

  var members = readRows_('CIRCLEMEMBER').filter(function (r) { return r['サークルID'] === circleId; }).map(function (r) {
    return memberBrief_(memberMap[r['会員ID']] || { '会員ID': r['会員ID'] });
  });

  var posts = readRows_('CIRCLEPOST').filter(function (p) { return p['サークルID'] === circleId; }).map(function (p) {
    var poster = memberMap[p['投稿者会員ID']] || {};
    return {
      id: p['投稿ID'], body: p['本文'], postedAt: p['投稿日時'] ? String(p['投稿日時']) : '',
      posterName: poster['氏名'] || '(名無し)', posterAvatar: poster['アバター'] || '🕵️',
    };
  });
  posts.sort(function (a, b) { return new Date(a.postedAt) - new Date(b.postedAt); });

  var joined = readRows_('CIRCLEMEMBER').some(function (r) { return r['サークルID'] === circleId && r['会員ID'] === me['会員ID']; });

  return json_({
    ok: true, id: circle['サークルID'], name: circle['サークル名'], description: circle['説明'] || '',
    members: members, posts: posts, joined: joined,
  });
}

function circlePost_(body) {
  var me = verifyMember_(body.memberId, body.email);
  if (!me) return json_({ ok: false, error: '本人確認できませんでした' });
  var circleId = String(body.circleId || '');

  var isMember = readRows_('CIRCLEMEMBER').some(function (r) { return r['サークルID'] === circleId && r['会員ID'] === me['会員ID']; });
  if (!isMember) return json_({ ok: false, error: 'このサークルに参加していません' });

  var text = String(body.body || '').trim();
  if (!text) return json_({ ok: false, error: '本文を入力してください' });
  if (text.length > 1000) return json_({ ok: false, error: '本文は1000文字以内にしてください' });

  var ids = readRows_('CIRCLEPOST').map(function (p) { return p['投稿ID']; });
  var newId = nextId_('P', 6, ids);
  appendRow_('CIRCLEPOST', { '投稿ID': newId, 'サークルID': circleId, '投稿者会員ID': me['会員ID'], '本文': text, '投稿日時': new Date() });
  return json_({ ok: true, id: newId });
}
