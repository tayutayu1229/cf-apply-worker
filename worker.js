export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response("", {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }
      });
    }

    if (url.pathname === "/apply" && request.method === "POST") {
      return handleApply(request, env);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};


// ---------------------------------------------------------
//  /apply 申請受付
// ---------------------------------------------------------
async function handleApply(request, env) {
  const data = await request.json();
  const id = crypto.randomUUID();

  // IP と UA の取得
  const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = data.ua || "unknown";

  // Google Sheets に追加
  await appendToSheet(env, [
    id, data.name, data.title, data.reason, data.place,
    data.date, data.activity, data.detail, data.time,
    data.lineid || "", "pending", "", clientIP, ua,
    new Date().toISOString()
  ]);

  // LINE へ承認リクエスト送信
  await sendLineApprovalCard(env, id, data);

  return json({ id });
}


// ---------------------------------------------------------
//  /webhook 承認/差戻し
// ---------------------------------------------------------
async function handleWebhook(request, env) {
  const body = await request.json();
  const event = body.events?.[0];

  if (!event?.postback) return json({ ok: true });

  const params = new URLSearchParams(event.postback.data);
  const id = params.get("id");
  const action = params.get("action");  // approve / reject
  const comment = event.postback?.params?.comment ?? "";

  // シート更新
  await updateSheetStatus(env, id, action, comment);

  // 申請者へ通知
  await notifyApplicant(env, id, action, comment);

  return new Response("OK");
}


// ---------------------------------------------------------
// Google Sheets (Service Account)
// ---------------------------------------------------------
async function appendToSheet(env, row) {
  const jwt = await createJWT(env);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/申請!A:O:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] })
    }
  );
  return res.text();
}

async function updateSheetStatus(env, id, status, comment) {
  const jwt = await createJWT(env);

  // ID を検索して特定行の status/comment を書き換え
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/申請!A:O`,
    { headers: { "Authorization": `Bearer ${jwt}` } }
  );
  const sheet = await getRes.json();
  const rows = sheet.values;
  const idx = rows.findIndex(r => r[0] === id);
  if (idx < 0) return;

  const rowIndex = idx + 1;
  const range = `申請!K${rowIndex}:L${rowIndex}`;
  const body = { values: [[status, comment]] };

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
}


// ---------------------------------------------------------
// LINE Messaging API
// ---------------------------------------------------------
async function sendLineApprovalCard(env, id, data) {
  const msg = {
    to: env.LINE_ADMIN_USERID,
    messages: [approvalFlex(id, data)]
  };

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env.LINE_TOKEN
    },
    body: JSON.stringify(msg)
  });
}

async function notifyApplicant(env, id, status, comment) {
  if (!env.LINE_ADMIN_USERID) return;

  const text = `申請ID: ${id}\n結果: ${status}\nコメント: ${comment}`;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env.LINE_TOKEN
    },
    body: JSON.stringify({
      to: env.LINE_ADMIN_USERID,
      messages: [{ type: "text", text }]
    })
  });
}


// ---------------------------------------------------------
// Google JWT
// ---------------------------------------------------------
async function createJWT(env) {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(
    JSON.stringify({
      iss: env.GOOGLE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    })
  );

  const toSign = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    str2ab(env.GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(toSign));
  return `${toSign}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

function str2ab(str) {
  const cleaned = str.replace(/-----.*?-----/g, "").replace(/\s+/g, "");
  const bin = atob(cleaned);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}


// =======================================================
// LINE Flex（承認カード）
// =======================================================
function approvalFlex(id, d) {
  return {
    type: "flex",
    altText: "外出申請があります",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "外出申請", weight: "bold", size: "xl" },
          { type: "text", text: `申請者：${d.name}` },
          { type: "text", text: `件名：${d.title}` },
          { type: "text", text: `日時：${d.date}` },
          { type: "text", text: `時間：${d.time}` },
          { type: "text", text: `行き先：${d.place}` },
          {
            type: "button",
            action: {
              type: "postback",
              label: "承認する",
              data: `action=approve&id=${id}`,
              displayText: "承認コメントを入力してください"
            }
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "差し戻し",
              data: `action=reject&id=${id}`,
              displayText: "差し戻し理由を入力してください"
            },
            color: "#FF5555"
          }
        ]
      }
    }
  };
}
