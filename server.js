const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Простая страница
app.get('/', (req, res) => {
  const time = new Date().toISOString();
  console.log(`[${time}] Пинг от ${req.ip}`);
  res.send('🤖 Бот работает. Время: ' + new Date().toISOString());
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на http://localhost:${PORT}`);

  // Начинаем самопинг
  setInterval(async () => {
    try {
      const url = `http://localhost:${PORT}/`;
      console.log('🔁 Пинг:', url);
      await axios.get(url);
    } catch (err) {
      console.error('❌ Ошибка пинга:', err.message);
    }
  }, 4 * 60 * 1000); // каждые 4 минуты
});
