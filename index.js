const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require("discord.js");
const express = require("express");
const { createServer } = require("http");

// --- STORAGE (In-Memory) ---
const storage = {
  data: {
    configs: new Map(), // guildId -> {logChannelId, supportRoleId}
    tickets: new Map(), // ticketId -> ticket
    logs: new Map(),    // logId -> log
    nextTicketId: 1,
    nextLogId: 1
  },
  async getLogChannel(guildId) { return this.data.configs.get(guildId)?.logChannelId; },
  async setLogChannel(guildId, channelId) {
    const config = this.data.configs.get(guildId) || {};
    this.data.configs.set(guildId, { ...config, logChannelId: channelId });
  },
  async getSupportRole(guildId) { return this.data.configs.get(guildId)?.supportRoleId; },
  async setSupportRole(guildId, roleId) {
    const config = this.data.configs.get(guildId) || {};
    this.data.configs.set(guildId, { ...config, supportRoleId: roleId });
  },
  async createTicket(ticket) {
    const id = this.data.nextTicketId++;
    const newTicket = { ...ticket, id };
    this.data.tickets.set(id.toString(), newTicket);
    this.data.tickets.set(`chan_${ticket.discordTicketId}`, newTicket);
    return newTicket;
  },
  async getTicketByChannelId(channelId) { return this.data.tickets.get(`chan_${channelId}`); },
  async updateTicketStatus(id, status, claimedBy = null) {
    const ticket = this.data.tickets.get(id.toString());
    if (ticket) {
      ticket.status = status;
      ticket.claimedBy = claimedBy;
      this.data.tickets.set(`chan_${ticket.discordTicketId}`, ticket);
    }
  },
  async logTicket(ticketId, discordTicketId, userId, username, status, transcription) {
    const id = this.data.nextLogId++;
    const log = { id, ticketId, discordTicketId, userId, username, status, transcription };
    this.data.logs.set(id.toString(), log);
    return id;
  },
  async getTranscription(logId) { return this.data.logs.get(logId.toString())?.transcription; }
};

// --- BOT LOGIC ---
let client;
const startTime = Date.now();

async function generateTicketTranscription(channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return "Nenhuma mensagem disponível";
    const messages = await channel.messages.fetch({ limit: 100 });
    const sortedMessages = Array.from(messages.values()).reverse();

    let transcription = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Transcrição</title><style>body { background-color: #313338; color: #dbdee1; font-family: sans-serif; padding: 20px; } .message { margin-bottom: 15px; border-bottom: 1px solid #404249; padding-bottom: 10px; } .author { font-weight: bold; color: #ffffff; } .timestamp { font-size: 0.8em; color: #949ba4; margin-left: 10px; } .content { margin-top: 5px; white-space: pre-wrap; }</style></head><body><h1>Transcrição do Ticket</h1>`;
    for (const msg of sortedMessages) {
      if (msg.author.bot && msg.embeds.length === 0) continue;
      const timestamp = msg.createdTimestamp ? new Date(msg.createdTimestamp).toLocaleString('pt-BR') : '';
      transcription += `<div class="message"><span class="author">${msg.author.username}</span><span class="timestamp">${timestamp}</span><div class="content">${msg.content || ''}</div></div>`;
    }
    transcription += "</body></html>";
    return transcription;
  } catch (e) { return "Erro ao gerar transcrição"; }
}

async function sendTicketPanel(channelId, config) {
  const channel = await client.channels.fetch(channelId);
  const embed = new EmbedBuilder().setTitle(config.title).setDescription(`> ${config.description}`).setColor(0x2B2D31).setTimestamp();
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('Abrir Ticket').setStyle(ButtonStyle.Primary).setEmoji('📩'));
  await channel.send({ embeds: [embed], components: [row] });
}

async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  console.log("[Bot] Verificando token...");
  if (!token || token.length < 10) return console.log("[Bot] Erro: DISCORD_TOKEN ausente.");

  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
  client.once(Events.ClientReady, (c) => console.log(`Ready! Logged in as ${c.user.tag}`));

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) {
        const { customId } = interaction;
        if (customId === "open_ticket") {
          const guild = interaction.guild;
          const botMember = await guild.members.fetchMe();
          const supportRoleId = await storage.getSupportRole(guild.id);
          const permissionOverwrites = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
          ];
          if (supportRoleId) permissionOverwrites.push({ id: supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

          const ticketChannel = await guild.channels.create({ name: `ticket-${interaction.user.username.toLowerCase()}`, type: ChannelType.GuildText, permissionOverwrites });
          const ticket = await storage.createTicket({ discordTicketId: ticketChannel.id, userId: interaction.user.id, username: interaction.user.username, status: 'open' });

          const embed = new EmbedBuilder().setTitle("Atendimento Aberto").setDescription("Aguarde o suporte.").setColor(0x2B2D31).setTimestamp();
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('claim_ticket').setLabel('Assumir').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Encerrar').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
          );
          await ticketChannel.send({ content: `<@${interaction.user.id}> ${supportRoleId ? `<@&${supportRoleId}>` : ""}`, embeds: [embed], components: [row] });
          await interaction.reply({ content: `✅ Ticket criado: ${ticketChannel}`, ephemeral: true });
        }

        if (customId === "close_ticket_btn") {
          const ticket = await storage.getTicketByChannelId(interaction.channelId);
          const transcription = await generateTicketTranscription(interaction.channelId);
          if (ticket) {
            const logId = await storage.logTicket(ticket.id, ticket.discordTicketId, ticket.userId, ticket.username, 'closed', transcription);
            const user = await client.users.fetch(ticket.userId).catch(() => null);
            if (user) user.send({ content: "Seu ticket foi encerrado. Use o comando no servidor para ver logs se configurado." }).catch(() => null);
          }
          await interaction.reply({ content: "Encerrando canal em 5s..." });
          setTimeout(() => interaction.channel.delete().catch(() => null), 5000);
        }

        if (customId === "claim_ticket") {
          const ticket = await storage.getTicketByChannelId(interaction.channelId);
          if (ticket) {
            await storage.updateTicketStatus(ticket.id, 'claimed', interaction.user.id);
            await interaction.reply({ content: `Atendimento assumido por ${interaction.user}` });
          }
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'rename_ticket_modal') {
          const newName = interaction.fields.getTextInputValue('new_name');
          await interaction.channel.setName(`ticket-${newName}`);
          await interaction.reply({ content: "✅ Nome alterado.", ephemeral: true });
        }
      }
    } catch (e) { console.error(e); }
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.member?.permissions.has(PermissionFlagsBits.Administrator)) return;
    if (msg.content.startsWith('!setup')) {
      await sendTicketPanel(msg.channelId, { title: "Suporte", description: "Clique no botão abaixo para abrir um ticket." });
      await msg.reply("✅ Painel enviado.");
    }
    if (msg.content.startsWith('!support')) {
      const roleId = msg.mentions.roles.first()?.id || msg.content.split(' ')[1];
      if (roleId) { await storage.setSupportRole(msg.guildId, roleId); await msg.reply("✅ Cargo definido."); }
    }
  });

  await client.login(token);
}

// --- SERVER ---
const app = express();
app.get("/", (req, res) => res.send("<h1>Bot Online!</h1>"));
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: Date.now() - startTime }));
app.get("/transcription/:id", async (req, res) => {
  const t = await storage.getTranscription(req.params.id);
  t ? res.send(t) : res.status(404).send("Não encontrado");
});

const server = createServer(app);
server.listen(process.env.PORT || 5000, "0.0.0.0", () => {
  console.log("Servidor rodando.");
  startBot().catch(console.error);
});
