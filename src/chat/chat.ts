import { Moment } from "moment";
import { DankTime } from "../dank-time/dank-time";
import {
  LeaderboardResetPluginEventArguments,
} from "../plugin-host/plugin-events/event-arguments/leaderboard-reset-plugin-event-arguments";
import {
  PrePostMessagePluginEventArguments,
} from "../plugin-host/plugin-events/event-arguments/pre-post-message-plugin-event-arguments";
import {
  UserScoreChangedPluginEventArguments,
} from "../plugin-host/plugin-events/event-arguments/user-score-changed-plugin-event-arguments";
import { PluginEvent } from "../plugin-host/plugin-events/plugin-event-types";
import { PluginHost } from "../plugin-host/plugin-host";
import { IUtil } from "../util/i-util";
import { BasicChat } from "./basic-chat";
import { Leaderboard } from "./leaderboard/leaderboard";
import { ChatSetting } from "./settings/chat-setting";
import { CoreSettingsNames } from "./settings/core-settings-names";
import { User } from "./user/user";

const handicapMultiplier = 1.5;
const bottomPartThatHasHandicap = 0.25;

const punishByFraction = 0.1;
const punishByPoints = 10;

export class Chat {

  public awaitingResetConfirmation = -1;

  private myId: number;
  private myLastHour: number;
  private myLastMinute: number;
  private myLastLeaderboard?: Leaderboard = undefined;
  private pluginHost: PluginHost;

  /**
   * Creates a new Chat object.
   * @param moment Reference to timezone import.
   * @param util Utility functions.
   * @param id The chat's unique Telegram id.
   * @param pluginhost This chat's plugin host.
   * @param running Whether this bot is running for this chat.
   * @param lastHour The hour of the last valid dank time being proclaimed.
   * @param lastMinute The minute of the last valid dank time being proclaimed.
   * @param users A map with the users, indexed by user id's.
   * @param dankTimes The dank times known in this chat.
   * @param randomDankTimes The daily randomly generated dank times in this chat.
   * @param settings This chat's settings.
   */
  constructor(
    private readonly moment: any,
    private readonly util: IUtil,
    id: number,
    pluginhost: PluginHost,
    public running = false,
    lastHour = 0,
    lastMinute = 0,
    private readonly users = new Map<number, User>(),
    public readonly dankTimes = new Array<DankTime>(),
    public randomDankTimes = new Array<DankTime>(),
    private readonly settings = new Map<string, ChatSetting<any>>()) {

    this.id = id;
    this.lastHour = lastHour;
    this.lastMinute = lastMinute;
    this.pluginHost = pluginhost;
    this.pluginHost.chat = this;
    this.pluginHost.trigger(PluginEvent.PostInit, "");
  }

  public set id(id: number) {
    if (id % 1 !== 0) {
      throw new RangeError("The id must be a whole number!");
    }
    this.myId = id;
  }

  public get id(): number {
    return this.myId;
  }

  public get timezone(): string {
    return String(this.settings.get(CoreSettingsNames.timezone));
  }

  public set lastHour(lastHour: number) {
    if (lastHour < 0 || lastHour > 23 || lastHour % 1 !== 0) {
      throw new RangeError("The hour must be a whole number between 0 and 23!");
    }
    this.myLastHour = lastHour;
  }

  public get lastHour(): number {
    return this.myLastHour;
  }

  public set lastMinute(lastMinute: number) {
    if (lastMinute < 0 || lastMinute > 59 || lastMinute % 1 !== 0) {
      throw new RangeError("The minute must be a whole number between 0 and 59!");
    }
    this.myLastMinute = lastMinute;
  }

  public get lastMinute(): number {
    return this.myLastMinute;
  }

  public get numberOfRandomTimes(): number {
    return Number(this.settings.get(CoreSettingsNames.numberOfRandomTimes));
  }

  public get multiplier(): number {
    return Number(this.settings.get(CoreSettingsNames.multiplier));
  }

  public get pointsPerRandomTime(): number {
    return Number(this.settings.get(CoreSettingsNames.pointsPerRandomTime));
  }

  public get pluginhost(): PluginHost {
    return this.pluginHost;
  }

  /**
   * Sets the setting with the supplied name, throwing an exception if the
   * setting does not exist or the supplied value is incorrect.
   * @param name The name of the setting to set.
   * @param value The value of the setting to set.
   */
  public setSetting(name: string, value: string) {
    if (!this.settings.has(name)) {
      throw new RangeError("This setting does not exist!");
    }
    const setting = this.settings.get(name) as ChatSetting<any>;
    setting.setValueFromString(value);
  }

  /**
   * Adds a new normal dank time to this chat, replacing any dank time that has
   * the same hour and minute.
   */
  public addDankTime(dankTime: DankTime): void {
    const existing = this.getDankTime(dankTime.hour, dankTime.minute);
    if (existing) {
      this.dankTimes.splice(this.dankTimes.indexOf(existing), 1);
    }
    this.dankTimes.push(dankTime);
    this.dankTimes.sort(DankTime.compare);
  }

  /**
   * Adds a user to this chat.
   */
  public addUser(user: User): void {
    this.users.set(user.id, user);
  }

  public removeUser(userId: number): User | null {
    const userToRemove = this.users.get(userId);
    this.users.delete(userId);
    return userToRemove ? userToRemove : null;
  }

  /**
   * Gets an array of the users, sorted by scores.
   */
  public sortedUsers(): User[] {
    const usersArr = new Array<User>();
    this.users.forEach((user) => usersArr.push(user));
    usersArr.sort(User.compare);
    return usersArr;
  }

  /**
   * Generates new random dank times for this chat, clearing old ones.
   */
  public generateRandomDankTimes(): DankTime[] {
    this.randomDankTimes = new Array<DankTime>();

    for (let i = 0; i < this.numberOfRandomTimes; i++) {
      const now = this.moment().tz(this.timezone);

      now.add(Math.floor(Math.random() * 23), "hours");
      now.minutes(Math.floor(Math.random() * 59));

      if (!this.hourAndMinuteAlreadyRegistered(now.hours(), now.minutes())) {
        const text = this.util.padNumber(now.hours()) + this.util.padNumber(now.minutes());
        this.randomDankTimes.push(new DankTime(now.hours(), now.minutes(), [text], this.pointsPerRandomTime));
      }
    }
    return this.randomDankTimes;
  }

  /**
   * Used by JSON.stringify. Returns a literal representation of this.
   */
  public toJSON(): BasicChat {

    const basicSettings = Array.from(this.settings.values()).map((setting) => {
      return {
        name: setting.name,
        value: setting.value,
      };
    });

    return {
      dankTimes: this.dankTimes,
      id: this.myId,
      lastHour: this.myLastHour,
      lastMinute: this.myLastMinute,
      running: this.running,
      settings: basicSettings,
      users: this.sortedUsers(),
    };
  }

  /**
   * Processes a message, awarding or punishing points etc. where applicable.
   * @returns A reply, or nothing if no reply is suitable/needed.
   */
  public processMessage(userId: number, userName: string, msgText: string, msgUnixTime: number): string[] {
    let output: string[] = [];
    const now: Moment = this.moment.tz(this.timezone);
    const messageTimeout: boolean = now.unix() - msgUnixTime >= 60;
    const awaitingReset: boolean = (this.awaitingResetConfirmation === userId);

    // Ignore the message if it was sent more than 1 minute ago.
    if (now.unix() - msgUnixTime >= 60) {
      return output;
    }
    // Pre-message event
    output = output.concat(this.pluginHost.trigger(PluginEvent.PreMesssage,
      new PrePostMessagePluginEventArguments(msgText)));

    // Check if leaderboard should be instead.
    if (awaitingReset) {
      output = output.concat(this.handleAwaitingReset(userId, userName, msgText, msgUnixTime));
    } else if (this.running) {
      output = output.concat(this.handleDankTimeInputMessage(userId, userName, msgText, msgUnixTime, now));
    }
    msgText = this.util.cleanText(msgText);

    // Post-message event
    output = output.concat(this.pluginHost.trigger(PluginEvent.PostMessage,
      new PrePostMessagePluginEventArguments(msgText)));
    return output;
  }

  /**
   * Resets the scores of all the users.
   */
  public resetScores(): void {
    this.users.forEach((user) => user.resetScore());
  }

  /**
   * Removes the dank time with the specified hour and minute.
   * @returns Whether a dank time was found and removed.
   */
  public removeDankTime(hour: number, minute: number): boolean {
    const dankTime = this.getDankTime(hour, minute);
    if (dankTime) {
      this.dankTimes.splice(this.dankTimes.indexOf(dankTime), 1);
      return true;
    }
    return false;
  }

  /**
   * Returns whether the leaderboard has changed since the last time this.generateLeaderboard(...) was generated.
   */
  public leaderboardChanged(): boolean {
    for (const user of this.users) {
      if (user[1].lastScoreChange !== 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Generates the leaderboard of this chat.
   * @param final If true, prints 'FINAL LEADERBOARD' instead of 'LEADERBOARD'.
   */
  public generateLeaderboard(final = false): string {

    // Construct string to return.
    const oldLeaderboard = this.myLastLeaderboard;
    this.myLastLeaderboard = new Leaderboard(Array.from(this.users.values()));
    let leaderboard = "<b>🏆 " + (final ? "FINAL " : "") + "LEADERBOARD</b>\n";
    leaderboard += this.myLastLeaderboard.toString(oldLeaderboard);

    // Reset last score change values of all users.
    const userIterator = this.users.values();
    let user = userIterator.next();
    while (!user.done) {
      user.value.resetLastScoreChange();
      user = userIterator.next();
    }
    return leaderboard;
  }

  /**
   * Gets the normal dank time that has the specified hour and minute.
   * @returns The dank time or null if none has the specified hour and minute.
   */
  public getDankTime(hour: number, minute: number): DankTime | null {
    for (const dankTime of this.dankTimes) {
      if (dankTime.hour === hour && dankTime.minute === minute) {
        return dankTime;
      }
    }
    return null;
  }

  public hardcoreModeCheck(timestamp: number) {
    if (this.hardcoreMode) {
      const day = 24 * 60 * 60;
      this.users.forEach((user) => {
        if (timestamp - user.lastScoreTimestamp >= day) {
          let punishBy = Math.round(user.score * punishByFraction);
          punishBy = Math.max(punishBy, punishByPoints);
          user.addToScore(-punishBy, timestamp);
        }
      });
    }
  }

  public removeUsersWithZeroScore(): void {
    this.users.forEach((user, id) => {
      if (user.score === 0) {
        this.users.delete(id);
      }
    });
  }

  private get hardcoreMode(): boolean {
    return Boolean(this.settings.get(CoreSettingsNames.hardcoreMode));
  }

  private get handicaps(): boolean {
    return Boolean(this.settings.get(CoreSettingsNames.handicaps));
  }

  private get firstNotifications(): boolean {
    return Boolean(this.settings.get(CoreSettingsNames.firstNotifications));
  }

  /**
   * Gets both normal and random dank times that have the specified text.
   */
  private getDankTimesByText(text: string): DankTime[] {
    const found = [];
    for (const dankTime of this.dankTimes.concat(this.randomDankTimes)) {
      if (dankTime.hasText(text)) {
        found.push(dankTime);
      }
    }
    return found;
  }

  private hourAndMinuteAlreadyRegistered(hour: number, minute: number): boolean {
    for (const dankTime of this.dankTimes) {
      if (dankTime.hour === hour && dankTime.minute === minute) {
        return true;
      }
    }
    for (const dankTime of this.randomDankTimes) {
      if (dankTime.hour === hour && dankTime.minute === minute) {
        return true;
      }
    }
    return false;
  }

  private userDeservesHandicapBonus(userId: number) {
    if (!this.handicaps || this.users.size < 2) {
      return false;
    }
    const sortedUsers = this.sortedUsers();
    let noOfHandicapped = sortedUsers.length * bottomPartThatHasHandicap;
    noOfHandicapped = Math.round(noOfHandicapped);
    const handicapped = sortedUsers.slice(-noOfHandicapped);

    for (const entry of handicapped) {
      if (entry.id === userId) {
        return true;
      }
    }
    return false;
  }

  private handleAwaitingReset(userId: number, userName: string, msgText: string, msgUnixTime: number): string[] {
    let output: string[] = [];

    if (this.awaitingResetConfirmation === userId) {
      this.awaitingResetConfirmation = -1;
      if (msgText.toUpperCase() === "YES") {
        output.push("Leaderboard has been reset!\n\n" + this.generateLeaderboard(true));
        this.users.forEach((user) => user.resetScore());
        output = output.concat(this.pluginHost.trigger(PluginEvent.LeaderboardReset,
          new LeaderboardResetPluginEventArguments(this)));
      }
    }
    return output;
  }

  private handleDankTimeInputMessage(userId: number, userName: string, msgText: string,
                                     msgUnixTime: number, now: Moment): string[] {
    let output: string[] = [];
    // Gather dank times from the sent text, returning if none was found.
    const dankTimesByText = this.getDankTimesByText(msgText);
    if (dankTimesByText.length < 1) {
      return output;
    }

    // Get the player, creating him if he doesn't exist yet.
    if (!this.users.has(userId)) {
      this.users.set(userId, new User(userId, userName));
    }
    const user = this.users.get(userId) as User;

    // Update user name if needed.
    if (user.name !== userName) {
      user.name = userName;
    }
    let subtractBy = 0;

    for (const dankTime of dankTimesByText) {
      if (now.hours() === dankTime.hour && now.minutes() === dankTime.minute) {

        // If cache needs resetting, do so and award DOUBLE points to the calling user.
        if (this.lastHour !== dankTime.hour || this.myLastMinute !== dankTime.minute) {
          this.users.forEach((user0) => user0.called = false);
          this.lastHour = dankTime.hour;
          this.lastMinute = dankTime.minute;
          let score = dankTime.points * this.multiplier;

          if (this.userDeservesHandicapBonus(user.id)) {
            score *= handicapMultiplier;
          }
          user.addToScore(Math.round(score), now.unix());
          output = output.concat(this.pluginHost.trigger(PluginEvent.UserScoreChange,
            new UserScoreChangedPluginEventArguments(user, Math.round(score))));
          user.called = true;

          if (this.firstNotifications) {
            output.push("👏 " + user.name + " was the first to score!");
          }
        } else if (user.called) { // Else if user already called this time, remove points.
          user.addToScore(-dankTime.points, now.unix());
          output = output.concat(this.pluginHost.trigger(PluginEvent.UserScoreChange,
            new UserScoreChangedPluginEventArguments(user, -dankTime.points)));
        } else {  // Else, award point.
          const score = Math.round(this.userDeservesHandicapBonus(user.id)
            ? dankTime.points * handicapMultiplier : dankTime.points);
          user.addToScore(score, now.unix());
          output = output.concat(this.pluginHost.trigger(PluginEvent.UserScoreChange,
            new UserScoreChangedPluginEventArguments(user, score)));
          user.called = true;
        }
        return output;
      } else if (dankTime.points > subtractBy) {
        subtractBy = dankTime.points;
      }
    }
    // If no match was found, punish the user.
    user.addToScore(-subtractBy, now.unix());
    output = output.concat(this.pluginHost.trigger(PluginEvent.UserScoreChange,
      new UserScoreChangedPluginEventArguments(user, -subtractBy)));
    return output;
  }
}
