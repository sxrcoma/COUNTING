const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const COUNTING_CHANNEL_ID = process.env.COUNTING_CHANNEL_ID;

const TIMEOUT_DURATION_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_LABEL = '1 day';

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

let currentCount = 0;
let lastCounterId = null;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Watching counting channel: ${COUNTING_CHANNEL_ID}`);
  console.log(`Timeout duration: ${TIMEOUT_DURATION_MS}ms (${TIMEOUT_LABEL})`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.channel.type !== ChannelType.GuildText) return;
    if (message.channel.id !== COUNTING_CHANNEL_ID) return;

    const raw = message.content.trim();

    if (!/^\d+$/.test(raw)) {
      await handleFailure(
        message,
        `sent something that is not a valid whole number. The next number should be **${currentCount + 1}**.`
      );
      return;
    }

    const number = parseInt(raw, 10);
    const expected = currentCount + 1;

    if (message.author.id === lastCounterId) {
      await handleFailure(
        message,
        `counted twice in a row. The next number should be **${expected}**, but from someone else.`
      );
      return;
    }

    if (number !== expected) {
      await handleFailure(
        message,
        `sent **${number}**, but the correct number was **${expected}**.`
      );
      return;
    }

    currentCount = number;
    lastCounterId = message.author.id;

    await message.react('✅');
  } catch (error) {
    console.error('Error in messageCreate event:', error);
  }
});

async function handleFailure(message, reason) {
  const failedUser = message.author;
  const member = message.member;

  currentCount = 0;
  lastCounterId = null;

  await message.channel.send(
    `❌ ${failedUser} messed up the counting — ${reason}\n` +
    `The count has been reset to **0**.`
  );

  if (!member) return;

  if (!member.moderatable) {
    await message.channel.send(
      `I could not timeout ${failedUser} for **${TIMEOUT_LABEL}**. Make sure I have **Moderate Members** and that my role is above theirs.`
    );
    return;
  }

  try {
    console.log(`Applying timeout to ${failedUser.tag}: ${TIMEOUT_DURATION_MS}ms (${TIMEOUT_LABEL})`);

    await member.timeout(TIMEOUT_DURATION_MS, 'Broke the counting game');
    await member.fetch();

    console.log(
      `Timeout set for ${failedUser.tag} until: ${member.communicationDisabledUntil} (${member.communicationDisabledUntilTimestamp})`
    );

    await message.channel.send(
      `⏳ ${failedUser} has been timed out for **${TIMEOUT_LABEL}**.`
    );
  } catch (error) {
    console.error('Failed to timeout member:', error);
    await message.channel.send(`I tried to timeout ${failedUser}, but it failed.`);
  }
}

client.login(TOKEN);
