const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.DISCORD_TOKEN;
const COUNTING_CHANNEL_ID = process.env.COUNTING_CHANNEL_ID;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 24 * 60 * 60 * 1000; // 24h default
const TIMEOUT_REASON = 'Broke the counting game';
const ALLOW_MATH = process.env.ALLOW_MATH === 'true'; // e.g. "5+5" counts as 10
const DELETE_WRONG_MESSAGES = process.env.DELETE_WRONG_MESSAGES === 'true';
const STATE_FILE = path.join(__dirname, 'counting-state.json');

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}
if (!COUNTING_CHANNEL_ID) {
  console.error('Missing COUNTING_CHANNEL_ID environment variable.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------
// The original bot kept everything in memory, so a restart/crash silently
// reset the count to 0 without telling anyone. This version persists to
// disk and reloads on startup.

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      currentNumber: Number(parsed.currentNumber) || 0,
      lastUserId: parsed.lastUserId || null,
      highScore: Number(parsed.highScore) || 0
    };
  } catch {
    return { currentNumber: 0, lastUserId: null, highScore: 0 };
  }
}

let saveQueued = false;
function saveState() {
  // Debounce writes so a burst of counting doesn't hammer the disk.
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error('Failed to save state:', err);
    });
  });
}

const state = loadState();

// ---------------------------------------------------------------------------
// Per-channel message queue
// ---------------------------------------------------------------------------
// discord.js can fire messageCreate for near-simultaneous messages before the
// previous handler's awaits (react, timeout, etc.) finish. Without
// serializing them, two people racing to post the same number can both be
// read against the same "expectedNumber" and cause double resets or a
// correct count being flagged wrong. This queue processes one message at a
// time, in arrival order, per channel.

const channelQueues = new Map();

function enqueue(channelId, task) {
  const prev = channelQueues.get(channelId) || Promise.resolve();
  const next = prev.then(task).catch((err) => console.error('Queue task error:', err));
  channelQueues.set(channelId, next);
  return next;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📌 Counting channel: ${COUNTING_CHANNEL_ID}`);
  console.log(`⏳ Timeout duration: ${TIMEOUT_MS} ms`);
  console.log(`🔢 Resuming from ${state.currentNumber} (high score ${state.highScore})`);
});

client.on('messageCreate', (message) => {
  if (!shouldHandleMessage(message)) return;
  // Serialize handling per channel to avoid race conditions.
  enqueue(message.channel.id, () => handleCount(message));
});

function shouldHandleMessage(message) {
  if (message.author.bot) return false;
  if (!message.guild) return false;
  if (message.channel.type !== ChannelType.GuildText) return false;
  if (message.channel.id !== COUNTING_CHANNEL_ID) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Core counting logic
// ---------------------------------------------------------------------------

function parseCount(content) {
  const trimmed = content.trim();

  if (ALLOW_MATH) {
    // Only allow digits, spaces, and + - * / ( ) — never eval() arbitrary input.
    if (!/^[\d+\-*/().\s]+$/.test(trimmed)) return null;
    try {
      // Safe-ish arithmetic evaluator without eval/Function constructor tricks:
      // strip everything but the allowed characters (already done above) then
      // hand off to a minimal parser.
      const result = evaluateArithmetic(trimmed);
      if (result === null || !Number.isInteger(result)) return null;
      return result;
    } catch {
      return null;
    }
  }

  // Strict mode: plain integers only. Reject leading zeros ("007"), signs,
  // decimals, and anything with extra whitespace/characters baked in.
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) return null;
  return Number(trimmed);
}

// Minimal, safe recursive-descent arithmetic evaluator (+, -, *, /, parens).
// Avoids eval()/new Function() entirely so user input can never run arbitrary code.
function evaluateArithmetic(expr) {
  let i = 0;

  function peek() {
    return expr[i];
  }
  function skipSpaces() {
    while (peek() === ' ') i++;
  }
  function parseNumber() {
    skipSpaces();
    const start = i;
    while (/\d/.test(peek())) i++;
    if (start === i) throw new Error('Expected number');
    return Number(expr.slice(start, i));
  }
  function parseFactor() {
    skipSpaces();
    if (peek() === '(') {
      i++;
      const value = parseExpression();
      skipSpaces();
      if (peek() !== ')') throw new Error('Expected )');
      i++;
      return value;
    }
    if (peek() === '-') {
      i++;
      return -parseFactor();
    }
    return parseNumber();
  }
  function parseTerm() {
    let value = parseFactor();
    skipSpaces();
    while (peek() === '*' || peek() === '/') {
      const op = peek();
      i++;
      const rhs = parseFactor();
      value = op === '*' ? value * rhs : value / rhs;
      skipSpaces();
    }
    return value;
  }
  function parseExpression() {
    let value = parseTerm();
    skipSpaces();
    while (peek() === '+' || peek() === '-') {
      const op = peek();
      i++;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
      skipSpaces();
    }
    return value;
  }

  const result = parseExpression();
  skipSpaces();
  if (i !== expr.length) throw new Error('Unexpected trailing characters');
  return result;
}

async function handleCount(message) {
  try {
    const content = message.content;
    const expectedNumber = state.currentNumber + 1;
    const parsed = parseCount(content);

    if (parsed === null) {
      await failCount(message, `sent something invalid. You must send **${expectedNumber}**.`);
      return;
    }

    if (message.author.id === state.lastUserId) {
      await failCount(
        message,
        `counted twice in a row. The next number was **${expectedNumber}**, but it had to be sent by someone else.`
      );
      return;
    }

    if (parsed !== expectedNumber) {
      await failCount(message, `sent **${parsed}**, but the correct number was **${expectedNumber}**.`);
      return;
    }

    state.currentNumber = parsed;
    state.lastUserId = message.author.id;

    let brokeRecord = false;
    if (state.currentNumber > state.highScore) {
      state.highScore = state.currentNumber;
      brokeRecord = true;
    }
    saveState();

    await message.react('✅');

    if (brokeRecord && state.currentNumber % 100 === 0) {
      await message.channel.send(`🎉 New high score! The count just reached **${state.currentNumber}**.`);
    }
  } catch (error) {
    console.error('Error handling count message:', error);
  }
}

async function failCount(message, reason) {
  const user = message.author;
  const member = message.member;

  state.currentNumber = 0;
  state.lastUserId = null;
  saveState();

  if (DELETE_WRONG_MESSAGES) {
    await message.delete().catch(() => {});
  }

  await message.channel.send(
    `❌ ${user} messed up the counting — ${reason}\nThe count has been reset to **0**.`
  );

  if (!member) return;

  const botMember = message.guild.members.me;

  if (!botMember?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
    await message.channel.send(
      `I am missing the **Moderate Members** permission, so I could not timeout ${user}.`
    );
    return;
  }

  if (!member.moderatable) {
    await message.channel.send(
      `I could not timeout ${user} for **24 hours**. Make sure my role is above theirs and they aren't the server owner.`
    );
    return;
  }

  try {
    await member.timeout(TIMEOUT_MS, TIMEOUT_REASON);

    const refreshedMember = await member.fetch();
    const timeoutEndUnix = Math.floor(refreshedMember.communicationDisabledUntilTimestamp / 1000);

    console.log(`Timed out ${user.tag} until ${refreshedMember.communicationDisabledUntil}`);

    await message.channel.send(`⏳ ${user} has been timed out until <t:${timeoutEndUnix}:F>.`);
  } catch (error) {
    console.error('Failed to timeout member:', error);
    await message.channel.send(`I tried to timeout ${user}, but it failed.`);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown — make sure the last known state is flushed to disk.
// ---------------------------------------------------------------------------

function shutdown() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save state on shutdown:', err);
  }
  process.exit(0);
}
process.on('SIGINT', shutdowd);
process.on('SIGTERM', shutdown);

client.login(TOKEN);
