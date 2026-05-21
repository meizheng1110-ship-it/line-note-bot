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

app.get("/health", (req, res) => {
  res.status(200).send("OK");
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

    // 1. AI 確認流程：使用者正在選工作回報類型時，不要再丟給 AI
    if (
      global.aiConfirmCache?.[userId] &&
      /^(類型)?[1-6]$/.test(userText)
    ) {
      const cache = global.aiConfirmCache[userId];

      const typeMap = {
        1: "安衛內業檢查",
        2: "工作抽查",
        3: "會勘",
        4: "中分局會議",
        5: "請假",
        6: "其他",
      };

      const selectedNumber = userText.replace("類型", "").trim();
      const selectedType = typeMap[selectedNumber];

      await createWorkReport(event.replyToken, event, {
        type: selectedType,
        content: cache.content,
      });

      delete global.aiConfirmCache[userId];
      return;
    }

    // 2. 固定指令先走本地判斷，不要浪費 AI
    if (userText.startsWith("新增回報模板")) {
      await createWorkReportTemplate(event.replyToken, event, userText);
      return;
    }

    if (userText.startsWith("刪除模板")) {
      await showDeleteWorkReportTemplates(event.replyToken, event, userText);
      return;
    }

    if (/^刪除[0-9一二兩三四五六七八九十百]+$/.test(userText)) {
      await deleteSelectedWorkReportTemplate(event.replyToken, event, userText);
      return;
    }

    if (/^(選)?[0-9一二兩三四五六七八九十百]+$/.test(userText)) {
      await createWorkReportFromSelectedTemplate(event.replyToken, event, userText);
      return;
    }

    if (isWorkReportMenuIntent(userText)) {
      await showWorkReportMenu(event.replyToken);
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

    // 3. 刪除提醒先處理
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

    // 4. 明確的提醒建立先走本地提醒解析，不要進 AI
    const isReminderCreationText =
      userText.includes("提醒我") ||
      userText.includes("提醒") ||
      userText.includes("每天") ||
      userText.includes("每日") ||
      userText.includes("每週") ||
      userText.includes("每周") ||
      userText.includes("每月") ||
      userText.includes("分鐘後") ||
      userText.includes("小時後") ||
      userText.includes("天後");

    if (isReminderCreationText) {
      await createReminderFromText(event.replyToken, userId, userText);
      return;
    }

    // 5. 明確工作回報與舊查詢先走本地判斷
    const workReport = parseWorkReport(userText);

    if (workReport) {
      await createWorkReport(event.replyToken, event, workReport);
      return;
    }

    if (isWorkReportQueryIntent(userText)) {
      await listWorkReports(event.replyToken, event, userText);
      return;
    }

    const reminderDateQuery = parseReminderDateQuery(userText);
    if (reminderDateQuery) {
      await listReminderDateQuery(event.replyToken, userId, reminderDateQuery);
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

    // 6. 以上都判斷不到，才交給 AI 理解自然語言
    const aiIntent = await parseUserIntent(userText);
    console.log("AI INTENT:", aiIntent);

    if (aiIntent.intent === "query_reminder_history") {
      await listReminderHistory(event.replyToken, userId, {
        range: aiIntent.range || "today",
        keyword: aiIntent.keyword || null,
        count_only: aiIntent.count_only || false,
      });
      return;
    }

    if (aiIntent.intent === "query_todo") {
      await listReminderDateQueryWithFilter(
        event.replyToken,
        userId,
        {
          range: aiIntent.range || "today",
          keyword: aiIntent.keyword || null,
          count_only: aiIntent.count_only || false,
        }
      );
      return;
    }

    if (aiIntent.intent === "query_work_report") {
      await listWorkReports(
        event.replyToken,
        event,
        {
          range: aiIntent.range || "today",
          work_type: aiIntent.work_type || null,
        }
      );
      return;
    }

    if (
      aiIntent.intent === "create_work_report" &&
      (
        aiIntent.need_confirm === true ||
        (aiIntent.confidence !== undefined && aiIntent.confidence < 0.8) ||
        !aiIntent.work_type
      )
    ) {
      global.aiConfirmCache = global.aiConfirmCache || {};

      global.aiConfirmCache[userId] = {
        raw_text: userText,
        content: aiIntent.content || userText,
      };

      await reply(
        event.replyToken,
        `我不太確定你要建立哪一種工作回報，請選擇：

1. 安衛內業檢查
2. 工作抽查
3. 會勘
4. 中分局會議
5. 請假
6. 其他

請輸入：類型1`
      );
      return;
    }

    if (aiIntent.intent === "create_work_report") {
      await createWorkReport(event.replyToken, event, {
        type: aiIntent.work_type,
        content: aiIntent.content || userText,
      });
      return;
    }

    await createReminderFromText(event.replyToken, userId, userText);
  } catch (error) {
    console.error(error);
    await reply(event.replyToken, "解析失敗，請再試一次");
  }
}

async function createReminderFromText(replyToken, userId, userText) {
  const result =
    parseRelativeReminder(userText) ||
    parseDailyReminder(userText) ||
    parseWeeklyReminder(userText) ||
    parseMonthlyReminder(userText) ||
    await parseReminder(userText);

  if (!result.title || !result.time) {
    await reply(
      replyToken,
      "我不太確定提醒時間，可以說：\n\n明天早上8點提醒我開會\n3分鐘後提醒我喝水\n兩小時後提醒我開會\n三天後提醒我繳費\n每天早上8點提醒我吃藥\n每週五提醒我交報告\n每月4號提醒我要做安衛檢查表"
    );
    return;
  }

  const summaryType = getReminderSummaryType(result.title);

  const { error } = await supabase.from("reminders").insert({
    line_user_id: userId,
    raw_text: userText,
    title: result.title,
    remind_at: result.time,
    status: "scheduled",
    repeat_type: result.repeat_type || "none",
    repeat_time: result.repeat_time || null,
    repeat_day: result.repeat_day || null,
    summary_type: summaryType,
  });

  if (error) throw error;

  await reply(
    replyToken,
    `已建立提醒 ✅\n提醒事項：${result.title}\n提醒時間：${formatTaipeiTime(result.time)}` +
      getRepeatText(result)
  );
}

const WORK_REPORT_TYPES = [
  "安衛內業檢查",
  "工作抽查",
  "會勘",
  "中分局會議",
  "請假",
  "其他",
];

function isWorkReportMenuIntent(text) {
  return (
    text === "工作回報" ||
    text === "EMM表單查詢" ||
    text === "公出回報" ||
    text === "回報選單"
  );
}

async function showWorkReportMenu(replyToken) {
  await reply(
    replyToken,
    `工作回報功能 ✅

    【快速建立】

    直接輸入：

    工作抽查 (內容ex 華電,土木管道)

    即可建立回報


    【使用常用模板】

    1. 新增模板：

    新增回報模板 工作抽查 (內容華電,土木管道)

    2. 使用模板：

    輸入：
    工作抽查

    再輸入：
    1或選1

    【可用類型】

    安衛內業檢查
    工作抽查
    會勘
    中分局會議
    請假
    其他

    【查詢功能】

    今日回報
    我的回報
    今日所有回報
    本週回報
    本週所有回報


    【刪除功能】

    刪除模板
    刪除1`
  );
}

function parseWorkReport(text) {
  const normalizedText = text.trim();

  for (const type of WORK_REPORT_TYPES) {
    if (normalizedText === type) {
      return {
        type,
        content: "",
      };
    }

    if (normalizedText.startsWith(type)) {
      return {
        type,
        content: normalizedText.slice(type.length).trim(),
      };
    }
  }

  const reportMatch = normalizedText.match(
    /^回報\s*(工作抽查|會同中分局開會|與承包商開會|協議組織|其他公出|公出)\s*(.*)$/
  );

  if (reportMatch) {
    return {
      type: reportMatch[1],
      content: reportMatch[2].trim(),
    };
  }

  return null;
}

function isWorkReportQueryIntent(text) {
  return [
    "今日回報",
    "今天回報",
    "我的回報",
    "今日所有回報",
    "今天所有回報",
    "本週回報",
    "這週回報",
    "本週所有回報",
    "這週所有回報",
  ].includes(text);
}

async function getLineDisplayName(event) {
  const fallbackName = "未命名使用者";

  if (!event.source.userId) return fallbackName;

  try {
    const profile = await client.getProfile(event.source.userId);
    return profile.displayName || fallbackName;
  } catch (error) {
    console.error("GET LINE PROFILE ERROR:", error);
    return fallbackName;
  }
}

function getCurrentLineUserId(event) {
  return event.source.userId || event.source.groupId || "unknown";
}

async function createWorkReport(replyToken, event, report) {
  if (!report.content) {
    await showWorkReportTemplates(replyToken, event, report.type);
    return;
  }

  const lineUserId = getCurrentLineUserId(event);
  const userName = await getLineDisplayName(event);

  const { error } = await supabase.from("work_logs").insert({
    line_user_id: lineUserId,
    user_name: userName,
    type: report.type,
    content: report.content,
  });

  if (error) {
    console.error("CREATE WORK REPORT ERROR:", error);
    await reply(replyToken, "工作回報建立失敗，請再試一次");
    return;
  }

  await reply(
    replyToken,
    `已建立工作回報 ✅\n類型：${report.type}\n人員：${userName}\n內容：${report.content}`
  );
}

async function createWorkReportTemplate(replyToken, event, text) {
  const match = text.match(
    /^新增回報模板\s*(安衛內業檢查|工作抽查|會勘|中分局會議|請假|其他)\s+(.+)$/
  );

  if (!match) {
    await reply(
      replyToken,
      `新增模板格式錯誤，請這樣輸入：

新增回報模板 工作抽查 國道6號隧道設備巡檢

可用類型：
安衛內業檢查
工作抽查
會勘
中分局會議
請假
其他`
    );
    return;
  }

  const lineUserId = getCurrentLineUserId(event);
  const type = match[1];
  const content = match[2].trim();

  const { error } = await supabase.from("work_report_templates").insert({
    line_user_id: lineUserId,
    type,
    content,
  });

  if (error) {
    console.error("CREATE WORK TEMPLATE ERROR:", error);
    await reply(replyToken, "新增回報模板失敗，請再試一次");
    return;
  }

  await reply(
    replyToken,
    `已新增回報模板 ✅\n類型：${type}\n內容：${content}\n\n之後輸入「${type}」就可以選擇。`
  );
}

async function createWorkReportFromSelectedTemplate(replyToken, event, text) {
  const lineUserId = getCurrentLineUserId(event);
  const numberText = text.replace("選", "").trim();
  const selectedNumber = parseNumberText(numberText);

  const cache = global.workTemplateCache?.[lineUserId];

  if (!cache || !cache.templates || cache.templates.length === 0) {
    await reply(replyToken, "找不到可選的模板，請先輸入回報類型，例如：工作抽查");
    return;
  }

  const selectedTemplate = cache.templates[selectedNumber - 1];

  if (!selectedTemplate) {
    await reply(replyToken, "找不到這個模板編號，請重新選擇");
    return;
  }

  await createWorkReport(replyToken, event, {
    type: cache.type,
    content: selectedTemplate.content,
  });

  delete global.workTemplateCache[lineUserId];
}

async function showWorkReportTemplates(replyToken, event, type) {
  const lineUserId = getCurrentLineUserId(event);

  const { data, error } = await supabase
    .from("work_report_templates")
    .select("*")
    .eq("line_user_id", lineUserId)
    .eq("type", type)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error("LIST WORK TEMPLATE ERROR:", error);
    await reply(replyToken, "查詢回報模板失敗，請再試一次");
    return;
  }

  if (!data || data.length === 0) {
    await reply(
      replyToken,
      `你目前沒有「${type}」模板。

可以先新增，例如：

新增回報模板 ${type} 國道6號隧道設備巡檢

或直接輸入：

${type} 國道6號隧道設備巡檢`
    );
    return;
  }

  global.workTemplateCache = global.workTemplateCache || {};

  global.workTemplateCache[lineUserId] = {
    type,
    templates: data,
  };

  const text = data
    .map((item, index) => `${index + 1}. ${item.content}`)
    .join("\n");

  await reply(
    replyToken,
    `請選擇「${type}」模板：

${text}

請輸入：選1`
  );
}



async function showDeleteWorkReportTemplates(replyToken, event, text) {
  const match = text.match(
    /^刪除模板\s*(安衛內業檢查|工作抽查|會勘|中分局會議|請假|其他)$/
  );

  if (!match) {
    await reply(
      replyToken,
      `請輸入要刪除哪一類模板，例如：

刪除模板 工作抽查

可用類型：
安衛內業檢查
工作抽查
會勘
中分局會議
請假
其他`
    );
    return;
  }

  const type = match[1];
  const lineUserId = getCurrentLineUserId(event);

  const { data, error } = await supabase
    .from("work_report_templates")
    .select("*")
    .eq("line_user_id", lineUserId)
    .eq("type", type)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error("LIST DELETE TEMPLATE ERROR:", error);
    await reply(replyToken, "查詢模板失敗，請再試一次");
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, `你目前沒有「${type}」模板可以刪除`);
    return;
  }

  global.deleteTemplateCache = global.deleteTemplateCache || {};

  global.deleteTemplateCache[lineUserId] = {
    type,
    templates: data,
  };

  const listText = data
    .map((item, index) => `${index + 1}. ${item.content}`)
    .join("\n");

  await reply(
    replyToken,
    `請選擇要刪除的「${type}」模板：

${listText}

請輸入：刪除1`
  );
}

async function deleteSelectedWorkReportTemplate(replyToken, event, text) {
  const lineUserId = getCurrentLineUserId(event);
  const numberText = text.replace("刪除", "").trim();
  const selectedNumber = parseNumberText(numberText);

  const cache = global.deleteTemplateCache?.[lineUserId];

  if (!cache || !cache.templates || cache.templates.length === 0) {
    await reply(replyToken, "找不到可刪除的模板，請先輸入：刪除模板 工作抽查");
    return;
  }

  const selectedTemplate = cache.templates[selectedNumber - 1];

  if (!selectedTemplate) {
    await reply(replyToken, "找不到這個模板編號，請重新選擇");
    return;
  }

  const { error } = await supabase
    .from("work_report_templates")
    .delete()
    .eq("id", selectedTemplate.id)
    .eq("line_user_id", lineUserId);

  if (error) {
    console.error("DELETE TEMPLATE ERROR:", error);
    await reply(replyToken, "刪除模板失敗，請再試一次");
    return;
  }

  delete global.deleteTemplateCache[lineUserId];

  await reply(
    replyToken,
    `已刪除模板 ✅
類型：${cache.type}
內容：${selectedTemplate.content}`
  );
}

function getTaipeiRange(daysBack = 0) {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const year = taipeiNow.getUTCFullYear();
  const month = taipeiNow.getUTCMonth();
  const day = taipeiNow.getUTCDate();

  const startTaipei = new Date(Date.UTC(year, month, day - daysBack, 0, 0, 0));
  const endTaipei = new Date(Date.UTC(year, month, day + 1, 0, 0, 0));

  return {
    startUtc: new Date(startTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    endUtc: new Date(endTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

function getThisWeekRangeUtc() {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const dayOfWeek = taipeiNow.getUTCDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const startTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + diffToMonday,
    0,
    0,
    0
  ));

  const endTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + 1,
    0,
    0,
    0
  ));

  return {
    startUtc: new Date(startTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    endUtc: new Date(endTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

function formatWorkLogTime(value) {
  const date = new Date(value);

  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatWorkReports(data, title) {
  if (!data || data.length === 0) {
    return `${title}：目前沒有資料`;
  }

  const text = data
    .map((item, index) => {
      return `${index + 1}. ${item.user_name || "未命名使用者"}\n類型：${item.type}\n內容：${item.content}\n時間：${formatWorkLogTime(item.created_at)}`;
    })
    .join("\n\n");

  return `${title}：\n\n${text}`;
}

function getThisMonthRangeUtc() {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const startTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    1,
    0,
    0,
    0
  ));

  const endTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + 1,
    0,
    0,
    0
  ));

  return {
    startUtc: new Date(startTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    endUtc: new Date(endTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

async function listWorkReports(replyToken, event, input) {
  const lineUserId = getCurrentLineUserId(event);

  let rangeName = "today";
  let workType = null;
  let title = "今日回報";
  let isAll = true;

  if (typeof input === "string") {
    isAll = input !== "我的回報";
    workType = null;

    if (input.includes("月")) {
      rangeName = "month";
      title = "本月回報";
    } else if (input.includes("週") || input.includes("周") || input.includes("這週")) {
      rangeName = "week";
      title = "本週回報";
    } else {
      rangeName = "today";
      title = input;
    }
  } else {
    rangeName = input?.range || "today";
    workType = input?.work_type || null;
    isAll = true;

    if (rangeName === "month") title = workType ? `本月${workType}回報` : "本月回報";
    else if (rangeName === "week") title = workType ? `本週${workType}回報` : "本週回報";
    else title = workType ? `今日${workType}回報` : "今日回報";
  }

  const range =
    rangeName === "month"
      ? getThisMonthRangeUtc()
      : rangeName === "week"
      ? getThisWeekRangeUtc()
      : getTaipeiRange(0);

  let query = supabase
    .from("work_logs")
    .select("*")
    .gte("created_at", range.startUtc)
    .lt("created_at", range.endUtc)
    .order("created_at", { ascending: false })
    .limit(50);

  if (!isAll) {
    query = query.eq("line_user_id", lineUserId);
  }

  if (workType) {
    query = query.eq("type", workType);
  }

  const { data, error } = await query;

  if (error) {
    console.error("LIST WORK REPORT ERROR:", error);
    await reply(replyToken, "查詢工作回報失敗，請再試一次");
    return;
  }

  await reply(replyToken, formatWorkReports(data, title));
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
  const title = cleanReminderTitle(match[3]);

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
    .replaceAll("代辦", "待辦")
    .trim();
}

function parseDailyReminder(text) {
  const match = text.match(
    /(?:每天|每日)\s*(早上|上午|中午|下午|晚上)?\s*([0-9一二兩三四五六七八九十百]+)\s*點\s*(?:([0-9一二兩三四五六七八九十百]+)\s*分?|半)?\s*(.*)/
  );

  if (!match) return null;

  const period = match[1] || "";
  let hour = parseNumberText(match[2]);

  let minute = 0;

  if (text.includes("半")) {
    minute = 30;
  } else if (match[3]) {
    minute = parseNumberText(match[3]);
  }

  const title = cleanReminderTitle(match[4]);

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

async function parseUserIntent(userText) {
  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: `
你是 LINE BOT 指令解析器。
請只回 JSON，不要解釋。

支援 intent：
query_todo
query_reminder_history
query_work_report
create_work_report
unknown

JSON 格式：
{
  "intent": "query_todo|query_reminder_history|query_work_report|create_work_report|unknown",
  "range": "today|tomorrow|week|month|null",
  "work_type": null,
  "content": null,
  "keyword": null,
  "count_only": false,
  "confidence": 0.0,
  "need_confirm": false
}

重要規則：
- 如果是「提醒我、每天、每日、每週、每月、幾分鐘後、幾小時後」這種建立提醒，回 unknown。
- 如果是「新增模板、刪除、選1、類型1」這種操作，回 unknown。
- 如果使用者問「幾個、幾次、多少」，count_only=true。

待辦查詢：
- 「今天待辦、今日待辦、今天的待辦事項、今天要幹嘛、我今天要做什麼、今天有什麼事」= query_todo, range=today。
- 「明天待辦、隔日待辦、明天有什麼事、明天要做什麼」= query_todo, range=tomorrow。
- 「本週待辦、這週待辦、這禮拜要幹嘛」= query_todo, range=week。
- 「我今天有幾個會勘」= query_todo, range=today, keyword=會勘, count_only=true。
- 「我今天喝幾次水」= query_todo, range=today, keyword=喝水, count_only=true。
- 「我今天還有幾個會要開」= query_todo, range=today, keyword=開會, count_only=true。

提醒紀錄查詢：
- 「我今天做了什麼、今天做了什麼、今天提醒過什麼、今天有哪些紀錄」= query_reminder_history, range=today。
- 「這週做了什麼、本週做了什麼、這禮拜做了什麼」= query_reminder_history, range=week。
- 「這個月做了什麼、本月做了什麼」= query_reminder_history, range=month。
- 如果問「還沒做什麼、還沒提醒、待辦」，是 query_todo，不是 query_reminder_history。

工作回報查詢：
- 「今天工作回報、今日工作回報、今天誰出去、今天誰外出、今天大家去哪、今天誰去哪裡」= query_work_report, range=today, work_type=null。
- 「本週工作回報、這週工作回報、這週大家去哪裡、這週誰出門、這禮拜誰出去」= query_work_report, range=week, work_type=null。
- 「本月工作回報、這個月工作回報」= query_work_report, range=month, work_type=null。
- 「今天誰請假」= query_work_report, range=today, work_type=請假。
- 「這週誰請假」= query_work_report, range=week, work_type=請假。
- 「今天誰去開會」= query_work_report, range=today, work_type=中分局會議。
- 「今天誰去巡檢」= query_work_report, range=today, work_type=工作抽查。
- 「今天誰去會勘」= query_work_report, range=today, work_type=會勘。

建立工作回報：
- 「工作抽查 國6巡檢」= create_work_report, work_type=工作抽查, content=國6巡檢。
- 「會勘 76線設備討論」= create_work_report, work_type=會勘, content=76線設備討論。
- 「請假 上午特休」= create_work_report, work_type=請假, content=上午特休。
- 「和{任何人}開會、跟{任何人}開會、與{任何單位}開會」= create_work_report, work_type=中分局會議, content=保留原句, confidence=0.95, need_confirm=false。
- 「和{任何人}巡檢、跟{任何人}巡檢、去巡檢、去看設備、去現場看設備」= create_work_report, work_type=工作抽查, content=保留原句, confidence=0.95, need_confirm=false。
- 「和{任何人}會勘、跟{任何人}會勘、現場會勘、去會勘」= create_work_report, work_type=會勘, content=保留原句, confidence=0.95, need_confirm=false。
- 「請假、休假、特休、病假、補休」= create_work_report, work_type=請假, content=保留原句, confidence=0.95, need_confirm=false。
- 如果像「出去一下、外出、處理事情」這種工作類型不明確，回 create_work_report, work_type=null, content=保留原句, confidence=0.5, need_confirm=true。
`
      },
      {
        role: "user",
        content: userText,
      },
    ],
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
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




function getDateRangeUtc(addDays = 0) {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const startTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + addDays,
    0, 0, 0
  ));

  const endTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + addDays + 1,
    0, 0, 0
  ));

  return {
    startUtc: new Date(startTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    endUtc: new Date(endTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

function getReminderWeekRangeUtc() {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = taipeiNow.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const startTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + diffToMonday,
    0, 0, 0
  ));

  const endTaipei = new Date(Date.UTC(
    taipeiNow.getUTCFullYear(),
    taipeiNow.getUTCMonth(),
    taipeiNow.getUTCDate() + 7,
    0, 0, 0
  ));

  return {
    startUtc: new Date(startTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    endUtc: new Date(endTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

function parseReminderDateQuery(text) {
  if (
    text.includes("今天待辦") ||
    text.includes("今日待辦") ||
    text.includes("當日待辦") ||
    text.includes("今天的待辦") ||
    text.includes("今日的待辦") ||
    text.includes("今天的待辦事項") ||
    text.includes("今日的待辦事項")
  ) {
    return { type: "date", days: 0, title: "今日待辦" };
  }

  if (
    text.includes("明天待辦") ||
    text.includes("明日待辦") ||
    text.includes("隔日待辦") ||
    text.includes("明天的待辦") ||
    text.includes("明日的待辦") ||
    text.includes("明天的待辦事項") ||
    text.includes("隔日待辦事項")
  ) {
    return { type: "date", days: 1, title: "明日待辦" };
  }

  if (
    text.includes("本週待辦") ||
    text.includes("本周待辦") ||
    text.includes("這週待辦") ||
    text.includes("這禮拜待辦")
  ) {
    return { type: "week", title: "本週待辦" };
  }

  return null;
}

function getReminderSummaryType(title) {
  if (!title) return null;

  if (
    title.includes("今天待辦") ||
    title.includes("今日待辦") ||
    title.includes("今天的待辦") ||
    title.includes("今日的待辦") ||
    title.includes("今天的待辦事項") ||
    title.includes("今日的待辦事項") ||
    title.includes("當日待辦")
  ) {
    return "today";
  }

  if (
    title.includes("明天待辦") ||
    title.includes("明日待辦") ||
    title.includes("明天的待辦") ||
    title.includes("明日的待辦") ||
    title.includes("明天的待辦事項") ||
    title.includes("明日的待辦事項") ||
    title.includes("隔日待辦")
  ) {
    return "tomorrow";
  }

  if (
    title.includes("本週待辦") ||
    title.includes("本周待辦") ||
    title.includes("這週待辦") ||
    title.includes("這禮拜待辦")
  ) {
    return "week";
  }

  return null;
}

async function getTodoSummaryText(userId, summary) {
  const range = summary.type === "week"
    ? getReminderWeekRangeUtc()
    : getDateRangeUtc(summary.days);

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .is("summary_type", null)
    .gte("remind_at", range.startUtc)
    .lt("remind_at", range.endUtc)
    .order("remind_at", { ascending: true });

  if (error) {
    console.error("GET TODO SUMMARY ERROR:", error);
    return `${summary.title}：查詢失敗`;
  }

  if (!data || data.length === 0) {
    return `${summary.title}：目前沒有待辦事項`;
  }

  const text = data
    .map((item, index) => {
      return `${index + 1}. ${item.title}\n時間：${formatTaipeiTime(item.remind_at)}`;
    })
    .join("\n\n");

  return `${summary.title}：\n\n${text}`;
}



async function listReminderDateQuery(replyToken, userId, query) {
  const range = query.type === "week"
    ? getReminderWeekRangeUtc()
    : getDateRangeUtc(query.days);

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .is("summary_type", null)
    .gte("remind_at", range.startUtc)
    .lt("remind_at", range.endUtc)

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢待辦事項失敗");
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, `${query.title}：目前沒有待辦事項`);
    return;
  }

  const text = data.map((item, index) => {
    return `${index + 1}. ${item.title}\n時間：${formatTaipeiTime(item.remind_at)}`;
  }).join("\n\n");

  await reply(replyToken, `${query.title}：\n\n${text}`);
}
async function listReminderHistory(replyToken, userId, options) {
  const range = getReminderHistoryRangeUtc(options.range);

  let query = supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .in("status", ["scheduled", "reminded"])
    .gte("remind_at", range.startUtc)
    .lt("remind_at", range.endUtc)
    .order("remind_at", { ascending: true });

  if (options.keyword) {
    query = query.ilike("title", `%${options.keyword}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error("LIST REMINDER HISTORY ERROR:", error);
    await reply(replyToken, "查詢提醒紀錄失敗");
    return;
  }

  const titleMap = {
    today: "今日紀錄",
    week: "本週紀錄",
    month: "本月紀錄",
  };

  const title = titleMap[options.range] || "提醒紀錄";

  if (options.count_only) {
    await reply(replyToken, `${title}共有 ${data?.length || 0} 筆`);
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, `${title}：目前沒有資料`);
    return;
  }

  const text = data
    .map((item, index) => {
      const statusText = item.status === "reminded" ? "已提醒" : "未提醒";
      return `${index + 1}. ${item.title}
時間：${formatTaipeiTime(item.remind_at)}
狀態：${statusText}`;
    })
    .join("\n\n");

  await reply(replyToken, `${title}：\n\n${text}`);
}

function getReminderHistoryRangeUtc(range) {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  let startTaipei;
  let endTaipei;

  if (range === "week") {
    const dayOfWeek = taipeiNow.getUTCDay();
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

    startTaipei = new Date(Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate() + diffToMonday,
      0, 0, 0
    ));

    endTaipei = new Date(Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate() + 1,
      0, 0, 0
    ));
  } else if (range === "month") {
    startTaipei = new Date(Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      1,
      0, 0, 0
    ));

    endTaipei = new Date(Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate() + 1,
      0, 0, 0
    ));
  } else {
    startTaipei = new Date(Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate(),
      0, 0, 0
    ));

    endTaipei = new Date(Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate() + 1,
      0, 0, 0
    ));
  }

  return {
    startUtc: new Date(startTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    endUtc: new Date(endTaipei.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}
async function listReminderDateQueryWithFilter(replyToken, userId, query) {
  const range = query.range === "week"
    ? getReminderWeekRangeUtc()
    : getDateRangeUtc(query.range === "tomorrow" ? 1 : 0);

  let dbQuery = supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .is("summary_type", null)
    .gte("remind_at", range.startUtc)
    .lt("remind_at", range.endUtc)
    .order("remind_at", { ascending: true });

  if (query.keyword) {
    dbQuery = dbQuery.ilike("title", `%${query.keyword}%`);
  }

  const { data, error } = await dbQuery;

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢待辦失敗");
    return;
  }

  if (query.count_only) {
    await reply(
      replyToken,
      `${query.keyword || "待辦"}共有 ${data?.length || 0} 筆`
    );
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, "目前沒有符合的待辦");
    return;
  }

  const text = data
    .map((item, index) => `${index + 1}. ${item.title}\n時間：${formatTaipeiTime(item.remind_at)}`)
    .join("\n\n");

  await reply(replyToken, text);
}
async function listTodayReminderHistory(replyToken, userId) {
  const { startUtc, endUtc } = getTodayRangeUtc();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .in("status", ["scheduled", "reminded"])
    .gte("remind_at", startUtc)
    .lt("remind_at", endUtc)
    .order("remind_at", { ascending: true });

  if (error) {
    console.error(error);
    await reply(replyToken, "查詢今日紀錄失敗");
    return;
  }

  if (!data || data.length === 0) {
    await reply(replyToken, "今天沒有提醒紀錄");
    return;
  }

  const text = data
    .map((item, index) => {
      const statusText = item.status === "reminded" ? "已提醒" : "未提醒";
      return `${index + 1}. ${item.title}\n時間：${formatTaipeiTime(item.remind_at)}\n狀態：${statusText}`;
    })
    .join("\n\n");

  await reply(replyToken, `今日紀錄：\n\n${text}`);
}

async function listTodayReminders(replyToken, userId) {
  const { startUtc, endUtc } = getTodayRangeUtc();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("line_user_id", userId)
    .eq("status", "scheduled")
    .is("summary_type", null)
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
        await supabase
          .from("reminders")
          .update({
            status: "reminded",
          })
          .eq("id", reminder.id);

        let pushText = `提醒你：${reminder.title}`;

        if (reminder.summary_type === "today") {
          pushText = await getTodoSummaryText(reminder.line_user_id, {
            type: "date",
            days: 0,
            title: "今日待辦",
          });
        }

        if (reminder.summary_type === "tomorrow") {
          pushText = await getTodoSummaryText(reminder.line_user_id, {
            type: "date",
            days: 1,
            title: "明日待辦",
          });
        }

        if (reminder.summary_type === "week") {
          pushText = await getTodoSummaryText(reminder.line_user_id, {
            type: "week",
            title: "本週待辦",
          });
        }

        await client.pushMessage({
          to: reminder.line_user_id,
          messages: [
            {
              type: "text",
              text: pushText,
            },
          ],
        });

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