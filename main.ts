
const API = "https://discord.com/api/v10";

const getEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const APP_ID = getEnv("DISCORD_APPLICATION_ID");
const BOT_TOKEN = getEnv("DISCORD_BOT_TOKEN");
const PUBLIC_KEY = getEnv("DISCORD_PUBLIC_KEY");
const GUILD_ID = getEnv("DISCORD_GUILD_ID");
const TARGET_CHANNEL_ID = getEnv("TARGET_CHANNEL_ID");

const headers = {
  "Authorization": `Bot ${BOT_TOKEN}`,
  "Content-Type": "application/json"
};

// Register the /application command in your server.
async function registerCommand() {
  const command = {
    name: "application",
    description: "Отправить заявку",
    options: [
      {
        type: 3,
        name: "nickname",
        description: "Никнейм | Имя Фамилия",
        required: true,
        max_length: 100
      },
      {
        type: 3,
        name: "category",
        description: "Выберите категорию",
        required: true,
        choices: [
          { name: "Фостер", value: "Фостер" },
          { name: "Соратники", value: "Соратники" }
        ]
      },
      {
        type: 11,
        name: "image",
        description: "Прикрепите изображение",
        required: true
      }
    ]
  };

  const response = await fetch(
    `${API}/applications/${APP_ID}/guilds/${GUILD_ID}/commands`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify([command])
    }
  );

  if (!response.ok) {
    throw new Error(`Command registration failed: ${await response.text()}`);
  }

  console.log("Application command registered!");
}

// Verify that requests really come from Discord.
async function verifyRequest(
  request: Request,
  body: string
): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");

  if (!signature || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal value");
  }

  return new Uint8Array(
    hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16))
  );
}

function safeText(value: string): string {
  return value
    .replaceAll("@", "@\u200b")
    .replace(/[\\*_`~|]/g, "\\$&");
}

async function editOriginal(
  token: string,
  content: string
) {
  return await fetch(
    `${API}/webhooks/${APP_ID}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    }
  );
}

async function handleApplication(interaction: any) {
  const options = interaction.data.options ?? [];

  const nickname = options.find(
    (option: any) => option.name === "nickname"
  )?.value;

  const category = options.find(
    (option: any) => option.name === "category"
  )?.value;

  const imageId = options.find(
    (option: any) => option.name === "image"
  )?.value;

  const attachment =
    interaction.data.resolved?.attachments?.[imageId];

  const userId =
    interaction.member?.user?.id ?? interaction.user?.id;

  // Restrict command usage to the selected channel.
  if (interaction.channel_id !== TARGET_CHANNEL_ID) {
    return {
      type: 4,
      data: {
        content: "Используйте эту команду в предназначенном канале.",
        flags: 64
      }
    };
  }

  if (!nickname || !category || !attachment) {
    return {
      type: 4,
      data: {
        content: "Не удалось получить все поля заявки.",
        flags: 64
      }
    };
  }

  if (
    !attachment.content_type?.startsWith("image/")
  ) {
    return {
      type: 4,
      data: {
        content: "Пожалуйста, прикрепите изображение.",
        flags: 64
      }
    };
  }

  // Defer the response so Discord does not time out.
  const deferred = await fetch(
    `${API}/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 5,
        data: { flags: 64 }
      })
    }
  );

  if (!deferred.ok) {
    throw new Error("Could not acknowledge interaction");
  }

  try {
    const message = {
      content: `**Новая заявка**\nОтправитель: <@${userId}>`,
      embeds: [
        {
          title: "Заявка",
          color: 5793266,
          fields: [
            {
              name: "Никнейм | Имя Фамилия",
              value: safeText(nickname)
            },
            {
              name: "Категория",
              value: category
            }
          ],
          image: {
            url: attachment.url
          }
        }
      ],
      allowed_mentions: {
        users: [userId]
      }
    };

    const response = await fetch(
      `${API}/channels/${TARGET_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(message)
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    await editOriginal(
      interaction.token,
      "Ваша заявка успешно отправлена!"
    );
  } catch (error) {
    console.error(error);

    await editOriginal(
      interaction.token,
      "Не удалось отправить заявку. Попробуйте позже."
    );
  }

  return null;
}

// Start the server.
await registerCommand();

Deno.serve(async (request: Request) => {
  if (request.method === "GET") {
    return new Response("Discord application bot is running!");
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await request.text();

  if (!(await verifyRequest(request, body))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const interaction = JSON.parse(body);

  // Discord endpoint verification.
  if (interaction.type === 1) {
    return Response.json({ type: 1 });
  }

  if (
    interaction.type === 2 &&
    interaction.data?.name === "application"
  ) {
    try {
      const result = await handleApplication(interaction);

      if (result) {
        return Response.json(result);
      }

      return new Response(null, { status: 204 });
    } catch (error) {
      console.error(error);
      return Response.json({
        type: 4,
        data: {
          content: "Произошла ошибка при обработке заявки.",
          flags: 64
        }
      });
    }
  }

  return Response.json({
    type: 4,
    data: { content: "Неизвестная команда.", flags: 64 }
  });
});
