import express from "express";
import * as line from "@line/bot-sdk";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import cron from "node-cron";
dotenv.config();

console.log("NEW VERSION LOADED");
dotenv.config();

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

app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  try {
    const userText = event.message.text;
    const userId = event.source.userId;

    const result = parseRelativeReminder(userText) || await parseReminder(userText);

    if (!result.title || !result.time) {
      await reply(event.replyToken, "我不太確定提醒時間，可以說：1分鐘後提醒我喝水，或明天早上10點提醒我開會");
      return;
    }

    const { error } = await supabase.from("reminders").insert({
      line_user_id: userId,
      raw_text: userText,
      title: result.title,
      remind_at: result.time,
      status: "scheduled",
    });

    if (error) throw error;

    await reply(
      event.replyToken,
      `已建立提醒 ✅\n提醒事項：${result.title}\n提醒時間：${result.time}`
    );
  } catch (error) {
    console.error(error);
    await reply(event.replyToken, "解析提醒失敗，請再試一次");
  }
}

function parseRelativeReminder(text) {
  const minuteMatch = text.match(/(\d+)\s*分鐘後提醒我(.+)/);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    const title = minuteMatch[2].trim();
    return {
      title,
      time: toTaipeiISOString(new Date(Date.now() + minutes * 60 * 1000)),
    };
  }

  const hourMatch = text.match(/(\d+)\s*小時後提醒我(.+)/);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    const title = hourMatch[2].trim();
    return {
      title,
      time: toTaipeiISOString(new Date(Date.now() + hours * 60 * 60 * 1000)),
    };
  }

  return null;
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
  "time": "2026-05-15T10:00:00+08:00"
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

      await supabase
        .from("reminders")
        .update({ status: "reminded" })
        .eq("id", reminder.id);

      console.log("提醒已發送:", reminder.title);
    } catch (err) {
      console.error("PUSH MESSAGE ERROR:", err);
    }
  }
});

app.listen(3000, () => {
  console.log("LINE Bot is running");
});