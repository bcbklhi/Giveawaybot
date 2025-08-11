/**
 * All-in-one Escrow + Giveaway Bot (Telegraf)
 * - Bio-check for @TrustlyEscrow + funny popups
 * - Giveaways: multi-winner, auto/manual, whitelist groups, auto-pin
 * - Redeem codes, withdraw requests (USDT networks / UPI)
 * - Owner panel, create_redeem, pickwinners, participants, end_giveaway
 * - Persistence via db.json
 * - Keepalive Express server + optional self-ping (PING_URL)
 *
 * Requirements:
 * - Set env BOT_TOKEN and OWNER_ID before running
 * - npm i telegraf node-schedule uuid express
 */

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const schedule = require('node-schedule');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const https = require('https');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || '0', 10);
const PING_URL = process.env.PING_URL || null;
if (!BOT_TOKEN || !OWNER_ID) {
  console.error('Missing BOT_TOKEN or OWNER_ID env vars. Set them and restart.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// DB file
const DB_FILE = path.join(__dirname, 'db.json');
let DB = {
  giveaways: {},       // id -> giveaway object
  redeems: {},         // code -> redeem object
  withdraws: {},       // reqid -> withdraw object
  settings: {
    required_bio_keyword: '@TrustlyEscrow',
    popup_messages: [
      "Add bio first rebel! To participate in giveaway 😒",
      "Arre bhai, bio me @TrustlyEscrow likh ke aa fir button dabana 😂",
      "Without @TrustlyEscrow bio? No entry! 🚫",
      "Rules ka respect kar bhai, pehle bio me @TrustlyEscrow daal 😏",
      "Bro, no @TrustlyEscrow = no giveaway for you 🙅‍♂️"
    ],
    claim_instructions: "Please share your UPI/wallet address using /withdraw <CODE> or through the DM withdraw button.",
    prize_photo_file_id: null,
    whitelist_groups: [] // array of strings (group ids)
  }
};

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
  } catch (e) { console.error('saveDB error', e); }
}
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      DB = JSON.parse(fs.readFileSync(DB_FILE));
    } catch (e) {
      console.error('Failed to parse DB file, backing up and creating new DB.json', e);
      fs.copyFileSync(DB_FILE, DB_FILE + '.bak');
      saveDB();
    }
  } else {
    saveDB();
  }
}

// In-memory sessions (simple)
const SESSIONS = {}; // SESSIONS[userId] = { withdraw: {...} , ... }
function setSession(uid, key, val) {
  SESSIONS[uid] = SESSIONS[uid] || {};
  SESSIONS[uid][key] = val;
}
function getSession(uid, key) {
  return SESSIONS[uid] ? SESSIONS[uid][key] : undefined;
}
function clearSession(uid, key) {
  if (SESSIONS[uid]) delete SESSIONS[uid][key];
}

// Helper utils
function genRedeemCode() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(Math.random().toString(36).substr(2, 4).toUpperCase().replace(/[^A-Z0-9]/g, 'A'));
  }
  return parts.join('-');
}
function pickRandom(arr, k) {
  if (!Array.isArray(arr)) return [];
  const a = arr.slice();
  const res = [];
  while (res.length < k && a.length) {
    const idx = Math.floor(Math.random() * a.length);
    res.push(a.splice(idx, 1)[0]);
  }
  return res;
}
async function getUserBio(userId) {
  try {
    const chat = await bot.telegram.getChat(userId);
    const bio = chat.bio || chat.description || chat.about || '';
    return bio ? String(bio) : '';
  } catch (e) {
    return '';
  }
}
async function safeSend(chat_id, text, extra = {}) {
  try { return await bot.telegram.sendMessage(chat_id, text, extra); }
  catch (e) { console.warn('safeSend failed to', chat_id, e.message || e); return null; }
}
async function safeSendPhoto(chat_id, fileid, extra = {}) {
  try { return await bot.telegram.sendPhoto(chat_id, fileid, extra); }
  catch (e) { console.warn('safeSendPhoto failed to', chat_id, e.message || e); return null; }
}
// broadcast to whitelist groups
async function broadcastToWhitelist(text, extra = null, tryPin = false) {
  const groups = DB.settings.whitelist_groups || [];
  for (const gid of groups) {
    try {
      let sent;
      if (extra) sent = await bot.telegram.sendMessage(gid, text, extra);
      else sent = await bot.telegram.sendMessage(gid, text);
      // try to pin if allowed and requested
      if (tryPin && sent && sent.message_id) {
        try { await bot.telegram.pinChatMessage(gid, sent.message_id); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.warn('broadcastToWhitelist failed', gid, e.message || e);
    }
  }
}

// scheduling
function scheduleGiveaway(gw) {
  try {
    if (gw.endJob) {
      const existing = schedule.scheduledJobs[gw.endJob];
      if (existing) existing.cancel();
    }
  } catch (e) {}
  const jobName = `gw_end_${gw.id}`;
  gw.endJob = jobName;
  const endDate = new Date(gw.end);
  if (endDate.getTime() <= Date.now()) {
    setTimeout(() => endGiveaway(gw.id, 'scheduled-startup'), 500);
  } else {
    schedule.scheduleJob(jobName, endDate, () => endGiveaway(gw.id, 'auto'));
  }
  saveDB();
}

// core endGiveaway
async function endGiveaway(giveawayId, reason = 'auto') {
  const gw = DB.giveaways[giveawayId];
  if (!gw) return;
  if (gw.ended) return;
  gw.ended = true;
  gw.ended_at = Date.now();
  saveDB();

  const participants = gw.participants || [];
  if (!participants.length) {
    const noParticipantsMsg = `🏁 Giveaway Ended\n\n📌 Giveaway ID: ${gw.id}\n💵 Prize: ${gw.amount}\nNo participants — no winners selected.`;
    await broadcastToWhitelist(noParticipantsMsg);
    return;
  }

  if (gw.mode === 'auto') {
    const winners = pickRandom(participants, Math.min(gw.no_of_winners || 1, participants.length));
    gw.winners = winners;
    saveDB();

    const mentions = [];
    for (const uid of winners) {
      const code = genRedeemCode();
      const rc = {
        code,
        amount: gw.amount_value || gw.amount,
        giveaway_id: gw.id,
        created_by: OWNER_ID,
        created_at: Date.now(),
        assigned_to: uid,
        given_to: uid,
        status: 'unused',
        used_at: null
      };
      DB.redeems[code] = rc;
      saveDB();

      try {
        const user = await bot.telegram.getChat(uid);
        const mention = user.username ? `@${user.username}` : (user.first_name || `ID:${uid}`);
        mentions.push(mention);
        let dmText = `🎉 CONGRATS! You won Giveaway ${gw.id} 🎉\n\nPrize: ${gw.amount}\nRedeem Code: ${code}\n\n${DB.settings.claim_instructions}\nUse /withdraw ${code} to withdraw or click the withdraw button below.`;
        const extra = Markup.inlineKeyboard([
          Markup.button.callback('💸 Withdraw', `withdraw_init:${code}`),
          Markup.button.callback('📜 My Codes', `mycodes`)
        ]);
        await bot.telegram.sendMessage(uid, dmText, extra);
      } catch (e) {
        await safeSend(OWNER_ID, `⚠️ Could not DM winner ID ${uid} for giveaway ${gw.id}. Code: ${code}`);
      }
    }

    let announce = `🏆 Giveaway Ended 🏆\n\n📌 Giveaway ID: ${gw.id}\n💵 Prize: ${gw.amount}\n🎯 Winners (${gw.winners.length}): ${mentions.join(', ')}\n\n🎉 Congratulations!\n(Ended by: ${reason === 'auto' ? 'Auto scheduler' : 'Owner/Manual'})`;
    await broadcastToWhitelist(announce, null, false);

    // attach prize photo if set
    if (DB.settings.prize_photo_file_id) {
      for (const g of DB.settings.whitelist_groups || []) {
        try { await bot.telegram.sendPhoto(g, DB.settings.prize_photo_file_id, { caption: '(Prize image)' }); } catch (e) {}
      }
    }
    return;
  } else {
    // manual mode: inform owner to pick winners
    const ownerMsg = `🔔 Giveaway ${gw.id} has ended and requires manual winner selection.\nUse:\n/pickwinners ${gw.id} <user_id1> [user_id2 ...]`;
    await safeSend(OWNER_ID, ownerMsg);
    const announceManual = `🏁 Giveaway Ended (Manual Selection)\n\n📌 Giveaway ID: ${gw.id}\n💵 Prize: ${gw.amount}\nOwner will pick winner(s) soon.`;
    await broadcastToWhitelist(announceManual, null, false);
    return;
  }
}

// load DB & reschedule
loadDB();
for (const gid of Object.keys(DB.giveaways)) {
  const g = DB.giveaways[gid];
  if (!g.ended) {
    try { scheduleGiveaway(g); } catch (e) {}
  }
}

/* -----------------------------
   Core handlers & commands
   ----------------------------- */

function ownerOnly(ctx) {
  return ctx.from && ctx.from.id === OWNER_ID;
}

/**
 * /new_giveaway [amount] [endtime] [giveawayid] [no_of_winners]
 * After sending, owner chooses Auto/Manual inline.
 */
bot.command('new_giveaway', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/new_giveaway', '').trim();
  const parts = raw ? raw.match(/"([^"]+)"|(\S+)/g).map(s => s.replace(/^"|"$/g, '')) : [];
  if (!parts || parts.length < 4) {
    return ctx.reply('Usage: /new_giveaway [amount] [endtime] [giveawayid] [no_of_winners]\nExample: /new_giveaway 5$ 2025-08-15 25 1\nAfter sending this, choose winner mode: Auto or Manual (inline).');
  }
  const [amountRaw, endRaw, giveawayId, winnersRaw] = parts;
  const no_of_winners = Math.max(1, Math.min(50, parseInt(winnersRaw || '1', 10) || 1));

  // parse end time
  let endDate = null;
  if (/^\+/.test(endRaw)) {
    const m = endRaw.match(/^\+(\d+)(m|h|d)$/i);
    if (m) {
      const val = parseInt(m[1], 10), unit = m[2];
      const now = Date.now();
      if (unit === 'm') endDate = new Date(now + val * 60 * 1000);
      if (unit === 'h') endDate = new Date(now + val * 60 * 60 * 1000);
      if (unit === 'd') endDate = new Date(now + val * 24 * 60 * 60 * 1000);
    }
  } else {
    const normalized = endRaw.replace('_', ' ');
    const dt = new Date(normalized);
    if (!isNaN(dt.getTime())) endDate = dt;
  }
  if (!endDate || endDate.getTime() <= Date.now()) {
    return ctx.reply('Invalid end time. Use future date like 2025-08-15 or relative +60m.');
  }

  // build gw and store
  const gid = giveawayId;
  const gw = {
    id: gid,
    amount: amountRaw,
    amount_value: amountRaw,
    no_of_winners,
    created_at: Date.now(),
    created_by: ctx.from.id,
    participants: [],
    proofs: {},
    winners: [],
    ended: false,
    end: endDate.getTime(),
    posted: [] // {group_id, message_id}
  };
  DB.giveaways[gid] = gw;
  saveDB();

  // ask owner to choose mode
  const kb = Markup.inlineKeyboard([
    Markup.button.callback('Auto (bot selects winners)', `create_mode:${gid}:auto`),
    Markup.button.callback('Manual (owner picks winners)', `create_mode:${gid}:manual`)
  ]);
  await ctx.reply(`Draft created for giveaway ${gid} — Prize: ${gw.amount}\nEnds: ${endDate.toLocaleString()}\nWinners: ${gw.no_of_winners}\nChoose winner selection mode:`, kb);
});

// owner picks create mode
bot.action(/create_mode:(.+):(.+)/, async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.');
  const gid = ctx.match[1], mode = ctx.match[2];
  const gw = DB.giveaways[gid];
  if (!gw) return ctx.answerCbQuery('Giveaway not found.');
  gw.mode = mode;
  // post to whitelist groups; if none, post in current chat
  const groups = DB.settings.whitelist_groups || [];
  const text = `🎁 New Giveaway Started! 🎁\n\n📌 Giveaway ID: ${gw.id}\n💵 Prize: ${gw.amount}\n📋 Rules: Must have ${DB.settings.required_bio_keyword} in your bio\n⏳ Ends: ${new Date(gw.end).toLocaleString()}\n🧾 Winner selection: ${gw.mode === 'auto' ? 'Automatic' : 'Manual'}\n👥 Number of winners: ${gw.no_of_winners}\n\n👇 Click below to participate`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🎉 Participate', `gw_join:${gw.id}`)],
    [Markup.button.callback('📜 Participants: 0', `gw_info:${gw.id}`)]
  ]);
  if (!groups || !groups.length) {
    // post to current chat
    try {
      const m = await ctx.reply(text, kb);
      gw.posted.push({ group_id: ctx.chat.id, message_id: m.message_id });
      // try pin
      try { await bot.telegram.pinChatMessage(ctx.chat.id, m.message_id); } catch (e) {}
    } catch (e) { console.warn('post to current chat failed', e.message || e); }
  } else {
    for (const g of groups) {
      try {
        const m = await bot.telegram.sendMessage(g, text, kb);
        gw.posted.push({ group_id: g, message_id: m.message_id });
        // attempt to pin
        try { await bot.telegram.pinChatMessage(g, m.message_id); } catch (e) {}
      } catch (e) {
        console.warn('post failed to', g, e.message || e);
      }
    }
  }
  scheduleGiveaway(gw);
  saveDB();
  await ctx.editMessageText(`Giveaway ${gw.id} created & posted. Mode: ${gw.mode}`);
  await ctx.answerCbQuery();
});

// participant join action
bot.action(/gw_join:(.+)/, async (ctx) => {
  const gid = ctx.match[1];
  const gw = DB.giveaways[gid];
  if (!gw) return ctx.answerCbQuery('Giveaway not found.');
  if (gw.ended) return ctx.answerCbQuery('This giveaway has ended.');
  const uid = ctx.from.id;
  const bio = await getUserBio(uid);
  const required = DB.settings.required_bio_keyword || '@TrustlyEscrow';
  if (!bio || !bio.includes(required)) {
    const pops = DB.settings.popup_messages || [];
    const msg = pops[Math.floor(Math.random() * pops.length)];
    try { await ctx.answerCbQuery(msg, { show_alert: true }); } catch (e) { try { await ctx.reply(msg); } catch (e2) {} }
    return;
  }
  if (gw.participants.includes(uid)) {
    try { await ctx.answerCbQuery('You are already in, relax… prize is not running away 😑', { show_alert: true }); } catch (e) { try { await ctx.reply('You are already in, relax… prize is not running away 😑'); } catch (e2) {} }
    return;
  }
  gw.participants.push(uid);
  saveDB();

  // update posted messages' participant count
  try {
    if (gw.posted && Array.isArray(gw.posted)) {
      for (const p of gw.posted) {
        try {
          const markup = Markup.inlineKeyboard([
            [Markup.button.callback('🎉 Participate', `gw_join:${gw.id}`)],
            [Markup.button.callback(`📜 Participants: ${gw.participants.length}`, `gw_info:${gw.id}`)]
          ]);
          await bot.telegram.editMessageReplyMarkup(p.group_id, p.message_id, undefined, markup.reply_markup);
        } catch (e) { /* ignore per-post failures */ }
      }
    }
  } catch (e) {}
  try { await ctx.answerCbQuery('You are already in, relax… prize is not running away 😑', { show_alert: true }); } catch (e) { try { await ctx.reply('You are already in, relax… prize is not running away 😑'); } catch (e2) {} }
});

// info
bot.action(/gw_info:(.+)/, async (ctx) => {
  const gid = ctx.match[1];
  const gw = DB.giveaways[gid];
  if (!gw) return ctx.answerCbQuery('Giveaway not found.');
  const info = `Giveaway ${gw.id}\nPrize: ${gw.amount}\nParticipants: ${gw.participants.length}\nWinners: ${gw.no_of_winners}\nMode: ${gw.mode || 'not set'}\nEnds: ${new Date(gw.end).toLocaleString()}`;
  await ctx.answerCbQuery(info, { show_alert: true });
});

/* -----------------------------
   Whitelist group management
   ----------------------------- */
bot.command('addgroup', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/addgroup', '').trim();
  if (!raw) return ctx.reply('Usage: /addgroup [group_id] (example: -1001234567890)');
  const gid = raw.split(/\s+/)[0];
  DB.settings.whitelist_groups = DB.settings.whitelist_groups || [];
  if (DB.settings.whitelist_groups.includes(gid)) return ctx.reply('Group already whitelisted.');
  DB.settings.whitelist_groups.push(gid);
  saveDB();
  await ctx.reply(`Added ${gid} to whitelist. Giveaways will be posted there.`);
});

bot.command('removegroup', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/removegroup', '').trim();
  if (!raw) return ctx.reply('Usage: /removegroup [group_id]');
  const gid = raw.split(/\s+/)[0];
  DB.settings.whitelist_groups = DB.settings.whitelist_groups || [];
  DB.settings.whitelist_groups = DB.settings.whitelist_groups.filter(x => x !== gid);
  saveDB();
  await ctx.reply(`Removed ${gid} from whitelist.`);
});

bot.command('listgroups', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const list = DB.settings.whitelist_groups || [];
  if (!list.length) return ctx.reply('No whitelisted groups.');
  await ctx.reply('Whitelisted groups:\n' + list.join('\n'));
});

/* -----------------------------
   Redeem & Withdraw & Owner Panel (full flows)
   ----------------------------- */

// /createredeem [amount] [count] [@username?] [giveawayid?]
bot.command('createredeem', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/createredeem', '').trim();
  if (!raw) return ctx.reply('Usage: /createredeem [amount] [count] [@username?] [giveawayid?]\nExample: /createredeem 100$ 5\n/createredeem 50₹ 1 @username G28');
  const parts = raw.match(/"([^"]+)"|(\S+)/g).map(s => s.replace(/^"|"$/g, ''));
  const amount = parts[0];
  const count = Math.max(1, Math.min(500, parseInt(parts[1] || '1', 10) || 1));
  const maybeUser = parts[2] && parts[2].startsWith('@') ? parts[2] : null;
  const giveawayid = parts[2] && !parts[2].startsWith('@') ? parts[2] : parts[3] || null;

  const created = [];
  for (let i = 0; i < count; i++) {
    const code = genRedeemCode();
    const rc = {
      code,
      amount,
      created_by: ctx.from.id,
      created_at: Date.now(),
      assigned_to: null,
      given_to: null,
      status: 'unused',
      giveaway_id: giveawayid || null
    };
    DB.redeems[code] = rc;
    created.push(code);
  }
  saveDB();

  ctx.reply(`Created ${created.length} redeem code(s). Example codes:\n` + created.slice(0, 10).join('\n'));
  if (maybeUser) await ctx.reply(`Codes created. To give manually to a user, use /sendcode @username <CODE>`);
});

// /sendcode @username CODE
bot.command('sendcode', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/sendcode', '').trim();
  const parts = raw.match(/"([^"]+)"|(\S+)/g).map(s => s.replace(/^"|"$/g, ''));
  if (parts.length < 2) return ctx.reply('Usage: /sendcode @username CODE');
  const username = parts[0].startsWith('@') ? parts[0].slice(1) : parts[0];
  const code = parts[1];
  const redeem = DB.redeems[code];
  if (!redeem) return ctx.reply('Code not found');
  await ctx.reply(`To send code to @${username}: ask them to DM the bot and use /redeem ${code}, or forward them this message manually.`);
});

// /mycodes
bot.command('mycodes', async (ctx) => {
  const uid = ctx.from.id;
  const mine = Object.values(DB.redeems).filter(r => r.given_to === uid || r.assigned_to === uid);
  if (!mine.length) return ctx.reply('You have no redeem codes.');
  const rows = mine.map(r => `${r.code} | ${r.amount} | ${r.status}`);
  await ctx.reply('Your codes:\n' + rows.join('\n'));
});

// /redeem CODE
bot.command('redeem', async (ctx) => {
  const raw = ctx.message.text.replace('/redeem', '').trim();
  if (!raw) return ctx.reply('Usage: /redeem <CODE>');
  const code = raw.split(/\s+/)[0];
  const redeem = DB.redeems[code];
  if (!redeem) return ctx.reply('Invalid code.');
  if (redeem.status !== 'unused') return ctx.reply('This code is already used or pending.');
  redeem.given_to = ctx.from.id;
  redeem.status = 'unused';
  saveDB();
  await ctx.reply(`Code ${code} assigned to you. Use /withdraw ${code} to request payout or click Withdraw button.`);
  try {
    await bot.telegram.sendMessage(ctx.from.id, `Your code: ${code}\nUse /withdraw ${code} to withdraw`, Markup.inlineKeyboard([Markup.button.callback('💸 Withdraw', `withdraw_init:${code}`)]));
  } catch (e) {}
});

/* Withdraw flow */

// withdraw_init callback
bot.action(/withdraw_init:(.+)/, async (ctx) => {
  const code = ctx.match[1];
  const redeem = DB.redeems[code];
  if (!redeem) return ctx.answerCbQuery('Invalid code.');
  if (redeem.given_to && redeem.given_to !== ctx.from.id) return ctx.answerCbQuery('This code is not yours.');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('USDT BEP20', `withdraw_method:${code}:USDT_BEP20`), Markup.button.callback('USDT TRC20', `withdraw_method:${code}:USDT_TRC20`)],
    [Markup.button.callback('USDT POLYGON', `withdraw_method:${code}:USDT_POLYGON`), Markup.button.callback('UPI (INR)', `withdraw_method:${code}:UPI`)]
  ]);
  await ctx.reply(`Choose payout method for code ${code} (${redeem.amount})`, kb);
  await ctx.answerCbQuery();
});

bot.action(/withdraw_method:(.+):(.+)/, async (ctx) => {
  const code = ctx.match[1], method = ctx.match[2];
  const redeem = DB.redeems[code];
  if (!redeem) return ctx.answerCbQuery('Invalid code.');
  if (redeem.given_to && redeem.given_to !== ctx.from.id) return ctx.answerCbQuery('This code is not yours.');
  setSession(ctx.from.id, 'withdraw', { code, method });
  await ctx.reply(`You chose ${method}. Please send your wallet address / UPI id now (as a message).`);
  await ctx.answerCbQuery();
});

// capture address when user sends text
bot.on('text', async (ctx, next) => {
  const s = getSession(ctx.from.id, 'withdraw');
  // Also allow owner custom message pattern #msg in separate branch (owner only)
  if (s && s.code) {
    const { code, method } = s;
    const redeem = DB.redeems[code];
    if (!redeem) {
      clearSession(ctx.from.id, 'withdraw');
      return ctx.reply('Session expired or invalid code.');
    }
    const address = ctx.message.text.trim();
    const wrid = 'WR-' + Date.now().toString().slice(-6) + '-' + Math.floor(Math.random()*9000 + 1000);
    const wr = {
      id: wrid,
      code,
      user_id: ctx.from.id,
      amount: redeem.amount,
      method,
      address,
      status: 'pending',
      created_at: Date.now()
    };
    DB.withdraws[wrid] = wr;
    redeem.status = 'withdraw_pending';
    redeem.withdraw_request_id = wrid;
    saveDB();
    clearSession(ctx.from.id, 'withdraw');
    await ctx.reply(`Withdraw request created: ${wrid}. Owner will review and process it.`);
    const user = ctx.from;
    const userIdent = user.username ? `@${user.username}` : `${user.first_name || 'User'} (ID:${user.id})`;
    const msg = `🔔 New Withdraw Request\nUser: ${userIdent}\nAmount: ${wr.amount}\nMethod: ${wr.method}\nAddress/UPI: ${wr.address}\nRedeem Code: ${wr.code}\nRequest ID: ${wr.id}`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Approve & Mark Paid', `wr_approve:${wr.id}`), Markup.button.callback('❌ Reject', `wr_reject:${wr.id}`)],
      [Markup.button.callback('📝 Message User', `wr_msg:${wr.id}`)]
    ]);
    try { await bot.telegram.sendMessage(OWNER_ID, msg, kb); } catch (e) { console.warn('notify owner failed', e.message || e); }
    return;
  }

  // owner custom message flow (#msg WRID text)
  if (ownerOnly(ctx)) {
    const text = ctx.message.text || '';
    if (text.startsWith('#msg ')) {
      const parts = text.split(' ');
      if (parts.length < 3) return ctx.reply('Usage: #msg <WRID> Your message here');
      const wrid = parts[1]; const wr = DB.withdraws[wrid];
      if (!wr) return ctx.reply('Invalid request id');
      const msg = parts.slice(2).join(' ');
      try { await bot.telegram.sendMessage(wr.user_id, `Message from Owner regarding withdraw ${wrid}:\n\n${msg}`); await ctx.reply('Message sent to user.'); }
      catch (e) { await ctx.reply('Failed to send message to user.'); }
      return;
    }
  }
  return next();
});

// owner actions for withdraw requests
bot.action(/wr_approve:(.+)/, async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only');
  const id = ctx.match[1];
  const wr = DB.withdraws[id];
  if (!wr) return ctx.answerCbQuery('Request not found');
  if (wr.status !== 'pending') return ctx.answerCbQuery('Request not pending');
  wr.status = 'approved'; wr.approved_at = Date.now(); saveDB();
  const redeem = DB.redeems[wr.code];
  if (redeem) { redeem.status = 'paid'; redeem.used_at = Date.now(); saveDB(); }
  try { await bot.telegram.sendMessage(wr.user_id, `✅ Your withdraw request ${wr.id} has been approved by the Owner. They will send the funds shortly.`); } catch (e) {}
  await ctx.editMessageText(`Withdraw Request ${id} — APPROVED by owner.`);
  await ctx.answerCbQuery('Approved.');
});
bot.action(/wr_reject:(.+)/, async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only');
  const id = ctx.match[1]; const wr = DB.withdraws[id];
  if (!wr) return ctx.answerCbQuery('Request not found');
  if (wr.status !== 'pending') return ctx.answerCbQuery('Request not pending');
  wr.status = 'rejected'; wr.rejected_at = Date.now(); saveDB();
  const redeem = DB.redeems[wr.code];
  if (redeem) { redeem.status = 'unused'; redeem.withdraw_request_id = null; saveDB(); }
  try { await bot.telegram.sendMessage(wr.user_id, `❌ Your withdraw request ${wr.id} was rejected by the Owner. Please contact the owner for details.`); } catch (e) {}
  await ctx.editMessageText(`Withdraw Request ${id} — REJECTED by owner.`);
  await ctx.answerCbQuery('Rejected.');
});
bot.action(/wr_msg:(.+)/, async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only');
  const id = ctx.match[1]; const wr = DB.withdraws[id];
  if (!wr) return ctx.answerCbQuery('Request not found');
  await ctx.reply(`Reply to me now with message to user for request ${id}. Start your reply with: #msg ${id} Your message here`);
});

/* -----------------------------
   Manual winner selection
   ----------------------------- */
bot.command('pickwinners', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/pickwinners', '').trim();
  if (!raw) return ctx.reply('Usage: /pickwinners GID user_id1 user_id2 ...');
  const parts = raw.split(/\s+/);
  const gid = parts[0];
  const ids = parts.slice(1).map(x => parseInt(x, 10)).filter(x => !isNaN(x));
  const gw = DB.giveaways[gid];
  if (!gw) return ctx.reply('Giveaway not found');
  if (ids.length === 0) return ctx.reply('Provide at least one user id to set as winners.');
  gw.winners = ids; gw.ended = true; gw.ended_at = Date.now(); saveDB();

  for (const uid of ids) {
    const code = genRedeemCode();
    const rc = { code, amount: gw.amount, created_by: OWNER_ID, created_at: Date.now(), assigned_to: uid, given_to: uid, status: 'unused', giveaway_id: gid };
    DB.redeems[code] = rc; saveDB();
    try { await bot.telegram.sendMessage(uid, `🎉 CONGRATS! You were chosen winner for ${gid}\nRedeem Code: ${code}\nUse /withdraw ${code} to request payout.`, Markup.inlineKeyboard([Markup.button.callback('💸 Withdraw', `withdraw_init:${code}`)])); }
    catch (e) { await safeSend(OWNER_ID, `Could not DM user ${uid} with code ${code}.`); }
  }
  await ctx.reply(`Winners set for ${gid}. Announced to winners.`);
  // announce to whitelist
  await broadcastToWhitelist(`🏆 Giveaway ${gid} winners have been manually selected by owner.`);
});

/* -----------------------------
   Other helpful commands
   ----------------------------- */

bot.command('participants', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/participants', '').trim();
  if (!raw) return ctx.reply('Usage: /participants GIVEAWAYID');
  const gid = raw.split(/\s+/)[0];
  const gw = DB.giveaways[gid];
  if (!gw) return ctx.reply('Giveaway not found');
  const rows = gw.participants.slice(-200).map(id => `${id}`);
  await ctx.reply(`Participants (${gw.participants.length}):\n` + (rows.length ? rows.join('\n') : 'No participants'));
});

bot.command('end_giveaway', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const raw = ctx.message.text.replace('/end_giveaway', '').trim();
  if (!raw) return ctx.reply('Usage: /end_giveaway GIVEAWAYID');
  const gid = raw.split(/\s+/)[0];
  const gw = DB.giveaways[gid];
  if (!gw) return ctx.reply('Giveaway not found');
  if (gw.ended) return ctx.reply('Already ended');
  endGiveaway(gid, 'owner-ended');
  await ctx.reply(`Giveaway ${gid} ended by owner.`);
});

bot.command('panel', async (ctx) => {
  if (!ownerOnly(ctx)) return ctx.reply('Owner only.');
  const lines = [];
  lines.push(`Owner Panel`);
  lines.push(`Total Giveaways: ${Object.keys(DB.giveaways).length}`);
  lines.push(`Total Redeems: ${Object.keys(DB.redeems).length}`);
  lines.push(`Required bio keyword: ${DB.settings.required_bio_keyword}`);
  lines.push(`Claim instructions: ${DB.settings.claim_instructions}`);
  const text = lines.join('\n');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✏ Edit Required Keyword', 'op_edit_keyword'), Markup.button.callback('✏ Edit Claim Instructions', 'op_edit_claim')],
    [Markup.button.callback('🎯 Pick Winners (manual)', 'op_pick_winners'), Markup.button.callback('🔁 Reroll Winner', 'op_reroll')],
    [Markup.button.callback('🧾 Create Redeem(s)', 'op_create_redeem'), Markup.button.callback('📦 List Redeems', 'op_list_redeems')],
    [Markup.button.callback('📜 Show Giveaways', 'op_list_giveaways'), Markup.button.callback('📊 Show Withdraws', 'op_list_withdraws')]
  ]);
  await ctx.reply(text, kb);
});

bot.action('op_edit_keyword', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); await ctx.reply('Send new required bio keyword (e.g., @TrustlyEscrow)'); });
bot.action('op_edit_claim', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); await ctx.reply('Send new claim instructions message (plain text).'); });
bot.action('op_pick_winners', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); await ctx.reply('Reply with the Giveaway ID to pick winners for (manual mode).'); });
bot.action('op_reroll', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); await ctx.reply('Reply with: GIVEAWAY_ID WINNER_INDEX (0-based) to reroll that winner slot.'); });
bot.action('op_create_redeem', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); await ctx.reply('Usage:\n/createredeem [amount] [count] [optional @username] [optional giveawayid]'); });
bot.action('op_list_redeems', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); const rows = Object.values(DB.redeems).slice(-30).map(r => `${r.code} | ${r.amount} | ${r.status} | assigned:${r.assigned_to||'-'}`); await ctx.reply('Recent redeems:\n' + (rows.length ? rows.join('\n') : 'No redeems')); });
bot.action('op_list_giveaways', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); const rows = Object.values(DB.giveaways).map(g => `${g.id} | ${g.amount} | participants:${g.participants.length} | ended:${g.ended ? 'yes':'no'}`); await ctx.reply('Giveaways:\n' + (rows.length ? rows.join('\n') : 'No giveaways')); });
bot.action('op_list_withdraws', async (ctx) => { if (!ownerOnly(ctx)) return ctx.answerCbQuery('Owner only.'); const rows = Object.values(DB.withdraws).slice(-50).map(w => `${w.id} | ${w.user_id} | ${w.amount} | ${w.method} | ${w.status}`); await ctx.reply('Withdraw requests:\n' + (rows.length ? rows.join('\n') : 'No withdraws')); });

bot.command('ping', (ctx) => ctx.reply('pong'));

/* -----------------------------
   Keepalive server + optional self-ping
   ----------------------------- */
const app = express();
app.get('/', (req, res) => res.send('Escrow Giveaway Bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Keepalive server running on port ${PORT}`);
  if (PING_URL) {
    console.log(`Self-ping enabled for: ${PING_URL}`);
    setInterval(() => {
      try {
        https.get(PING_URL, (res) => { console.log('Self-ping status:', res.statusCode); }).on('error', (e) => console.warn('Self-ping error', e.message));
      } catch (e) { console.warn('Self-ping exception', e.message || e); }
    }, 1000 * 60 * 5); // every 5 minutes
  } else {
    console.log('Set PING_URL env to enable optional self-ping (helpful on some hosts).');
  }
});

/* -----------------------------
   Launch
   ----------------------------- */
bot.launch().then(() => console.log('Bot started')).catch(e => console.error('Bot launch error', e));
process.once('SIGINT', () => { bot.stop('SIGINT'); saveDB(); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); saveDB(); process.exit(0); });

