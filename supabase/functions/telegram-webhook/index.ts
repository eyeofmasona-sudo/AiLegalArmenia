import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
    photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    caption?: string;
  };
}

type TelegramSupabaseClient = {
  from: (table: string) => unknown;
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        fileBody: ArrayBuffer,
        options: { contentType: string; upsert: boolean },
      ) => PromiseLike<{ error: unknown | null }>;
      remove: (paths: string[]) => PromiseLike<{ error: unknown | null }>;
    };
  };
};

type TelegramProfile = {
  id: string;
  full_name: string | null;
  email: string | null;
};

type ProfileQueryBuilder = {
  select: (columns: string) => {
    eq: (column: string, value: unknown) => {
      single: () => PromiseLike<{
        data: TelegramProfile | null;
        error: { message?: string } | null;
      }>;
    };
  };
};

type TelegramUploadRow = {
  user_id: string;
  telegram_chat_id: string;
  filename: string;
  original_filename: string;
  storage_path: string;
  file_type: string;
  file_size: number | undefined;
  caption: string | undefined;
};

type TelegramUploadsTable = {
  insert: (row: TelegramUploadRow) => PromiseLike<{ error: unknown | null }>;
};

/**
 * Validate X-Telegram-Bot-Api-Secret-Token header.
 * Returns null if valid, or an error Response if invalid.
 */
function verifyTelegramSecret(req: Request): Response | null {
  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!expected) {
    // Fail-closed: secret not configured
    console.error("TELEGRAM_WEBHOOK_SECRET not configured");
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const provided = req.headers.get("x-telegram-bot-api-secret-token");
  if (!provided || provided !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

serve(async (req) => {
  // Telegram sends POST only; reject anything else
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  // Verify Telegram webhook secret
  const secretError = verifyTelegramSecret(req);
  if (secretError) return secretError;

  try {
    const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (!TELEGRAM_BOT_TOKEN) {
      throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const update: TelegramUpdate = await req.json();
    const message = update.message;

    if (!message) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const chatId = message.chat.id;

    // Handle file uploads (photo or document)
    if (message.photo || message.document) {
      await handleFileUpload(
        supabase, 
        TELEGRAM_BOT_TOKEN, 
        chatId, 
        message.photo, 
        message.document, 
        message.caption
      );
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const text = message.text?.trim();

    if (!text) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle /start command
    if (text === "/start") {
      const welcomeMessage = `\u0532\u0561\u0580\u056b \u0563\u0561\u056c\u0578\u0582\u057d\u057f \ud83d\udc4b

\u0531\u0575\u057d \u0562\u0578\u057f\u0568 \u0578\u0582\u0572\u0561\u0580\u056f\u0578\u0582\u0574 \u0567 \u0564\u0561\u057f\u0561\u056f\u0561\u0576 \u0576\u056b\u057d\u057f\u0565\u0580\u056b \u057e\u0565\u0580\u0561\u0562\u0565\u0580\u0575\u0561\u056c \u056e\u0561\u0576\u0578\u0582\u0581\u0578\u0582\u0574\u0576\u0565\u0580
\u0587 \u0569\u0578\u0582\u0575\u056c \u0567 \u057f\u0561\u056c\u056b\u057d \u0562\u0565\u057c\u0576\u0565\u056c \u0563\u0578\u0580\u056e\u0565\u0580\u056b\u0576 \u0561\u057c\u0576\u0579\u057e\u0578\u0572 \u0586\u0561\u0575\u056c\u0565\u0580\u0589

<b>\u0541\u0565\u0580 Chat ID-\u0576 \u0567\u055d</b>
<code>${chatId}</code>

<b>\u0540\u0561\u0577\u056b\u057e\u0568 \u056f\u0561\u057a\u0565\u056c\u0578\u0582 \u0570\u0561\u0574\u0561\u0580\u055d</b>
1\ufe0f\u20e3 \u054d\u057f\u0561\u0581\u0565\u0584 \u056f\u0578\u0564\u0568 \u0570\u0561\u057e\u0565\u056c\u057e\u0561\u056e\u056b \u057a\u0580\u0578\u0586\u056b\u056c\u056b \u056f\u0561\u0580\u0563\u0561\u057e\u0578\u0580\u0578\u0582\u0574\u0576\u0565\u0580\u056b\u0581
2\ufe0f\u20e3 \u0548\u0582\u0572\u0561\u0580\u056f\u0565\u0584 \u0570\u0580\u0561\u0574\u0561\u0576\u0568\u055d
<code>/verify XXXXXX</code>

<b>\u0540\u0580\u0561\u0574\u0561\u0576\u0576\u0565\u0580\u055d</b>
/start \u2014 \u0581\u0578\u0582\u0581\u0561\u0564\u0580\u0565\u056c Chat ID-\u0576
/verify XXXXXX \u2014 \u056f\u0561\u057a\u0565\u056c \u0570\u0561\u0577\u056b\u057e\u0568
/status \u2014 \u057d\u057f\u0578\u0582\u0563\u0565\u056c \u056f\u0561\u057a\u056b \u057e\u056b\u0573\u0561\u056f\u0568
/help \u2014 \u0585\u0563\u0576\u0578\u0582\u0569\u0575\u0578\u0582\u0576 \u0587 \u0586\u0561\u0575\u056c\u0565\u0580\u056b \u0562\u0565\u057c\u0576\u0578\u0582\u0574`;

      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcomeMessage);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle /help command
    if (text === "/help") {
      const helpMessage = `📁 <b>Загрузка файлов</b>

Чтобы загрузить файл в систему:
1. Привяжите аккаунт через /verify XXXXXX (код из приложения)
2. Отправьте фото или документ в этот чат
3. Файл автоматически сохранится в вашей папке

<b>Поддерживаемые форматы:</b>
📷 Фотографии (JPG, PNG)
📄 Документы (PDF, DOCX, и др.)

Максимальный размер: 20 МБ`;

      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, helpMessage);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle /status command
    if (text === "/status") {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id, full_name, email, notification_preferences")
        .eq("telegram_chat_id", chatId.toString())
        .single();

      let statusMessage: string;
      if (profile) {
        const prefs = profile.notification_preferences as { telegram?: boolean } | null;
        const isEnabled = prefs?.telegram !== false;
        
        const { count } = await supabase
          .from("telegram_uploads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", profile.id);
        
        statusMessage = `✅ <b>Аккаунт подключен</b>

👤 ${profile.full_name || profile.email}
🔔 Уведомления: ${isEnabled ? "включены" : "выключены"}
📁 Загружено файлов: ${count || 0}`;
      } else {
        statusMessage = `❌ <b>Аккаунт не подключен</b>

Ваш Chat ID: <code>${chatId}</code>

Для привязки:
1. Получите код в настройках профиля приложения
2. Отправьте: /verify XXXXXX`;
      }

      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, statusMessage);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle /verify command
    if (text.startsWith("/verify ")) {
      const code = text.slice(8).trim().toUpperCase();
      
      if (!code || code.length !== 6) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 
          "❌ Неверный формат кода. Используйте: /verify XXXXXX (6 символов)");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const { data: verificationCode, error: findError } = await supabase
        .from("telegram_verification_codes")
        .select("id, user_id, expires_at")
        .eq("code", code)
        .is("used_at", null)
        .gt("expires_at", new Date().toISOString())
        .single();

      if (findError || !verificationCode) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 
          `❌ Неверный или просроченный код.\n\nПолучите новый код в настройках профиля приложения.`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      await supabase
        .from("telegram_verification_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("id", verificationCode.id);

      const { data: profile, error: updateError } = await supabase
        .from("profiles")
        .update({ telegram_chat_id: chatId.toString() })
        .eq("id", verificationCode.user_id)
        .select("id, full_name, email")
        .single();

      if (updateError || !profile) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 
          "❌ Ошибка при привязке аккаунта. Попробуйте позже.");
      } else {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 
          `✅ <b>Аккаунт успешно привязан!</b>

👤 ${profile.full_name || profile.email}

Теперь вы можете:
• Получать уведомления о судебных заседаниях
• Загружать файлы, отправляя их в этот чат

Используйте /help для подробной информации.`);
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle legacy /link command
    if (text.startsWith("/link ")) {
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 
        `⚠️ <b>Метод привязки изменен</b>

Для безопасности теперь используется код подтверждения:
1. Откройте настройки профиля в приложении
2. Нажмите "Получить код"
3. Отправьте сюда: /verify XXXXXX`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Unknown command
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 
      "Используйте /start для начала, /help для помощи, или отправьте файл для загрузки."
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("telegram-webhook error:", error);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
});

async function handleFileUpload(
  supabase: TelegramSupabaseClient,
  botToken: string,
  chatId: number,
  photo: Array<{ file_id: string; file_size?: number; width: number; height: number }> | undefined,
  document: { file_id: string; file_name?: string; mime_type?: string; file_size?: number } | undefined,
  caption: string | undefined
): Promise<void> {
  const profilesTable = supabase.from("profiles") as ProfileQueryBuilder;
  const { data: profile, error: profileError } = await profilesTable
    .select("id, full_name, email")
    .eq("telegram_chat_id", chatId.toString())
    .single();

  if (profileError || !profile) {
    await sendTelegramMessage(botToken, chatId, 
      `❌ Аккаунт не привязан.\n\nДля привязки:\n1. Получите код в настройках профиля приложения\n2. Отправьте: /verify XXXXXX`
    );
    return;
  }

  let fileId: string;
  let originalFilename: string;
  let mimeType: string;
  let fileSize: number | undefined;

  if (photo && photo.length > 0) {
    const largestPhoto = photo[photo.length - 1];
    fileId = largestPhoto.file_id;
    originalFilename = `photo_${Date.now()}.jpg`;
    mimeType = "image/jpeg";
    fileSize = largestPhoto.file_size;
  } else if (document) {
    fileId = document.file_id;
    originalFilename = document.file_name || `document_${Date.now()}`;
    mimeType = document.mime_type || "application/octet-stream";
    fileSize = document.file_size;
  } else {
    return;
  }

  if (fileSize && fileSize > 20 * 1024 * 1024) {
    await sendTelegramMessage(botToken, chatId, "❌ Файл слишком большой. Максимальный размер: 20 МБ.");
    return;
  }

  try {
    const fileInfoResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
    );
    const fileInfo = await fileInfoResponse.json();

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      throw new Error("Failed to get file info from Telegram");
    }

    const telegramFilePath: string = fileInfo.result.file_path;

    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${telegramFilePath}`
    );
    
    if (!fileResponse.ok) {
      throw new Error("Failed to download file from Telegram");
    }

    const fileBuffer = await fileResponse.arrayBuffer();

    const fileExt = originalFilename.split('.').pop() || 'bin';
    const storagePath = `${profile.id}/${crypto.randomUUID()}.${fileExt}`;

    const { error: uploadError } = await supabase.storage
      .from("telegram-uploads")
      .upload(storagePath, fileBuffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const telegramUploadsTable = supabase.from("telegram_uploads") as TelegramUploadsTable;
    const { error: dbError } = await telegramUploadsTable.insert({
        user_id: profile.id,
        telegram_chat_id: chatId.toString(),
        filename: `${crypto.randomUUID()}.${fileExt}`,
        original_filename: originalFilename,
        storage_path: storagePath,
        file_type: mimeType,
        file_size: fileSize,
        caption: caption,
      });

    if (dbError) {
      await supabase.storage.from("telegram-uploads").remove([storagePath]);
      throw dbError;
    }

    await sendTelegramMessage(botToken, chatId, 
      `✅ <b>Файл загружен</b>\n\n📄 ${originalFilename}\n${caption ? `📝 ${caption}` : ""}\n\nФайл доступен в вашем личном кабинете.`
    );

  } catch (error) {
    console.error("File upload error:", error);
    await sendTelegramMessage(botToken, chatId, 
      "❌ Ошибка при загрузке файла. Попробуйте позже."
    );
  }
}

async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}
