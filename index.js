import express from "express";
import * as line from "@line/bot-sdk";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import cron from "node-cron";
import axios from "axios";

dotenv.config();

console.log("NEW VERSION LOADED");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const EMM_BASE_URL = "https://61.60.107.10";

app.get("/", (req, res) => {
  res.send("LINE BOT RUNNING");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  try {
    const userText = event.message.text.trim();
    const userId = event.source.groupId || event.source.userId;
    if (/^綁定\s*EMM/i.test(userText)) {
      await bindEmmAccount(event.replyToken, userId, userText);
      return;
    }

    if (
      userText === "查待審核" ||
      userText === "待審核" ||
      userText === "查故障單" ||
      userText === "我的故障單"
    ) {
      await listEmmMaintainReports(event.replyToken, userId);
      return;
    }
    if (isTodayReminderIntent(userText)) {
      await listTodayReminders(event.replyToken, userId);
      return;
    }

    if (isFutureReminderIntent(userText)) {
      await listFutureReminders(event.replyToken, userId);
      return;
    }
    if (userText === "EMM表單查詢") {
          await reply(
            event.replyToken,
            `EMM 功能測試中 🚧

        目前可使用：

        1. 綁定 EMM 帳號

        格式：

        綁定EMM
        帳號：你的帳號
        密碼：你的密碼

        2. 查待審核

        輸入：
        查待審核`
          );
          return;
        }
    if (userText === "建立提醒") {
      await reply(
        event.replyToken,
        "請輸入提醒，例如：\n\n明天早上8點提醒我開會\n今天下午5點提醒我下班\n3分鐘後提醒我喝水\n兩小時後提醒我開會\n三天後提醒我繳費"
      );
      return;
    }

    if (userText === "建立每日提醒") {
      await reply(
        event.replyToken,
        "請輸入每日提醒，例如：\n\n每天早上8點提醒我吃藥\n每天晚上9點提醒我運動\n每天12點提醒我吃飯"
      );
      return;
    }

    if (userText === "如何刪除提醒") {
      await reply(
        event.replyToken,
        "請先輸入「今日待辦」或「未來提醒」查看列表，然後輸入：\n\n刪除今日第1個提醒\n刪除未來第1個提醒"
      );
      return;
    }

    if (userText === "使用說明") {
      await reply(
        event.replyToken,
        "你可以這樣使用：\n\n1. 今日待辦\n2. 未來提醒\n3. 明天早上8點提醒我開會\n4. 3分鐘後提醒我喝水\n5. 十三分鐘後提醒我下班\n6. 兩小時後提醒我開會\n7. 三天後提醒我繳費\n8. 每天早上8點提醒我吃藥\n9. 每週五下午5點提醒我交報告\n10. 每月4號提醒我要做安衛檢查表\n11. 刪除今日第1個提醒\n12. 刪除未來第1個提醒"
      );
      return;
    }
    
    const deleteTodayMatch = userText.match(
      /(刪除|刪掉|移除|取消)(今天|今日)?第?([0-9一二兩三四五六七八九十百]+)(個)?(提醒|待辦)?/
    );

    if (deleteTodayMatch) {
      const deleteNumber = parseNumberText(deleteTodayMatch[3]);
      await deleteTodayReminder(event.replyToken, userId, deleteNumber);
      return;
    }

    const deleteFutureMatch = userText.match(
      /(刪除|刪掉|移除|取消)(未來)?第?([0-9一二兩三四五六七八九十百]+)(個)?(提醒|待辦)?/
    );

    if (deleteFutureMatch) {
      const deleteNumber = parseNumberText(deleteFutureMatch[3]);
      await deleteFutureReminder(event.replyToken, userId, deleteNumber);
      return;
    }

    const result =
      parseRelativeReminder(userText) ||
      parseDailyReminder(userText) ||
      parseWeeklyReminder(userText) ||
      parseMonthlyReminder(userText) ||
      await parseReminder(userText);

    if (!result.title || !result.time) {
      await reply(
        event.replyToken,
        "我不太確定提醒時間，可以說：\n\n明天早上8點提醒我開會\n3分鐘後提醒我喝水\n兩小時後提醒我開會\n三天後提醒我繳費\n每天早上8點提醒我吃藥\n每週五提醒我交報告\n每月4號提醒我要做安衛檢查表"
      );
      return;
    }

    const { error } = await supabase.from("reminders").insert({
      line_user_id: userId,
      raw_text: userText,
      title: result.title,
      remind_at: result.time,
      status: "scheduled",
      repeat_type: result.repeat_type || "none",
      repeat_time: result.repeat_time || null,
      repeat_day: result.repeat_day || null,
    });

    if (error) throw error;

    await reply(
      event.replyToken,
      `已建立提醒 ✅\n提醒事項：${result.title}\n提醒時間：${formatTaipeiTime(result.time)}` +
        getRepeatText(result)
    );
  } catch (error) {
    console.error(error);
    await reply(event.replyToken, "解析提醒失敗，請再試一次");
  }
}

function getRepeatText(result) {
  if (result.repeat_type === "daily") return "\n重複：每天";
  if (result.repeat_type === "weekly") return "\n重複：每週";
  if (result.repeat_type === "monthly") return "\n重複：每月";
  return "";
}

function isTodayReminderIntent(text) {
  const keywords = [
    "今日待辦",
    "今天待辦",
    "今天要做什麼",
    "我今天要做什麼",
    "今天有什麼事",
    "今天有什麼提醒",
    "今天有什麼待辦",
    "今天要幹嘛",
    "今天有啥",
    "今日提醒",
  ];

  return keywords.some((keyword) => text.includes(keyword));
}

function isFutureReminderIntent(text) {
  const keywords = [
    "我的提醒",
    "查看提醒",
    "提醒列表",
    "未來提醒",
    "未來待辦",
    "接下來要做什麼",
    "接下來要幹嘛",
    "之後要做什麼",
    "未來要做什麼",
    "所有提醒",
    "我的行程",
  ];

  return keywords.some((keyword) => text.includes(keyword));
}

function chineseNumberToInt(text) {
  const map = {
    零: 0,
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (/^\d+$/.test(text)) return Number(text);

  if (text === "十") return 10;

  if (text.includes("百")) {
    const [hundredPart, restPart = ""] = text.split("百");
    const hundred = (map[hundredPart] || 1) * 100;
    return hundred + (restPart ? chineseNumberToInt(restPart) : 0);
  }

  if (text.includes("十")) {
    const [tenPart, onePart = ""] = text.split("十");
    const ten = tenPart === "" ? 10 : map[tenPart] * 10;
    const one = onePart === "" ? 0 : map[onePart];
    return ten + one;
  }

  return map[text] ?? null;
}

function parseNumberText(text) {
  if (/^\d+$/.test(text)) return Number(text);
  return chineseNumberToInt(text);
}

function parseRelativeReminder(text) {
  const match = text.match(
    /([0-9一二兩三四五六七八九十百]+)\s*(分鐘|分|小時|鐘頭|天|日)後(?:提醒我|跟我說|告訴我|叫我|提醒)?(.+)/
  );

  if (!match) return null;

  const amount = parseNumberText(match[1]);
  const unit = match[2];
  const title = match[3].trim();

  if (!amount || !title) return null;

  let milliseconds = 0;

  if (unit === "分鐘" || unit === "分") {
    milliseconds = amount * 60 * 1000;
  } else if (unit === "小時" || unit === "鐘頭") {
    milliseconds = amount * 60 * 60 * 1000;
  } else if (unit === "天" || unit === "日") {
    milliseconds = amount * 24 * 60 * 60 * 1000;
  }

  return {
    title,
    time: toTaipeiISOString(new Date(Date.now() + milliseconds)),
    repeat_type: "none",
    repeat_time: null,
    repeat_day: null,
  };
}

function cleanReminderTitle(title) {
  return title
    .trim()
    .replace(/^(提醒我|跟我說|告訴我|叫我|提醒|要|幫我|請我)/, "")
    .trim();
}
function parseDailyReminder(text) {
  const match = text.match(
    /(?:每天|每日)\s*(早上|上午|中午|下午|晚上)?\s*([0-9一二兩三四五六七八九十百]+)\s*點\s*(?:(半)|([0-9一二兩三四五六七八九十百]+)\s*分?)?\s*(.*)/
  );

  if (!match) return null;

  const period = match[1] || "";
  let hour = parseNumberText(match[2]);

  let minute = 0;
  if (match[3]) {
    minute = 30;
  } else if (match[4]) {
    minute = parseNumberText(match[4]);
  }

  const title = cleanReminderTitle(match[5]);

  if (hour === null || hour === undefined || !title) return null;
  if (minute === null || minute === undefined) return null;

  hour = convertTo24Hour(period, hour);

  const remindAt = nextTaipeiTime(hour, minute);

  return {
    title,
    time: toTaipeiISOString(remindAt),
    repeat_type: "daily",
    repeat_time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    repeat_day: null,
  };
}

function parseWeeklyReminder(text) {
  const match = text.match(
    /(?:每週|每周|每星期|每禮拜)\s*([一二三四五六日天1234567])\s*(早上|上午|中午|下午|晚上)?\s*([0-9一二兩三四五六七八九十百]+)?\s*點?\s*(?:(半)|([0-9一二兩三四五六七八九十百]+)\s*分?)?\s*(.*)/
  );

  if (!match) return null;

  const weekMap = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 0,
    天: 0,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 0,
  };

  const repeatDay = weekMap[match[1]];
  const period = match[2] || "";
  let hour = match[3] ? parseNumberText(match[3]) : 9;

  let minute = 0;
  if (match[4]) {
    minute = 30;
  } else if (match[5]) {
    minute = parseNumberText(match[5]);
  }

  const title = cleanReminderTitle(match[6]);

  if (repeatDay === undefined || hour === null || hour === undefined || !title) return null;
  if (minute === null || minute === undefined) return null;

  hour = convertTo24Hour(period, hour);

  const remindAt = nextWeeklyTime(repeatDay, hour, minute);

  return {
    title,
    time: toTaipeiISOString(remindAt),
    repeat_type: "weekly",
    repeat_time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    repeat_day: repeatDay,
  };
}

function parseMonthlyReminder(text) {
  const match = text.match(
    /(?:每個月|每月)\s*的?\s*([0-9一二兩三四五六七八九十百]+)\s*(?:號|日)?\s*(早上|上午|中午|下午|晚上)?\s*([0-9一二兩三四五六七八九十百]+)?\s*點?\s*(?:(半)|([0-9一二兩三四五六七八九十百]+)\s*分?)?\s*(.*)/
  );

  if (!match) return null;

  const repeatDay = parseNumberText(match[1]);
  const period = match[2] || "";
  let hour = match[3] ? parseNumberText(match[3]) : 9;

  let minute = 0;
  if (match[4]) {
    minute = 30;
  } else if (match[5]) {
    minute = parseNumberText(match[5]);
  }

  const title = cleanReminderTitle(match[6]);

  if (!repeatDay || repeatDay < 1 || repeatDay > 31) return null;
  if (hour === null || hour === undefined || !title) return null;
  if (minute === null || minute === undefined) return null;

  hour = convertTo24Hour(period, hour);

  const remindAt = nextMonthlyTime(repeatDay, hour, minute);

  return {
    title,
    time: toTaipeiISOString(remindAt),
    repeat_type: "monthly",
    repeat_time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    repeat_day: repeatDay,
  };
}

function convertTo24Hour(period, hour) {
  if ((period === "下午" || period === "晚上") && hour < 12) {
    return hour + 12;
  }

  if (period === "中午") {
    return 12;
  }

  return hour;
}

function nextTaipeiTime(hour, minute) {
  const taipeiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);

  const year = taipeiNow.getUTCFullYear();
  const month = taipeiNow.getUTCMonth();
  const day = taipeiNow.getUTCDate();

  let targetTaipei = new Date(Date.UTC(year, month, day, hour, minute, 0));

  if (targetTaipei <= taipeiNow) {
    targetTaipei = new Date(targetTaipei.getTime() + 24 * 60 * 60 * 1000);
  }

  return new Date(targetTaipei.getTime() - 8 * 60 * 60 * 1000);
}

function nextWeeklyTime(targetDay, hour, minute) {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const currentDay = taipeiNow.getUTCDay();
  let addDays = targetDay - currentDay;

  let targetTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + addDays,
    hour,
    minute,
    0
  ));

  if (targetTaipei <= taipeiNow) {
    targetTaipei = new Date(targetTaipei.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  return new Date(targetTaipei.getTime() - 8 * 60 * 60 * 1000);
}

function nextMonthlyTime(day, hour, minute) {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  let year = taipeiNow.getUTCFullYear();
  let month = taipeiNow.getUTCMonth();

  let targetTaipei = new Date(Date.UTC(year, month, day, hour, minute, 0));

  if (targetTaipei.getUTCMonth() !== month || targetTaipei <= taipeiNow) {
    month += 1;
    targetTaipei = new Date(Date.UTC(year, month, day, hour, minute, 0));
  }

  return new Date(targetTaipei.getTime() - 8 * 60 * 60 * 1000);
}

function getTodayRangeUtc() {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const year = taipeiNow.getUTCFullYear();
  const month = taipeiNow.getUTCMonth();
  const day = taipeiNow.getUTCDate();

  const startTaipei = new Date(Date.UTC(year, month, day, 0, 0, 0));
  const endTaipei = new Date(Date.UTC(year, month, day + 1, 0, 0, 0));

  return {
    startUtc: new Date(startTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    endUtc: new Date(endTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

function toTaipeiISOString(date) {
  const taipeiTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return taipeiTime.toISOString().replace("Z", "+08:00");
}

function formatTaipeiTime(value) {
  const date = new Date(value);

  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function parseReminder(text) {
  const now = new Date().toISOString();

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: `
你是 LINE 提醒事項解析器。

現在時間是 ${now}。
時區是 Asia/Taipei。

請把使用者輸入解析成 JSON。
只回 JSON，不要解釋，不要 markdown。

格式：
{
  "title": "提醒事項",
  "time": "2026-05-15T10:00:00+08:00",
  "repeat_type": "none",
  "repeat_time": null
}

規則：
1. title 是使用者要被提醒的事情。
2. time 必須是 ISO 8601 格式，並且使用 +08:00。
3. 「明天早上10點」= 明天 10:00。
4. 「今天晚上5點」= 今天 17:00。
5. 「晚上8點」= 20:00。
6. 「下午5點」= 17:00。
7. 「早上10點」= 10:00。
8. 如果只有「下午」沒有幾點，預設 15:00。
9. 如果只有「晚上」沒有幾點，預設 20:00。
10. 如果只有「早上」沒有幾點，預設 09:00。
11. 如果完全沒有日期但有時間，預設今天；如果已經過了，改成明天。
12. 如果時間真的無法判斷，time 回 null。
13. 每日重複提醒請回 repeat_type: "daily"，否則 repeat_type: "none"。
        `,
      },
      {
        role: "user",
        content: text,
      },
    ],
    response_format: {
      type: "json_object",
    },
  });

  const content = response.choices[0].message.content;
  console.log("AI RESPONSE:");
  console.log(content);

  return JSON.parse(content);
}

async function listTodayReminders(replyToken, userId) {
  const { startUtc, endUtc } = getTodayRangeUtc();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .gte("remind_at", startUtc)
    .lt("remind_at", endUtc)
    .order("remind_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢今日待辦失敗，請再試一次");
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, "你今天目前沒有待辦提醒");
    return;
  }

  const text = data
    .map((item, index) => {
      const repeatText =
        item.repeat_type === "daily" ? "（每天）" :
        item.repeat_type === "weekly" ? "（每週）" :
        item.repeat_type === "monthly" ? "（每月）" : "";

      return `${index + 1}. ${item.title}${repeatText}\n時間：${formatTaipeiTime(item.remind_at)}`;
    })
    .join("\n\n");

  await reply(replyToken, `你今天的待辦：\n\n${text}\n\n要刪除請輸入：刪除今日第1個提醒`);
}

async function listFutureReminders(replyToken, userId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .gte("remind_at", now)
    .order("remind_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢提醒失敗，請再試一次");
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, "你目前沒有未來提醒");
    return;
  }

  const text = data
    .map((item, index) => {
      const repeatText =
        item.repeat_type === "daily" ? "（每天）" :
        item.repeat_type === "weekly" ? "（每週）" :
        item.repeat_type === "monthly" ? "（每月）" : "";

      return `${index + 1}. ${item.title}${repeatText}\n時間：${formatTaipeiTime(item.remind_at)}`;
    })
    .join("\n\n");

  await reply(replyToken, `你的未來提醒：\n\n${text}\n\n要刪除請輸入：刪除未來第1個提醒`);
}

async function deleteTodayReminder(replyToken, userId, number) {
  const { startUtc, endUtc } = getTodayRangeUtc();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .gte("remind_at", startUtc)
    .lt("remind_at", endUtc)
    .order("remind_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢今日提醒失敗，請再試一次");
    return;
  }

  const target = data?.[number - 1];

  if (!target) {
    await reply(replyToken, "找不到這個今日提醒編號");
    return;
  }

  const { error: updateError } = await supabase
    .from("reminders")
    .update({ status: "deleted" })
    .eq("id", target.id);

  if (updateError) {
    console.error(updateError);
    await reply(replyToken, "刪除今日提醒失敗，請再試一次");
    return;
  }

  await reply(replyToken, `已刪除今日提醒：${target.title}`);
}

async function deleteFutureReminder(replyToken, userId, number) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .gte("remind_at", now)
    .order("remind_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢未來提醒失敗，請再試一次");
    return;
  }

  const target = data?.[number - 1];

  if (!target) {
    await reply(replyToken, "找不到這個未來提醒編號");
    return;
  }

  const { error: updateError } = await supabase
    .from("reminders")
    .update({ status: "deleted" })
    .eq("id", target.id);

  if (updateError) {
    console.error(updateError);
    await reply(replyToken, "刪除未來提醒失敗，請再試一次");
    return;
  }

  await reply(replyToken, `已刪除未來提醒：${target.title}`);
}

function parseBindEmmText(text) {
  const accountMatch = text.match(/帳號[:：\s]+([^\s\n]+)/);
  const passwordMatch = text.match(/密碼[:：\s]+([^\s\n]+)/);

  if (!accountMatch || !passwordMatch) return null;

  return {
    username: accountMatch[1].trim(),
    password: passwordMatch[1].trim(),
  };
}

function cookieArrayToString(cookies) {
  if (!cookies || cookies.length === 0) return "";
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function loginEmm(username, password) {
  const response = await axios.post(
    `${EMM_BASE_URL}/api/auth/login`,
    {
      account: username,
      password: password,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    }
  );

  if (response.status !== 200) {
    throw new Error(
      response.data?.error ||
      response.data?.message ||
      "EMM 登入失敗"
    );
  }

  const cookie = cookieArrayToString(response.headers["set-cookie"]);

  if (!cookie) {
    throw new Error("EMM 登入成功，但沒有取得 Cookie");
  }

  return cookie;
}

async function bindEmmAccount(replyToken, userId, text) {
  const parsed = parseBindEmmText(text);

  if (!parsed) {
    await reply(
      replyToken,
      "請用這個格式綁定：\n\n綁定EMM\n帳號：你的帳號\n密碼：你的密碼"
    );
    return;
  }

  try {
    const cookie = await loginEmm(parsed.username, parsed.password);

    const { error } = await supabase
      .from("emm_accounts")
      .upsert(
        {
          line_user_id: userId,
          emm_username: parsed.username,
          emm_password: parsed.password,
          emm_cookie: cookie,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "line_user_id",
        }
      );

    if (error) throw error;

    await reply(replyToken, "EMM 帳號綁定成功 ✅\n你現在可以輸入：查待審核");
  } catch (err) {
    console.error("EMM BIND ERROR:", err);
    await reply(replyToken, `EMM 綁定失敗：${err.message}`);
  }
}

async function getEmmAccount(userId) {
  const { data, error } = await supabase
    .from("emm_accounts")
    .select("*")
    .eq("line_user_id", userId)
    .single();

  if (error || !data) return null;
  return data;
}

async function refreshEmmCookie(account) {
  const cookie = await loginEmm(account.emm_username, account.emm_password);

  await supabase
    .from("emm_accounts")
    .update({
      emm_cookie: cookie,
      updated_at: new Date().toISOString(),
    })
    .eq("line_user_id", account.line_user_id);

  return cookie;
}

async function fetchMaintainReports(cookie) {
  const payload = {
    query: `
      {
        viewmaintainreportByParam(
          area: "__",
          id: null,
          contract_id: null,
          contractor_name: null,
          class_id: null,
          item_id: null,
          equip_id: null,
          road: null,
          road_direction: null,
          start: null,
          end: null,
          announce_state: 2,
          current_node: 3962,
          multikey: null
        ) {
          id
          announce_num
          report_num
          announce_date
          maintain_date
          maintain_person
          description
          equip_name
          item_name
          class_name
          area
          contract_name
          contractor_name
          road
          road_direction
          location
          announce_state
          announce_state_name
          multikey
          multikey_name
          undertaker
          supervisor
          flow_id
        }
      }
    `,
  };

  const response = await axios.post(
    `${EMM_BASE_URL}/api/getViewMaintainReport`,
    payload,
    {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      validateStatus: () => true,
    }
  );

  if (response.status !== 200) {
    throw new Error(
      response.data?.error ||
      response.data?.message ||
      `EMM 查詢失敗：${response.status}`
    );
  }

  return response.data?.data?.viewmaintainreportByParam || [];
}

function formatMaintainReports(reports) {
  if (!reports || reports.length === 0) {
    return "目前沒有待審核故障單";
  }

  const topReports = reports.slice(0, 10);

  const text = topReports
    .map((item, index) => {
      return `${index + 1}. ${item.equip_name || "未填設備"}
單號：${item.announce_num || item.report_num || "無"}
狀態：${item.announce_state_name || "無"}
路線：${item.road || "無"} ${item.road_direction || ""}
地點：${item.location || "無"}
承辦：${item.undertaker || "無"}
主管：${item.supervisor || "無"}`;
    })
    .join("\n\n");

  return `待審核故障單：\n\n${text}`;
}

async function listEmmMaintainReports(replyToken, userId) {
  const account = await getEmmAccount(userId);

  if (!account) {
    await reply(
      replyToken,
      "你還沒有綁定 EMM 帳號。\n\n請輸入：\n綁定EMM\n帳號：你的帳號\n密碼：你的密碼"
    );
    return;
  }

  try {
    let reports;

    try {
      reports = await fetchMaintainReports(account.emm_cookie);
    } catch (err) {
      const newCookie = await refreshEmmCookie(account);
      reports = await fetchMaintainReports(newCookie);
    }

    await reply(replyToken, formatMaintainReports(reports));
  } catch (err) {
    console.error("EMM REPORT ERROR:", err);
    await reply(replyToken, `查詢 EMM 失敗：${err.message}`);
  }
}
async function reply(replyToken, text) {
  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: "text",
        text,
      },
    ],
  });
}

cron.schedule("*/15 * * * * *", async () => {
  try {
    const now = new Date().toISOString();

    // 往前補抓10分鐘，避免漏提醒
    const lookback = new Date(
      Date.now() - 10 * 60 * 1000
    ).toISOString();

    const { data, error } = await supabase
      .from("reminders")
      .select("*")
      .eq("status", "scheduled")
      .lte("remind_at", now)
      .gte("remind_at", lookback)
      .order("remind_at", { ascending: true });

    if (error) {
      console.error("REMINDER CHECK ERROR:", error);
      return;
    }

    for (const reminder of data || []) {
      try {

        // 防止重複發送
        

        await supabase
          .from("reminders")
          .update({
            status: "reminded",
          })
          .eq("id", reminder.id);
        await client.pushMessage({
          to: reminder.line_user_id,
          messages: [
            {
              type: "text",
              text: `提醒你：${reminder.title}`,
            },
          ],
        });

        // 每日提醒
        if (reminder.repeat_type === "daily") {

          const [hour, minute] =
            reminder.repeat_time.split(":").map(Number);

          const nextTime = nextTaipeiTime(hour, minute);

          const { error: updateError } = await supabase
            .from("reminders")
            .update({
              remind_at: toTaipeiISOString(nextTime),
              status: "scheduled",
            })
            .eq("id", reminder.id);

          if (updateError) {
            console.error(updateError);
          }

        // 每週提醒
        } else if (reminder.repeat_type === "weekly") {

          const [hour, minute] =
            reminder.repeat_time.split(":").map(Number);

          const nextTime = nextWeeklyTime(
            reminder.repeat_day,
            hour,
            minute
          );

          await supabase
            .from("reminders")
            .update({
              remind_at: toTaipeiISOString(nextTime),
              status: "scheduled",
            })
            .eq("id", reminder.id);

        // 每月提醒
        } else if (reminder.repeat_type === "monthly") {

          const [hour, minute] =
            reminder.repeat_time.split(":").map(Number);

          const nextTime = nextMonthlyTime(
            reminder.repeat_day,
            hour,
            minute
          );

          await supabase
            .from("reminders")
            .update({
              remind_at: toTaipeiISOString(nextTime),
              status: "scheduled",
            })
            .eq("id", reminder.id);

        // 單次提醒
        } else {

          await supabase
            .from("reminders")
            .update({
              status: "reminded",
            })
            .eq("id", reminder.id);
        }

        console.log(
          "提醒已發送:",
          reminder.title,
          reminder.remind_at
        );

      } catch (err) {
        console.error("PUSH MESSAGE ERROR:", err);

        // 發送失敗還原狀態
        await supabase
          .from("reminders")
          .update({
            status: "scheduled",
          })
          .eq("id", reminder.id);
      }
    }

  } catch (err) {
    console.error("CRON ERROR:", err);
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`LINE Bot is running on port ${port}`);
});