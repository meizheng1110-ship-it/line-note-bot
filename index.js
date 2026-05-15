import express from "express";
import * as line from "@line/bot-sdk";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import cron from "node-cron";

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
    const userId = event.source.userId;

    if (isListReminderIntent(userText)) {
      await listReminders(event.replyToken, userId);
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
        "請先輸入「我的提醒」查看列表，然後輸入：\n\n刪除第1個提醒\n刪除第2個提醒"
      );
      return;
    }

    const deleteMatch = userText.match(/刪除第(\d+)個提醒/);
    if (deleteMatch) {
      await deleteReminder(event.replyToken, userId, Number(deleteMatch[1]));
      return;
    }

    const result =
      parseRelativeReminder(userText) ||
      parseDailyReminder(userText) ||
      await parseReminder(userText);

    if (!result.title || !result.time) {
      await reply(
        event.replyToken,
        "我不太確定提醒時間，可以說：1分鐘後提醒我喝水，或每天早上8點提醒我吃藥"
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
    });

    if (error) throw error;

    await reply(
      event.replyToken,
      `已建立提醒 ✅\n提醒事項：${result.title}\n提醒時間：${result.time}` +
        (result.repeat_type === "daily" ? "\n重複：每天" : "")
    );
  } catch (error) {
    console.error(error);
    await reply(event.replyToken, "解析提醒失敗，請再試一次");
  }
}

function isListReminderIntent(text) {
  const keywords = [
    "我的提醒",
    "查看提醒",
    "提醒列表",
    "待辦",
    "每日待辦",
    "今天待辦",
    "今天要做什麼",
    "我今天要做什麼",
    "今天有什麼事",
    "今天有什麼提醒",
    "我今天有什麼提醒",
    "每天要做什麼",
    "每日要做什麼",
    "行程",
    "我的行程",
  ];

  return keywords.some((keyword) => text.includes(keyword));
}

function parseRelativeReminder(text) {
  const minuteMatch = text.match(/(\d+)\s*分鐘後提醒我(.+)/);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    const title = minuteMatch[2].trim();

    return {
      title,
      time: toTaipeiISOString(new Date(Date.now() + minutes * 60 * 1000)),
      repeat_type: "none",
      repeat_time: null,
    };
  }

  const hourMatch = text.match(/(\d+)\s*小時後提醒我(.+)/);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    const title = hourMatch[2].trim();

    return {
      title,
      time: toTaipeiISOString(new Date(Date.now() + hours * 60 * 60 * 1000)),
      repeat_type: "none",
      repeat_time: null,
    };
  }

  return null;
}

function parseDailyReminder(text) {
  const match = text.match(
    /(?:每天|每日)(早上|上午|中午|下午|晚上)?\s*(\d{1,2})點(?:半)?提醒我(.+)/
  );

  if (!match) return null;

  const period = match[1] || "";
  let hour = Number(match[2]);
  const minute = text.includes("半") ? 30 : 0;
  const title = match[3].trim();

  if ((period === "下午" || period === "晚上") && hour < 12) {
    hour += 12;
  }

  if (period === "中午") {
    hour = 12;
  }

  const remindAt = nextTaipeiTime(hour, minute);

  return {
    title,
    time: toTaipeiISOString(remindAt),
    repeat_type: "daily",
    repeat_time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function nextTaipeiTime(hour, minute) {
  const now = new Date();

  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = taipeiNow.getUTCFullYear();
  const month = taipeiNow.getUTCMonth();
  const day = taipeiNow.getUTCDate();

  let targetTaipei = new Date(Date.UTC(year, month, day, hour, minute, 0));

  if (targetTaipei <= taipeiNow) {
    targetTaipei = new Date(targetTaipei.getTime() + 24 * 60 * 60 * 1000);
  }

  return new Date(targetTaipei.getTime() - 8 * 60 * 60 * 1000);
}

function toTaipeiISOString(date) {
  const taipeiTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return taipeiTime.toISOString().replace("Z", "+08:00");
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

async function listReminders(replyToken, userId) {
  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .order("remind_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢提醒失敗，請再試一次");
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, "你目前沒有未完成提醒");
    return;
  }

  const text = data
    .map((item, index) => {
      const repeatText = item.repeat_type === "daily" ? "（每天）" : "";
      return `${index + 1}. ${item.title}${repeatText}\n時間：${item.remind_at}`;
    })
    .join("\n\n");

  await reply(replyToken, `你的提醒：\n\n${text}\n\n要刪除請輸入：刪除第1個提醒`);
}

async function deleteReminder(replyToken, userId, number) {
  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .order("remind_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢提醒失敗，請再試一次");
    return;
  }

  const target = data[number - 1];

  if (!target) {
    await reply(replyToken, "找不到這個提醒編號");
    return;
  }

  const { error: updateError } = await supabase
    .from("reminders")
    .update({ status: "deleted" })
    .eq("id", target.id);

  if (updateError) {
    console.error(updateError);
    await reply(replyToken, "刪除失敗，請再試一次");
    return;
  }

  await reply(replyToken, `已刪除提醒：${target.title}`);
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

cron.schedule("* * * * *", async () => {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .lte("remind_at", now)
    .eq("status", "scheduled");

  if (error) {
    console.error("REMINDER CHECK ERROR:", error);
    return;
  }

  for (const reminder of data || []) {
    try {
      await client.pushMessage({
        to: reminder.line_user_id,
        messages: [
          {
            type: "text",
            text: `提醒你：${reminder.title}`,
          },
        ],
      });

      if (reminder.repeat_type === "daily") {
        const [hour, minute] = reminder.repeat_time.split(":").map(Number);
        const nextTime = nextTaipeiTime(hour, minute);

        await supabase
          .from("reminders")
          .update({
            remind_at: toTaipeiISOString(nextTime),
            status: "scheduled",
          })
          .eq("id", reminder.id);
      } else {
        await supabase
          .from("reminders")
          .update({ status: "reminded" })
          .eq("id", reminder.id);
      }

      console.log("提醒已發送:", reminder.title);
    } catch (err) {
      console.error("PUSH MESSAGE ERROR:", err);
    }
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`LINE Bot is running on port ${port}`);
});