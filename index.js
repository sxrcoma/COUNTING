const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const COUNTING_CHANNEL_ID = process.env.COUNTING_CHANNEL_ID;

const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const TIMEOUT_REASON = 'Broke the counting game';
const SYNC_MESSAGE_LIMIT = 100;

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}

if (!COUNTING_CHANNEL_ID) {
  console.error('Missing COUNTING_CHANNEL_ID environment variable.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

const state = {
  currentNumber: 0,
  lastUserId: null,
  synced: false
};

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📌 Counting channel: ${COUNTING_CHANNEL_ID}`);
  console.log(`⏳ Timeout duration: ${TIMEOUT_MS} ms`);

  try {
    await syncStateFromChannel();
    console.log(`🔄 Synced count to ${state.currentNumber} (last user: ${state.lastUserId ?? 'none'})`);
  } catch (error) {
    console.error('Failed to sync counting state on startup:', error);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (!shouldHandleMessage(message)) return;

    await syncStateFromChannel(message.channel);

    const content = message.content.trim();
    const expectedNumber = state.currentNumber + 1;

    if (!/^\d+$/.test(content)) {
      await failCount(message, `sent something invalid. You must send **${expectedNumber}**.`);
      return;
    }

    const sentNumber = Number(content);

    if (message.author.id === state.lastUserId) {
      await failCount(
        message,
        `counted twice in a row. The next number was **${expectedNumber}**, but it had to be sent by someone else.`
      );
      return;
    }

    if (sentNumber !== expectedNumber) {
      await failCount(message, `sent **${sentNumber}**, but the correct number was **${expectedNumber}**.`);
      return;
    }

    state.currentNumber = sentNumber;
    state.lastUserId = message.author.id;
    state.synced = true;

    await message.react('✅');
  } catch (error) {
    console.error('Error in messageCreate:', error);
  }
});

function shouldHandleMessage(message) {
  if (message.author.bot) return false;
  if (!message.guild) return false;
  if (message.channel.type !== ChannelType.GuildText) return false;
  if (message.channel.id !== COUNTING_CHANNEL_ID) return false;
  return true;
}

async function syncStateFromChannel(existingChannel = null) {
  const channel = existingChannel ?? await client.channels.fetch(COUNTING_CHANNEL_ID);

  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Counting channel is missing or is not a guild text channel.');
  }

  const messages = await channel.messages.fetch({ limit: SYNC_MESSAGE_LIMIT, cache: false });

  const orderedMessages = [...messages.values()]
    .filter((msg) => !msg.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  let currentNumber = 0;
  let lastUserId = null;

  for (const msg of orderedMessages) {
    const content = msg.content.trim();

    if (!/^\d+$/.test(content)) continue;

    const sentNumber = Number(content);
    const expectedNumber = currentNumber + 1;

    if (msg.author.id === lastUserId) continue;
    if (sentNumber !== expectedNumber) continue;

    currentNumber = sentNumber;
    lastUserId = msg.author.id;
  }

  state.currentNumber = currentNumber;
  state.lastUserId = lastUserId;
  state.synced = true;
}

async function failCount(message, reason) {
  const user = message.author;
  const member = message.member;

  state.currentNumber = 0;
  state.lastUserId = null;
  state.synced = true;

  await message.channel.send(
    `❌ ${user} messed up the counting — ${reason}\nThe count has been reset to **0**.`
  );

  if (!member) return;

  if (!member.moderatable) {
    await message.channel.send(
      `I could not timeout ${user} for **24 hours**. Make sure I have **Moderate Members** permission and my role is above theirs.`
    );
    return;
  }

  const botMember = message.guild.members.me;

  if (!botMember?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
    await message.channel.send(
      `I am missing the **Moderate Members** permission, so I could not timeout ${user}.`
    );
    return;
  }

  try {
    await member.timeout(TIMEOUT_MS, TIMEOUT_REASON);

    const refreshedMember = await member.fetch();
    const timeoutEndUnix = Math.floor(refreshedMember.communicationDisabledUntilTimestamp / 1000);

    console.log(`Timed out ${user.tag} until ${refreshedMember.communicationDisabledUntil}`);

    await message.channel.send(
      `⏳ ${user} has been timed out until <t:${timeoutEndUnix}:F>.`
    );
  } catch (error) {
    console.error('Failed to timeout member:', error);
    await message.channel.send(`I tried to timeout ${user}, but it failed.`);
  }
}

client.login(TOKEN);
