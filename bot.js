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
]);

bot.telegram.setMyCommands(
  [
    { command: "vote", description: "Посмотреть какие фильмы на этот вечер" },
    { command: "calculate", description: "Подвести итоги голосования" },
    { command: "addpack", description: "Добавить пачку" },
    { command: "addmovie", description: "добавить фильм в пачку" },
    { command: "movie_delete", description: "Удалить фильм из пачки" },
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
  console.log("Калькуляция запущена пользователем:", ctx.from.username);
  if (!(await isAdmin(ctx.from.id))) {
    console.log("Пользователь не админ:", ctx.from.id);
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  try {
    // Получаем последнюю пачку
    const packRes = await query(
      "SELECT id FROM movie_packs ORDER BY id DESC LIMIT 1",
    );
    if (!packRes.rowCount)
      return ctx.reply("❌ Нет ни одной добавленной пачки.");

    const packId = packRes.rows[0].id;

    // Получаем всех голосующих для этой пачки с их голосами
    const votesRes = await query(
      `
      SELECT u.telegram_id, u.username, m.title, v.score
      FROM votes v
      JOIN users_filmsBot u ON v.user_id = u.id
      JOIN movies m ON v.movie_id = m.id
      WHERE v.pack_id = $1
    `,
      [packId],
    );

    if (!votesRes.rowCount) return ctx.reply("❌ Нет голосов для расчёта.");

    // Формируем структуру вида:
    // { username_or_id: { movieTitle: score, ... }, ... }
    const votes = {};

    votesRes.rows.forEach((row) => {
      const voter = row.username || row.telegram_id.toString();
      if (!votes[voter]) votes[voter] = {};
      votes[voter][row.title] = row.score;
    });

    // Рассчёт по твоей формуле
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

    // Сортируем итоговые баллы
    const sortedTotals = Object.entries(totals).sort((a, b) => b[1] - a[1]);

    // Формируем сообщения
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

    // Отправляем результаты всем участникам голосования
    const telegramIds = [...new Set(votesRes.rows.map((r) => r.telegram_id))];

    for (const id of telegramIds) {
      await ctx.telegram.sendMessage(id, resultMessage); // общий рейтинг
      await ctx.telegram.sendMessage(id, contributionMessage); // вклад только этого пользователя
    }

    ctx.reply("✅ Результаты отправлены всем участникам.");
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при расчёте результатов.");
  }
});

bot.command("movie_delete", async (ctx) => {
  console.log("Удаление фильма запущена пользователем:", ctx.from.username);
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ У вас нет доступа к этой команде.");

  const text = ctx.message.text;
  const args = text.split(" ").slice(1);
  if (args.length === 0)
    return ctx.reply("⚠️ Формат: /movie_delete <название_фильма>");

  const movieName = args.join(" ");

  try {
    const packRes = await query(
      "SELECT id FROM movie_packs ORDER BY id DESC LIMIT 1",
    );
    if (!packRes.rowCount)
      return ctx.reply("❌ Нет ни одной добавленной пачки.");

    const packId = packRes.rows[0].id;

    // Найдём фильм в последней пачке (регистронезависимо)
    const movieRes = await query(
      `SELECT id FROM movies WHERE pack_id = $1 AND LOWER(title) = LOWER($2)`,
      [packId, movieName],
    );

    if (!movieRes.rowCount)
      return ctx.reply(`❌ Фильм "${movieName}" не найден в последней пачке.`);

    const movieId = movieRes.rows[0].id;

    // Удаляем голоса за этот фильм
    await query("DELETE FROM votes WHERE movie_id = $1", [movieId]);

    // Удаляем фильм
    await query("DELETE FROM movies WHERE id = $1", [movieId]);

    ctx.reply(`✅ Фильм "${movieName}" и все его голоса удалены.`);
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при удалении фильма.");
  }
});

bot.command("addmovie", async (ctx) => {
  console.log("Добавить фильм запущена пользователем:", ctx.from.username);
  if (!(await isAdmin(ctx.from.id)))
    return ctx.reply("❌ Только админ может добавлять фильмы.");

  const input = ctx.message.text;
  const match = input.match(/\/addmovie\s+"(.+?)"\s+(.+)/);

  if (!match) {
    return ctx.reply(
      '⚠️ Формат: /addmovie "название пачки" название_фильма\nПример: /addmovie "Вечер 08.06" Терминатор',
    );
  }

  const packName = match[1];
  const movieTitle = match[2];

  try {
    const packRes = await query(
      `SELECT id FROM movie_packs WHERE LOWER(name) = LOWER($1)`,
      [packName.toLowerCase()],
    );

    if (!packRes.rowCount)
      return ctx.reply(`❌ Пачка с названием "${packName}" не найдена.`);

    const packId = packRes.rows[0].id;

    await query(`INSERT INTO movies (pack_id, title) VALUES ($1, $2)`, [
      packId,
      movieTitle,
    ]);

    ctx.reply(`✅ Фильм "${movieTitle}" добавлен в пачку "${packName}"!`);
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при добавлении фильма.");
  }
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

    let msg = `🎬 Голосование за фильмы в пачке "${pack.name}":\n\nВыбери фильм, затем введи оценку (от 0 до 10):`;

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

  ctx.reply(`Введите оценку фильму "${title}" от 0 до 10:`);
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const voteData = userVoteState.get(userId);

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
      return ctx.reply(
        "❌ Ты не зарегистрирован, отправь /start для регистрации.",
      );
    const userDbId = userRes.rows[0].id;

    // Проверка на повтор оценки
    const duplicateRes = await query(
      "SELECT id FROM votes WHERE user_id = $1 AND pack_id = $2 AND score = $3",
      [userDbId, voteData.packId, score],
    );
    if (duplicateRes.rowCount) {
      return ctx.reply(`❌ Ты уже использовал оценку ${score} в этой пачке.`);
    }

    // Проверка на существующий голос
    const voteRes = await query(
      "SELECT id FROM votes WHERE user_id = $1 AND movie_id = $2 AND pack_id = $3",
      [userDbId, voteData.movieId, voteData.packId],
    );

    if (voteRes.rowCount) {
      await query("UPDATE votes SET score = $1 WHERE id = $2", [
        score,
        voteRes.rows[0].id,
      ]);
      ctx.reply(
        `🔄 Обновлена оценка фильма "${voteData.movieTitle}" на ${score}.`,
      );
    } else {
      await query(
        "INSERT INTO votes (user_id, movie_id, pack_id, score) VALUES ($1, $2, $3, $4)",
        [userDbId, voteData.movieId, voteData.packId, score],
      );
      ctx.reply(
        `✅ Оценка ${score} для фильма "${voteData.movieTitle}" сохранена.`,
      );
    }

    userVoteState.delete(userId); // очищаем после голосования
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при сохранении оценки.");
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

bot.launch();
console.log("Bot started");
