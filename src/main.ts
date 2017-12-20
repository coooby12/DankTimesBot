// Suppress promise warning from node-telegram-bot-api (https://github.com/yagop/node-telegram-bot-api/issues/319)
process.env.NTBA_FIX_319 = "1";

import { Chat } from "./chat/chat";
import * as contextRoot from "./context-root";
import { TelegramBotCommand } from "./telegram-bot-command/telegram-bot-command";

// Global variables.
const fileIO = contextRoot.fileIO;
const chatRegistry = contextRoot.chatRegistry;
const releaseLog = contextRoot.releaseLog;
const tgClient = contextRoot.telegramClient;
const scheduler = contextRoot.dankTimeScheduler;
const commands = contextRoot.telegramBotCommands;
const config = contextRoot.config;
const nodeCleanup = contextRoot.nodeCleanup;
const moment = contextRoot.moment;
const cronJob = contextRoot.cronJob;

// Register available Telegram bot commands, after retrieving the bot name.
tgClient.retrieveBotName().then(() => {
  tgClient.registerCommand(new TelegramBotCommand("addtime",
    "adds a dank time. format: [hour] [minute] [points] [text1] [text2] etc.",
    commands, commands.addTime, true));
  tgClient.registerCommand(new TelegramBotCommand("danktimes", "shows the user-specified dank times",
    commands, commands.dankTimes));
  tgClient.registerCommand(new TelegramBotCommand("help", "shows the available commands",
    commands, commands.help));
  tgClient.registerCommand(new TelegramBotCommand("leaderboard", "shows the leaderboard",
    commands, commands.leaderBoard));
  tgClient.registerCommand(new TelegramBotCommand("releases", "shows the release log",
    commands, commands.getReleaseLog));
  tgClient.registerCommand(new TelegramBotCommand("removetime", "removes a dank time. format: [hour] [minute]",
    commands, commands.removeTime, true));
  tgClient.registerCommand(new TelegramBotCommand("reset", "resets the scores",
    commands, commands.resetChat, true, true));
  tgClient.registerCommand(new TelegramBotCommand("setdailyrandomfrequency",
    "sets the number of random dank times per day. format: [number]", commands, commands.setDailyRandomTimes, true));
  tgClient.registerCommand(new TelegramBotCommand("setdailyrandompoints",
    "sets the points for random daily dank times. format: [number]",
    commands, commands.setDailyRandomTimesPoints, true));
  tgClient.registerCommand(new TelegramBotCommand("setmultiplier",
    "sets the multiplier for the score of the first user to score. format: [number]",
    commands, commands.setMultiplier, true));
  tgClient.registerCommand(new TelegramBotCommand("settimezone", "sets the time zone. format: [timezone]",
    commands, commands.setTimezone, true));
  tgClient.registerCommand(new TelegramBotCommand("settings", "shows the current settings",
    commands, commands.chatSettings));
  tgClient.registerCommand(new TelegramBotCommand("start", "starts keeping track of scores and sending messages",
    commands, commands.startChat, true));
  tgClient.registerCommand(new TelegramBotCommand("stop", "stops keeping track of scores and sending messages",
    commands, commands.stopChat, true));
  tgClient.registerCommand(new TelegramBotCommand("toggleautoleaderboards",
    "toggles whether a leaderboard is auto-posted 1 minute after every dank time",
    commands, commands.toggleAutoLeaderboards, true));
  tgClient.registerCommand(new TelegramBotCommand("toggledanktimenotifications",
    "toggles whether notifications of normal dank times are sent", commands, commands.toggleNotifications, true));
  tgClient.registerCommand(new TelegramBotCommand("togglefirstnotifications",
    "toggles whether this chat announces the first user to score", commands, commands.toggleFirstNotifications, true));
  tgClient.registerCommand(new TelegramBotCommand("togglehardcoremode",
    "toggles whether every day, users are punished if they haven't scored the previous day",
    commands, commands.toggleHardcoreMode, true));
  tgClient.setOnAnyText((msg) => {

    if (msg.migrate_to_chat_id) { // If the chat was migrated, then update the registry.
      chatRegistry.setChatId(msg.chat.id, msg.migrate_to_chat_id);

    } else if (msg.left_chat_member) { // If a chat member left, remove him from the chat scores.
      const chat = chatRegistry.getOrCreateChat(msg.chat.id);
      const removedUser = chat.removeUser(msg.left_chat_member.id);

      if (removedUser) {
        return `${removedUser.name} left! Their final score was ${removedUser.score}!`;
      }

    } else if (msg.text) { // Let the appropriate chat process the message.
      const chat = chatRegistry.getOrCreateChat(msg.chat.id);
      return chat.processMessage(msg.from.id, msg.from.username || "anonymous", msg.text, msg.date);

    }
    return "";
  });
});

// Schedule to persist chats map to file every X minutes.
setInterval(() => {
  fileIO.saveChatsToFile(chatRegistry.chats);
  console.info("Persisted data to file.");
}, config.persistenceRate * 60 * 1000);

// Schedule to persist chats map to file on program exit.
nodeCleanup((exitCode, signal) => {
  console.info("Persisting data to file before exiting...");
  fileIO.saveChatsToFile(chatRegistry.chats);
  return true;
});

// Generate new random dank times and schedule everything.
chatRegistry.chats.forEach((chat: Chat) => {
  chat.generateRandomDankTimes();
  scheduler.scheduleAllOfChat(chat);
});

// Generates random dank times daily for all chats and schedules notifications for them at every 00:00:00.
// Also, punishes players that have not scored in the past 24 hours.
const dailyUpdate = new cronJob("0 0 0 * * *", () => {
  console.info("Generating random dank times for all chats and punishing"
    + " users that haven't scored in the past 24 hours!");
  const now = moment().unix();
  chatRegistry.chats.forEach((chat: Chat) => {
    if (chat.running) {

      // Unschedule
      scheduler.unscheduleRandomDankTimesOfChat(chat);
      scheduler.unscheduleAutoLeaderboardsOfChat(chat);

      // Generate random dank times
      chat.generateRandomDankTimes();

      // Reschedule
      scheduler.scheduleRandomDankTimesOfChat(chat);
      scheduler.scheduleAutoLeaderboardsOfChat(chat);

      // Your punishment must be more severe!
      chat.hardcoreModeCheck(now);
    }
  });
}, undefined, true);

// Send a release log message to all chats, assuming there are release logs.
if (config.sendWhatsNewMsg && releaseLog.length > 0) {

  // Prepare message.
  let message = `<b>--- What's new in version ${releaseLog[0].version} ? ---</b>\n\n`;
  releaseLog[0].changes.forEach((change) => {
    message += `- ${change}\n`;
  });

  // Send it to all chats.
  chatRegistry.chats.forEach((chat: Chat) => {
    tgClient.sendMessage(chat.id, message);
  });

  // Update config so the what's new message is not sent on subsequent bot startups.
  config.sendWhatsNewMsg = false;
  fileIO.saveConfigToFile(config);
}

// Inform server.
console.info("Bot is now running!");
