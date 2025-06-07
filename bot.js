require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const bot = new Telegraf(process.env.BOT_TOKEN);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function notifyRestart() {
  const changelog = `
  🚀 *Бот перезапущен и снова в строю!*
    Версия все также 0.5

    Я просто пофиксил всякое говно
    `.trim();

  try {
    const res = await query("SELECT chat_id FROM bot_groups");
    if (!res.rowCount) {
      console.log("Нет групп в базе для уведомления.");
      return;
    }

    for (const { chat_id } of res.rows) {
      try {
        await bot.telegram.sendMessage(chat_id, changelog, { parse_mode: "Markdown" });
        console.log(`Уведомление отправлено в чат ${chat_id}`);
      } catch (err) {
        console.error(`❌ Не удалось отправить в ${chat_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Ошибка при получении чатов из базы:", err.message);
  }
}


const adminAddMovieState = new Map();

async function isAdmin(telegram_id) {
  const res = await query(
    "SELECT role FROM users_filmsBot WHERE telegram_id=$1",
    [telegram_id],
  );
  return res.rowCount && res.rows[0].role === "admin";
}

// Команда /start — регистрация пользователя
bot.start(async (ctx) => {
  const telegram_id = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || "User";

  await query(
    `
    INSERT INTO users_filmsBot (telegram_id, username, role)
    VALUES ($1, $2, 'member')
    ON CONFLICT (telegram_id) DO NOTHING
  `,
    [telegram_id, username],
  );

  ctx.reply(`Привет, ${username}! Добро пожаловать в кино-бот.`);
});

bot.telegram.setMyCommands([
  { command: "start", description: "Начать работу с ботом" },
  { command: "vote", description: "Посмотреть какие фильмы на этот вечер" },
  { command: "my_stats", description: "Посмотреть все свои оценки на последней пачке" },
]);

bot.telegram.setMyCommands(
  [
    { command: "vote", description: "Посмотреть какие фильмы на этот вечер" },
    { command: "my_stats", description: "Посмотреть все свои оценки на последней пачке" },
    { command: "stat_vote", description: "Посмотреть все оценки" },
    { command: "calculate", description: "Подвести итоги голосования" },
    { command: "addpack", description: "Добавить пачку" },
    { command: "delpack", description: "Удалить пачку" },
    { command: "addmovie", description: "добавить фильм в пачку" },
    { command: "movie_delete", description: "Удалить фильм из пачки" },
    { command: "notify", description: "Отправить уведомление" },
    { command: "listpacks", description: "Отправить уведомление" },
  ],
  {
    scope: { type: "chat", chat_id: 930852883 },
  },
);

bot.command("PING", async (ctx) =>{
  return ctx.reply("PONG")
})

bot.command("addpack", async (ctx) => {
  console.log("Добавление пака запущена пользователем:", ctx.from.username);
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ Только админ может добавлять пачки фильмов.");

  const args = ctx.message.text.split(" ").slice(1);
  const packName = args.join(" ").trim();

  if (!packName)
    return ctx.reply(
      "⚠️ Укажи название пачки фильмов.\nПример: /addpack Комедии марта",
    );

  try {
    await query(`INSERT INTO movie_packs (name) VALUES ($1)`, [packName]);
    ctx.reply(`✅ Пачка фильмов "${packName}" добавлена!`);
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при добавлении пачки.");
  }
});

bot.command("calculate", async (ctx) => {
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ У вас нет доступа к этой команде.");

  try {
    const packsRes = await query(
      `SELECT id, name FROM movie_packs ORDER BY id DESC LIMIT 10`
    );

    if (!packsRes.rowCount)
      return ctx.reply("❌ Нет доступных пачек.");

    const buttons = packsRes.rows.map((pack) => [
      Markup.button.callback(pack.name, `calculate_pack_${pack.id}`)
    ]);

    await ctx.reply(
      "📦 Выберите пачку для расчёта итогов голосования:",
      Markup.inlineKeyboard(buttons)
    );
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при получении списка пачек.");
  }
});

bot.action(/^calculate_pack_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery(); // убрать "часики"
  const packId = ctx.match[1];

  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ У вас нет доступа к этой команде.");

  try {
    const votesRes = await query(
      `
      SELECT u.telegram_id, u.username, m.title, v.score
      FROM votes v
      JOIN users_filmsBot u ON v.user_id = u.id
      JOIN movies m ON v.movie_id = m.id
      WHERE v.pack_id = $1
    `,
      [packId]
    );

    if (!votesRes.rowCount)
      return ctx.reply("❌ Нет голосов для этой пачки.");

    const votes = {};
    votesRes.rows.forEach((row) => {
      const voter = row.username || row.telegram_id.toString();
      if (!votes[voter]) votes[voter] = {};
      votes[voter][row.title] = row.score;
    });

    const totals = {};
    const contributions = {};

    for (const [voter, ratings] of Object.entries(votes)) {
      const numVotes = Object.keys(ratings).length;
      const divisor = Math.log2(numVotes + 1);
      contributions[voter] = {};

      for (const [movie, score] of Object.entries(ratings)) {
        const weighted = score / divisor;
        if (!totals[movie]) totals[movie] = 0;
        totals[movie] += weighted;
        contributions[voter][movie] = weighted;
      }
    }

    const sortedTotals = Object.entries(totals).sort((a, b) => b[1] - a[1]);

    let resultMessage = "🏆 Итоги голосования:\n";
    sortedTotals.forEach(([movie, score]) => {
      resultMessage += `${movie}: ${score.toFixed(2)} баллов\n`;
    });

    let contributionMessage = "\n📊 Вклад каждого голосующего:\n";
    for (const [voter, movieScores] of Object.entries(contributions)) {
      contributionMessage += `\n👤 ${voter}:\n`;
      for (const [movie, val] of Object.entries(movieScores)) {
        contributionMessage += `  → ${movie}: ${val.toFixed(2)} баллов\n`;
      }
    }

    // Получаем список всех групп из базы
    const groupsRes = await query(`SELECT chat_id FROM bot_groups`);
    if (!groupsRes.rowCount) return ctx.reply("❌ Нет зарегистрированных групп.");

    for (const row of groupsRes.rows) {
      const groupId = row.chat_id;
      try {
        await ctx.telegram.sendMessage(groupId, resultMessage);
        await ctx.telegram.sendMessage(groupId, contributionMessage);
      } catch (e) {
        console.warn(`Не удалось отправить сообщение в группу ${groupId}:`, e.message);
      }
    }

    ctx.reply("✅ Результаты отправлены во все группы.");
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при расчёте результатов.");
  }
});

bot.command("stat_vote", async (ctx) => {
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ Только админ может просматривать статистику.");

  const packsRes = await query("SELECT id, name FROM movie_packs ORDER BY id DESC");
  if (!packsRes.rowCount)
    return ctx.reply("❌ Нет доступных пачек.");

  const buttons = packsRes.rows.map(p =>
    [Markup.button.callback(p.name, `stat_vote_pack_${p.id}`)]
  );

  await ctx.reply("📊 Выберите пачку:", Markup.inlineKeyboard(buttons));
});

bot.action(/^stat_vote_pack_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ Только админ может это делать.");

  const packId = ctx.match[1];
  const res = await query(`
    SELECT m.title, u.username, v.score
    FROM votes v
    JOIN movies m ON v.movie_id = m.id
    JOIN users_filmsBot u ON v.user_id = u.id
    WHERE v.pack_id = $1
    ORDER BY m.title, u.username
  `, [packId]);

  if (!res.rowCount)
    return ctx.reply("❌ В этой пачке ещё нет голосов.");

  const grouped = {};
  for (const { title, username, score } of res.rows) {
    if (!grouped[title]) grouped[title] = [];
    grouped[title].push(`${username}: ${score}`);
  }

  let msg = "📊 Статистика по оценкам:\n";
  for (const [title, votes] of Object.entries(grouped)) {
    msg += `\n🎬 *${title}*\n` + votes.map(v => ` • ${v}`).join("\n") + "\n";
  }

  ctx.replyWithMarkdown(msg);
});

bot.command("my_stats", async (ctx) => {
  const telegramId = ctx.from.id;
  const userRes = await query(
    "SELECT id FROM users_filmsBot WHERE telegram_id = $1",
    [telegramId]
  );
  if (!userRes.rowCount)
    return ctx.reply("❌ Ты не зарегистрирован. Отправь /start.");

  const userId = userRes.rows[0].id;

  const packRes = await query(
    "SELECT id, name FROM movie_packs ORDER BY id DESC LIMIT 1"
  );
  if (!packRes.rowCount)
    return ctx.reply("❌ Ещё не создано ни одной пачки.");

  const { id: packId, name: packName } = packRes.rows[0];

  const votesRes = await query(
    `SELECT m.title, v.score
     FROM votes v
     JOIN movies m ON v.movie_id = m.id
     WHERE v.user_id = $1 AND v.pack_id = $2
     ORDER BY m.title`,
    [userId, packId]
  );

  if (!votesRes.rowCount)
    return ctx.reply(`ℹ️ Ты ещё не голосовал в пачке "${packName}".`);

  let msg = `📋 Твои оценки в последней пачке "${packName}":\n\n`;
  for (const { title, score } of votesRes.rows) {
    msg += `• ${title}: ${score}\n`;
  }

  ctx.reply(msg);
});

bot.command("registerGroup", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private")
    return ctx.reply("❌ Эту команду нужно вызывать в группе.");

  const chatId = ctx.chat.id;
  // Добавить в БД, если нет
  await query(`INSERT INTO bot_groups(chat_id) VALUES ($1) ON CONFLICT DO NOTHING`, [chatId]);

  ctx.reply("✅ Группа успешно зарегистрирована для получения результатов.");
});


bot.command("movie_delete", async (ctx) => {
  console.log("Удаление фильма запущено пользователем:", ctx.from.username);
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ У вас нет доступа к этой команде.");

  try {
    const res = await query("SELECT id, name FROM movie_packs ORDER BY id DESC");

    if (res.rowCount === 0)
      return ctx.reply("❌ Нет ни одной пачки фильмов.");

    const buttons = res.rows.map((pack) => [
      Markup.button.callback(pack.name, `deletepack_${pack.id}`)
    ]);

    ctx.reply("🎬 Выберите пачку, из которой хотите удалить фильм:", Markup.inlineKeyboard(buttons));
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при загрузке пачек.");
  }
});

bot.action(/deletepack_(\d+)/, async (ctx) => {
  const packId = ctx.match[1];

  try {
    const res = await query(
      "SELECT id, title FROM movies WHERE pack_id = $1 ORDER BY id",
      [packId]
    );

    if (res.rowCount === 0)
      return ctx.editMessageText("❌ В этой пачке нет фильмов.");

    const buttons = res.rows.map((movie) => [
      Markup.button.callback(movie.title, `deletemovie_${movie.id}`)
    ]);

    ctx.editMessageText("🎞 Выберите фильм для удаления:", Markup.inlineKeyboard(buttons));
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при загрузке фильмов.");
  }
});

bot.action(/deletemovie_(\d+)/, async (ctx) => {
  const movieId = ctx.match[1];

  try {
    const movieRes = await query(
      "SELECT title FROM movies WHERE id = $1",
      [movieId]
    );

    if (!movieRes.rowCount)
      return ctx.answerCbQuery("❌ Фильм уже удалён.");

    const title = movieRes.rows[0].title;

    await query("DELETE FROM votes WHERE movie_id = $1", [movieId]);
    await query("DELETE FROM movies WHERE id = $1", [movieId]);

    await ctx.editMessageText(`✅ Фильм "${title}" и его голоса удалены.`);
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при удалении фильма.");
  }
});


bot.command("notify", async (ctx) => {
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ У вас нет доступа к этой команде.");

  try {
    const res = await query("SELECT telegram_id FROM users_filmsBot");

    if (!res.rowCount)
      return ctx.reply("❌ Нет пользователей для уведомления.");

    const message = "🎬 Добавлен новый пак фильмов, проголосуй, пж";

    for (const row of res.rows) {
      try {
        await ctx.telegram.sendMessage(row.telegram_id, message);
      } catch (e) {
        console.warn(`Не удалось отправить сообщение пользователю ${row.telegram_id}`);
      }
    }

    ctx.reply("✅ Уведомление отправлено всем пользователям.");
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при отправке уведомлений.");
  }
});

bot.command("delpack", async (ctx) => {
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ У вас нет доступа к этой команде.");

  try {
    const res = await query("SELECT id, name FROM movie_packs ORDER BY id");

    if (res.rowCount === 0)
      return ctx.reply("❌ Нет доступных паков для удаления.");

    const buttons = res.rows.map((pack) => [
      Markup.button.callback(pack.name, `delpack_${pack.id}`)
    ]);

    ctx.reply("🗑 Выберите пак для удаления:", Markup.inlineKeyboard(buttons));
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при получении паков.");
  }
});

bot.action(/delpack_(\d+)/, async (ctx) => {
  if (!(await isAdmin(ctx.from.id)))
    return ctx.answerCbQuery("❌ У вас нет доступа.");

  const packId = ctx.match[1];

  try {
    // Удаляем фильмы из этого пака
    await query("DELETE FROM movies WHERE pack_id = $1", [packId]);

    // Удаляем сам пак
    await query("DELETE FROM movie_packs WHERE id = $1", [packId]);

    await ctx.editMessageText("✅ Пак и его фильмы удалены.");
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при удалении пака.");
  }
});

bot.command("addmovie", async (ctx) => {
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ Только админ может добавлять фильмы.");

  try {
    const packsRes = await query(
      `SELECT id, name FROM movie_packs ORDER BY id DESC LIMIT 10`
    );

    if (!packsRes.rowCount)
      return ctx.reply("❌ Нет доступных пачек для добавления фильма.");

    const buttons = packsRes.rows.map((pack) => [
      Markup.button.callback(pack.name, `addmovie_pack_${pack.id}`),
    ]);

    await ctx.reply(
      "🎞 Выбери пачку, в которую хочешь добавить фильм:",
      Markup.inlineKeyboard(buttons)
    );
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при получении списка пачек.");
  }
});

bot.action(/^addmovie_pack_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery(); // Убираем "часики"
  const packId = ctx.match[1];
  const telegramId = ctx.from.id;

  // Проверка, что админ
  if (!(await isAdmin(telegramId)))
    return ctx.reply("❌ Только админ может добавлять фильмы.");

  const packRes = await query(
    `SELECT name FROM movie_packs WHERE id = $1`,
    [packId]
  );

  if (!packRes.rowCount)
    return ctx.reply("❌ Пачка не найдена.");

  const packName = packRes.rows[0].name;

  adminAddMovieState.set(telegramId, { packId, packName });

  ctx.reply(
    `✏️ Введите название фильма, который хотите добавить в пачку "${packName}":`
  );
});


bot.command("listpacks", async (ctx) => {
  console.log("Показ паков запущена пользователем:", ctx.from.username);
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ Только админ может просматривать пачки.");

  try {
    const res = await query(`SELECT id, name FROM movie_packs ORDER BY id`);
    if (!res.rowCount) return ctx.reply("Пачек фильмов пока нет.");

    let msg = "📦 Пачки фильмов:\n";
    for (const row of res.rows) {
      msg += `#${row.id}: ${row.name}\n`;
    }
    ctx.reply(msg);
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при получении списка пачек.");
  }
});

bot.command("vote", async (ctx) => {
  const userId = ctx.from.id;
  console.log("Голосование запущена пользователем:", ctx.from.username);
  try {
    const packRes = await query(
      "SELECT id, name FROM movie_packs ORDER BY id DESC LIMIT 1",
    );
    if (!packRes.rowCount)
      return ctx.reply("❌ Нет ни одной добавленной пачки.");

    const pack = packRes.rows[0];

    const moviesRes = await query(
      "SELECT id, title FROM movies WHERE pack_id = $1 ORDER BY id",
      [pack.id],
    );
    if (!moviesRes.rowCount)
      return ctx.reply("В последней пачке пока нет фильмов.");

    let msg = `🎬 Голосование за фильмы в пачке "${pack.name}":\n\nВыбери фильм, затем введи оценку (от 1 до 10):`;

    const buttons = moviesRes.rows.map((movie) => [
      Markup.button.callback(movie.title, `vote_film_${movie.id}`),
    ]);

    await ctx.reply(msg, Markup.inlineKeyboard(buttons));
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при получении данных для голосования.");
  }
});

const userVoteState = new Map(); // Временное хранилище выбора фильма пользователем

bot.action(/^vote_film_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery(); // убрать "часики"
  const movieId = ctx.match[1];
  const userId = ctx.from.id;

  // Проверим, существует ли фильм
  const movieRes = await query(
    "SELECT title, pack_id FROM movies WHERE id = $1",
    [movieId],
  );
  if (!movieRes.rowCount) return ctx.reply("❌ Фильм не найден.");

  const { title, pack_id } = movieRes.rows[0];

  // Запоминаем, что пользователь выбрал этот фильм
  userVoteState.set(userId, { movieId, movieTitle: title, packId: pack_id });

  ctx.reply(`Введите оценку фильму "${title}" от 0 до 10, где 0 - отмена оценки (если она уже была дана):`);
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const voteData = userVoteState.get(userId);

   // === Обработка добавления фильма (админ) ===
  const adminState = adminAddMovieState.get(userId);
  if (adminState) {
    const movieTitle = ctx.message.text.trim();
    if (!movieTitle)
      return ctx.reply("⚠️ Введите непустое название фильма.");

    try {
      await query(
        "INSERT INTO movies (pack_id, title) VALUES ($1, $2)",
        [adminState.packId, movieTitle]
      );
      ctx.reply(
        `✅ Фильм "${movieTitle}" добавлен в пачку "${adminState.packName}".`
      );
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка при добавлении фильма.");
    } finally {
      adminAddMovieState.delete(userId);
    }
    return;
  }

  // === Обработка голосования (пользователь) ===
  if (!voteData) return; // Пользователь не выбирал фильм через кнопку

  const score = Number(ctx.message.text);
  if (isNaN(score) || score < 0 || score > 10) {
    return ctx.reply("⚠️ Введите корректную оценку от 0 до 10.");
  }

  try {
    const userRes = await query(
      "SELECT id FROM users_filmsBot WHERE telegram_id = $1",
      [userId],
    );
    if (!userRes.rowCount)
      return ctx.reply("❌ Ты не зарегистрирован, отправь /start для регистрации.");

    const userDbId = userRes.rows[0].id;

    const voteRes = await query(
      "SELECT id FROM votes WHERE user_id = $1 AND movie_id = $2 AND pack_id = $3",
      [userDbId, voteData.movieId, voteData.packId],
    );

    if (score === 0) {
      // Если уже есть оценка — удаляем
      if (voteRes.rowCount) {
        await query("DELETE FROM votes WHERE id = $1", [voteRes.rows[0].id]);
        ctx.reply(`🗑️ Оценка для фильма "${voteData.movieTitle}" удалена.`);
      } else {
        ctx.reply("ℹ️ Ты ещё не ставил оценку этому фильму.");
      }
    } else {
      // Проверка на повторную оценку
      const duplicateRes = await query(
        "SELECT id FROM votes WHERE user_id = $1 AND pack_id = $2 AND score = $3 AND movie_id != $4",
        [userDbId, voteData.packId, score, voteData.movieId],
      );
      if (duplicateRes.rowCount) {
        return ctx.reply(`❌ Ты уже использовал оценку ${score} в этой пачке.`);
      }

      if (voteRes.rowCount) {
        await query("UPDATE votes SET score = $1 WHERE id = $2", [
          score,
          voteRes.rows[0].id,
        ]);
        ctx.reply(`🔄 Обновлена оценка фильма "${voteData.movieTitle}" на ${score}.`);
      } else {
        await query(
          "INSERT INTO votes (user_id, movie_id, pack_id, score) VALUES ($1, $2, $3, $4)",
          [userDbId, voteData.movieId, voteData.packId, score],
        );
        ctx.reply(`✅ Оценка ${score} для фильма "${voteData.movieTitle}" сохранена.`);
      }
    }

    userVoteState.delete(userId); // очищаем после обработки
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при обработке оценки.");
  }
});

bot.command("vote_set", async (ctx) => {
  console.log("Установка оценки запущена пользователем:", ctx.from.username);
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const args = text.split(" ").slice(1);

  if (args.length < 2)
    return ctx.reply(
      "⚠️ Формат: /vote_set <название_фильма> <оценка_от_0_до_10>",
    );

  // Последний аргумент - оценка, всё остальное - название фильма
  const scoreRaw = args[args.length - 1];
  const score = Number(scoreRaw);
  const movieName = args.slice(0, -1).join(" ");

  if (isNaN(score) || score < 0 || score > 10)
    return ctx.reply("⚠️ Оценка должна быть числом от 0 до 10.");

  try {
    // Получаем user_id из таблицы users_filmsBot
    const userRes = await query(
      "SELECT id FROM users_filmsBot WHERE telegram_id = $1",
      [userId],
    );
    if (!userRes.rowCount)
      return ctx.reply(
        "❌ Ты не зарегистрирован, отправь /start для регистрации.",
      );

    const userDbId = userRes.rows[0].id;

    // Получаем последнюю пачку
    const packRes = await query(
      "SELECT id FROM movie_packs ORDER BY id DESC LIMIT 1",
    );
    if (!packRes.rowCount)
      return ctx.reply("❌ Нет ни одной добавленной пачки.");

    const packId = packRes.rows[0].id;

    // Ищем фильм по названию в этой пачке (регистронезависимо)
    const movieRes = await query(
      `SELECT id, title FROM movies WHERE pack_id = $1 AND LOWER(title) = LOWER($2)`,
      [packId, movieName],
    );

    if (!movieRes.rowCount) {
      return ctx.reply(`❌ Фильм "${movieName}" не найден в последней пачке.`);
    }

    const movieId = movieRes.rows[0].id;

    // Проверяем, не использовал ли пользователь уже эту оценку в этой пачке
    const voteCheck = await query(
      "SELECT id FROM votes WHERE user_id = $1 AND pack_id = $2 AND score = $3",
      [userDbId, packId, score],
    );

    if (voteCheck.rowCount)
      return ctx.reply(`❌ Ты уже использовал оценку ${score} в этой пачке.`);

    // Сохраняем или обновляем голос за фильм
    const existingVote = await query(
      "SELECT id FROM votes WHERE user_id = $1 AND pack_id = $2 AND movie_id = $3",
      [userDbId, packId, movieId],
    );

    if (existingVote.rowCount) {
      // Обновляем голос
      await query("UPDATE votes SET score = $1 WHERE id = $2", [
        score,
        existingVote.rows[0].id,
      ]);
      ctx.reply(
        `✅ Обновлен твой голос за фильм "${movieRes.rows[0].title}" на оценку ${score}.`,
      );
    } else {
      // Вставляем новый голос
      await query(
        "INSERT INTO votes (user_id, movie_id, pack_id, score) VALUES ($1, $2, $3, $4)",
        [userDbId, movieId, packId, score],
      );
      ctx.reply(
        `✅ Твой голос за фильм "${movieRes.rows[0].title}" с оценкой ${score} сохранён.`,
      );
    }
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при сохранении голоса.");
  }
});


(async () => {
  await notifyRestart();
  bot.launch();
})();

