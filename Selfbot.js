require("dotenv").config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const axios = require("axios");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName("ping").setDescription("Check if bot is online"),
    new SlashCommandBuilder()
      .setName("stream")
      .setDescription("Check Twitch stream")
      .addStringOption(option =>
        option.setName("channel").setDescription("Twitch channel").setRequired(true)
      )
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Commands registered");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("Bot is online");
  }

  if (interaction.commandName === "stream") {
    const channel = interaction.options.getString("channel");

    await interaction.reply(`Checking stream: https://twitch.tv/${channel}`);
  }
});

client.login(TOKEN);
